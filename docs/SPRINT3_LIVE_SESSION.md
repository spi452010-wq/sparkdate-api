# Sprint 3 design: Live session, matching, LiveKit (v0.1)

Server-authoritative. Clients never decide pairing or timing. Socket.IO namespace `/live`, auth = JWT in handshake `auth.token`.
Rooms: `event:{eventId}` (broadcast), `user:{userId}` (private).

## 1. Event timeline
published -> (startsAt-15m) lobby open -> (startsAt) live, round 1 -> ... -> maxRounds or endsAt -> ended -> finalize job.
Status flips via BullMQ jobs `event.open`, `event.start`, `event.end` with jobId = `{type}:{eventId}`.

## 2. Socket contract
Client -> server (all acked with `{ok, error?}`):
| event | payload | rules |
|---|---|---|
| `event:join` | `{eventId}` | needs confirmed booking; sets `bookings.attendedAt` (first time); adds to waiting set |
| `event:leave` | `{eventId}` | removes from queue; ends current date as early_disconnect |
| `date:leave` | `{dateId}` | ends only the current date early (outcome early_end); partner gets `partner:left`; caller stays in event and re-enters queue next round |
| `date:decision` | `{dateId, decision: "like"\|"pass"\|"save"}` | once per user per date, within 60 s after round end |
| `date:spark` | `{dateId}` | relayed to partner, rate limit 1/3 s |
| `presence:ping` | `{}` | every 10 s |

Server -> client:
| event | payload |
|---|---|
| `lobby:state` | `{eventId, round, status, waiting, nextRoundAt}` |
| `match:found` | `{dateId, round, partner:{id, fullName, age, city, bio, photoUrl, interests}, livekit:{url, room, token}, startsAt, endsAt}` |
| `round:started` | `{dateId, endsAt}` (server time; client computes countdown from endsAt minus serverTimeOffset) |
| `round:ended` | `{dateId, decisionDeadline}` |
| `partner:left` | `{dateId, reason: "disconnect"\|"left"}` |
| `connection:mutual` | `{connectionId, partner}` |
| `no:match` | `{round}` (sat out this round, odd gender counts) |
| `event:ended` | `{eventId, datesCompleted}` |
`GET /live/time` returns `{serverTime}` (epoch ms) for offset sync. Socket: API origin, default path `/socket.io`, namespace `/live`.

## 3. Matching (per round, job `round.tick:{eventId}:{n}`)
1. Take present users from Redis `live:{e}:waiting:male|female` (presence TTL 30 s).
2. Exclude pairs already met (Redis set `live:{e}:met`, mirrored by unique index on dates) and blocked pairs.
3. Score = shared interests + interestedCity match + profession overlap; greedy best-first pairing. O(n log n), fine for 150x150.
4. Unpaired users get `no:match` and priority next round.
5. Insert `dates` docs, create LiveKit tokens (room `evt_{e}_r{n}_{dateId}`, identity = userId, TTL = round + 60 s,
   grants: roomJoin only that room, canPublish, canSubscribe). Rooms auto-create on join, `emptyTimeout` 30 s.
6. Emit `match:found`, schedule `round.end` at endsAt.

## 4. Round end and decisions
`round.end` -> emit `round:ended` -> after decisionDeadline, job `round.decide` writes connections:
both like/save -> mutual connection + `connection:mutual` + notification; one-sided -> "They liked you".
Increment `bookings.datesCompleted` for dates with endReason completed (>= 60 s of call).
Next round starts after a 30 s break.

## 5. Disconnect handling
Socket disconnect -> 20 s grace (Redis key `live:{e}:grace:{u}`). Reconnect within grace -> resend current `match:found` with a fresh token.
Grace expires -> partner gets `partner:left`, date endReason early_disconnect, partner re-queued for the next round.
LiveKit webhook `participant_left` is a secondary signal only.

## 6. Refund eligibility (unblocks Sprint 2)
`event.finalize`: refundEligible = paid && attendedAt != null && datesCompleted == 0.

## 7. Scale and failure
300 users = 1 API process, 1 Redis. Socket.IO Redis adapter installed now so a 2nd process is possible later (sticky sessions in Nginx).
Redis restart mid-event: clients re-send `event:join` on reconnect; waiting sets rebuild; met-pairs rebuilt from `dates`.
LiveKit token mint failure: retry 2x, else both users get `no:match` for that round.

## 8. Observability
Metrics per event: present users, pairs per round, pairing ms, early_disconnect rate, mutual rate. Logs carry eventId, round, dateId.

## 9. Env
LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, ROUND_BREAK_SEC=30, DECISION_WINDOW_SEC=60, RECONNECT_GRACE_SEC=20.

## 10. QA focus
Simultaneous join/leave at round tick, odd counts, no re-pairing, reconnect within/after grace, decision after deadline rejected,
token cannot join another room, 300 simulated sockets load test.

## Requeue rule (2026-10-30)
Server auto-requeues: after a date ends for any reason (round end, pass, `date:leave`, partner left, decision timeout), the user stays in the event queue for the next round. Clients never re-send `event:join` except after a socket reconnect. `early_end` counts as attended.
