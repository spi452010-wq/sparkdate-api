# Sprint 3 API: live session, matching, LiveKit

Design: `docs/SPRINT3_LIVE_SESSION.md`. This file is the contract as built.

## Socket.IO namespace `/live`
Connect with `io(`${API}/live`, { auth: { token: <access JWT> } })`.
Handshake errors (`connect_error.message`): `UNAUTHORIZED` (no token), `TOKEN_INVALID`, `ACCOUNT_BLOCKED`.
With `REDIS_URL` set the server uses the Redis adapter, so several API nodes can share rooms (needs sticky sessions, see below).

### Client -> server (all acked `{ok: true, ...}` or `{ok: false, error: CODE}`)
| event | payload | notes |
|---|---|---|
| `event:join` | `{eventId}` | needs a confirmed booking (`NOT_BOOKED`); lobby must be open (`LOBBY_NOT_OPEN`, `EVENT_ENDED`, `EVENT_NOT_FOUND`). Sets `bookings.attendedAt` once. Max 3 events per socket (`TOO_MANY_EVENTS`). Ack includes current `lobby:state`. |
| `event:leave` | `{eventId}` | `NOT_JOINED` if this socket did not join. Ends a running date as `early_disconnect`, partner gets `partner:left {reason:"left"}`. |
| `date:leave` | `{dateId}` | ends only this date as `early_end` (`DATE_NOT_FOUND`, `DATE_NOT_ACTIVE` if already ended/over). Partner gets `partner:left {reason:"ended"}` and next-round priority; the caller stays in the event (keeps its existing priority, `attendedAt` unchanged) and is matched again next round. Do not send `event:leave`+`event:join` for this. |
| `date:decision` | `{dateId, decision: "like"\|"pass"\|"save"}` | allowed from match until `decisionDeadline`; once per user (`ALREADY_DECIDED`, `DECISION_CLOSED`, `DATE_NOT_FOUND`). |
| `date:spark` | `{dateId}` | relayed to partner as `date:spark {dateId}`; 1 per 3 s (`RATE_LIMITED`); `DATE_NOT_ACTIVE` after the call ends. |
| `presence:ping` | `{}` or `{eventId}` | send every 10 s; presence expires after `LIVE_PRESENCE_TTL_SEC`. |

Payloads are strict (unknown keys -> `VALIDATION_ERROR`). Per-socket limit: 30 messages / 10 s (`RATE_LIMITED`). Unexpected failures -> `INTERNAL`.

### Server -> client
| event | payload |
|---|---|
| `lobby:state` | `{eventId, round, status, waiting, nextRoundAt}` |
| `match:found` | `{dateId, round, partner:{id, fullName, age, city, photoUrl, interests, bio}, livekit:{url, room, token}, startsAt, endsAt}` |
| `round:started` | `{dateId, endsAt}` |
| `round:ended` | `{dateId, decisionDeadline}` |
| `partner:left` | `{dateId, reason: "disconnect"\|"left"\|"ended"}` (`ended` = partner used `date:leave`) (`disconnect` only after the reconnect grace) |
| `connection:mutual` | `{connectionId, partner}` |
| `no:match` | `{round}` |
| `date:spark` | `{dateId}` |
| `event:ended` | `{eventId, datesCompleted}` |

All times are ISO server time. Clients sync via `GET /api/v1/live/time` -> `{serverTime: <epoch ms>, iso}`.

### Requeue (automatic)
Being "in the queue" = being in the event's present set (`event:join`, kept alive by `presence:ping`). A date ending never removes anyone from it, so after **any** date end (normal round end, pass/like/decision-deadline expiry, `date:leave`, partner `partner:left`) the user is a candidate at the next `round.tick` with no new `event:join`. Users whose partner left early, or who sat out (`no:match`), are added to the priority set and paired first. Only `event:leave`, grace expiry after a disconnect, or presence TTL expiry (no pings) remove a user. `early_end` / `early_disconnect` dates count toward `datesCompleted` only if the call lasted at least the minimum; attendance (`attendedAt`) is set at join and is not affected.

