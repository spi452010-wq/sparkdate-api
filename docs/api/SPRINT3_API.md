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
| `date:decision` | `{dateId, decision: "like"\|"pass"\|"save"}` | allowed from match until `decisionDeadline`; once per user (`ALREADY_DECIDED`, `DECISION_CLOSED`, `DATE_NOT_FOUND`). |
| `date:spark` | `{dateId}` | relayed to partner as `date:spark {dateId}`; 1 per 3 s (`RATE_LIMITED`); `DATE_NOT_ACTIVE` after the call ends. |
| `presence:ping` | `{}` or `{eventId}` | send every 10 s; presence expires after `LIVE_PRESENCE_TTL_SEC`. |

Payloads are strict (unknown keys -> `VALIDATION_ERROR`). Per-socket limit: 30 messages / 10 s (`RATE_LIMITED`). Unexpected failures -> `INTERNAL`.

### Server -> client
| event | payload |
|---|---|
| `lobby:state` | `{eventId, round, status, waiting, nextRoundAt}` |
| `match:found` | `{dateId, round, partner:{id, fullName, age, city, photoUrl, interests}, livekit:{url, room, token}, startsAt, endsAt}` |
| `round:started` | `{dateId, endsAt}` |
| `round:ended` | `{dateId, decisionDeadline}` |
| `partner:left` | `{dateId, reason: "disconnect"\|"left"}` (`disconnect` only after the reconnect grace) |
| `connection:mutual` | `{connectionId, partner}` |
| `no:match` | `{round}` |
| `date:spark` | `{dateId}` |
| `event:ended` | `{eventId, datesCompleted}` |

All times are ISO server time. Clients sync via `GET /api/v1/live/time`.

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

## Owner setup
- LiveKit Cloud or self-hosted: key/secret + `wss://` URL; set room `emptyTimeout` ~30 s.
- Redis for multi-node (adapter, presence, jobs).
- Nginx: sticky sessions (`ip_hash` or cookie) and websocket upgrade headers (`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`), read timeout > 60 s.