### LiveKit
One room per date: `evt_{eventId}_r{round}_{dateId}`. Identity = userId. Grant: join/publish/subscribe/data for that room only; no create/list/admin/record. TTL = round end + 60 s. Mint is retried twice; if it still fails both users get `no:match` and the date is not created.

### Timeline jobs
`event.open` (lobby opens before `startsAt`), `event.start`, `round.tick` -> `round.end` -> `round.decide`, `live.grace`, `event.end` -> `event.finalize`. Scheduled on event create/update. Rounds stop when the next one would not finish before `endsAt`.

## REST
| method | path | auth | body / response |
|---|---|---|---|
| GET | `/api/v1/live/time` | none | `{serverTime: epochMs, iso}` (no-store) |
| POST | `/api/v1/blocks` | user | `{userId}` -> 200 JSON; `CANNOT_BLOCK_SELF` |
| DELETE | `/api/v1/blocks/:userId` | user | 200 JSON |
| GET | `/api/v1/connections` | user | list of mutual connections |

## Rules
- Matching: score = shared interests + interestedCity + profession; greedy best-first then augmenting-path fill to the maximum pair count; no repeat or blocked pairs; users who sat out get priority next round.
- Mutual like/save creates exactly one connection (unique `{userA,userB}`, atomic upsert).
- A date counts toward `datesCompleted` when the call lasted >= 60 s.
- Reconnect grace `RECONNECT_GRACE_SEC` (20 s).

## Env
`LIVEKIT_URL` (wss://), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (>= 32 chars): optional in dev (placeholder token), required and non-placeholder in production. `ROUND_BREAK_SEC=30`, `DECISION_WINDOW_SEC=60`, `RECONNECT_GRACE_SEC=20`, `LIVE_PRESENCE_TTL_SEC=30`, `REDIS_URL` (optional).

## Deviations from the design
- `profession` / `interestedCity` are not in the profile schema yet; they score 0 (city is used for display).
- Met pairs are read from Mongo (`live_dates`), not a Redis set.
- No LiveKit webhook; call length uses server round times and disconnects.
- No `maxRounds` field.
- Added blocks and connections endpoints (needed for matching and mutuals).
- Decisions accepted from match until the deadline, not only after round end.
- Empty-room cleanup relies on LiveKit server `emptyTimeout`.
- An open socket stays valid after its access token expires (checked at handshake only).

## Load test (opt-in, not in jest)
`LOAD_URL=... LOAD_EVENT_ID=... LOAD_TOKENS_FILE=tokens.txt LOAD_SOCKETS=300 npm run load:live`

### Seeding load data (`npm run seed:load`)
Creates one published event (starts in `SEED_START_IN_MIN`=5 min, runs `SEED_DURATION_MIN`=60 min, `SEED_ROUND_MIN`=3-min rounds) with 150 male + 150 female approved, profile-complete users, confirmed bookings, and 8 opposite-gender blocks. Writes 300 access JWTs (real signing from config, one per line, mode 600) to `./load-tokens.txt` (override `LOAD_TOKENS_FILE`; gitignored) and prints `LOAD_EVENT_ID=<id>`.
- Safety: refuses `NODE_ENV=production`; refuses any `MONGO_URI` host other than `localhost`/`127.0.0.1`/`mongodb-memory` unless `SEED_ALLOW_REMOTE=1` **and** the db name contains `test`. Never drops data; every inserted doc carries `seedTag` (`SEED_TAG`, default `load-seed`).
- `npm run seed:load -- --clean` deletes only docs with that `seedTag` (plus the seeded users' refresh tokens).
- Timeline jobs (lobby open/start/end) are scheduled through the events service; set `REDIS_URL` to the API's Redis so the running server executes them.
- Then: `LOAD_EVENT_ID=<id> LOAD_TOKENS_FILE=load-tokens.txt npm run load:live`.

## Owner setup
- LiveKit Cloud or self-hosted: key/secret + `wss://` URL; set room `emptyTimeout` ~30 s.
- Redis for multi-node (adapter, presence, jobs).
- Nginx: sticky sessions (`ip_hash` or cookie) and websocket upgrade headers (`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`), read timeout > 60 s.
