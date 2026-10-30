# SparkDate – Architecture (v0.1, draft)

Status legend: [APPROVED] decided by owner, [PROPOSED] awaiting owner approval.

## 1. Product scope (from Figma "dating mobile app")
Event-based online speed dating. Login (WhatsApp OTP / Google) -> complete profile -> selfie verification ->
browse/like/save events -> book (free or paid, e.g. Rs 199) -> live event: waiting room -> matched 3-min 1:1 video
rounds -> after each round like/save -> mutual = connection -> chat (needs Monthly Chat Pass) -> notifications.
Refund flow when user gets no match. Admin creates events with separate boys/girls capacity.

## 2. System boundaries
- apps/mobile   : Flutter (GetX for state, DI and routing [APPROVED 30 Oct], dio, livekit_client)
- apps/admin    : React + TS + Vite (TanStack Query), httpOnly cookie session
- services/api  : Node.js + TS + Express, ONE modular monolith [APPROVED: Node]
  modules: auth, users/profile, verification, events, bookings, payments, live (sessions/matching),
  connections, chat, subscriptions, notifications, admin, media
- External: MongoDB Atlas, Redis, LiveKit Cloud [APPROVED], Google Play Billing [APPROVED],
  WhatsApp OTP (Meta Cloud API [APPROVED]), media on VPS local disk [APPROVED], FCM push.
- Deployment: manual by owner from these folders [APPROVED]. No AWS for now [APPROVED]. No GitHub for now [APPROVED].

## 3. Key decisions & trade-offs
| # | Decision | Why | Trade-off |
|---|----------|-----|-----------|
| D1 | Modular monolith | 300 users/event fits one process; fastest to build | Must keep module boundaries clean to split later |
| D2 | MongoDB primary store | Team choice; flexible profiles | Booking capacity needs atomic conditional updates (no multi-doc txn for hot path) |
| D3 | Redis for live state | Waiting room, pairing, presence, timers, rate limits are ephemeral & hot | Extra component; state rebuilt from Mongo if Redis lost |
| D4 | BullMQ on Redis | Round timers, reminders, refund jobs, retries | Same Redis; acceptable at this scale |
| D5 | Socket.IO (+Redis adapter) | Round signalling, chat, presence | Sticky sessions needed when >1 instance |
| D6 | LiveKit, 1 room per pair per round | Owner choice; tokens scoped to pair & round | Cloud cost vs self-host ops (pending) |
| D7 | Media on VPS disk behind a StorageProvider interface (local now, S3/R2 later) | Owner choice, zero extra cost | Pins API to ONE server; disk must be backed up; swap provider before scaling out |
| D8 | JWT access (15 min) + rotating refresh (30 d, hashed in DB) | Stateless API, revocable sessions | Refresh reuse detection logic required |
| D9 | Selfie verification = manual admin review v1 | Simple, no ML vendor | Admin workload; automate later |

## 4. Capacity & scaling assumptions
- ~300 users per live event (e.g. 150 boys + 150 girls), ~150 parallel LiveKit rooms per round.
- Few concurrent events at launch. 1 API instance (2 for safety), 1 Redis, Atlas M10.
- Socket fan-out per event small; chat volume low. Revisit when >5 concurrent full events.

## 5. Auth & authorization
- Login: POST /auth/otp/request -> /auth/otp/verify (WhatsApp); POST /auth/google (ID token verified server-side, aud checked).
- Account linking: same verified phone or email -> same user (no duplicates).
- OTP: 6 digits, 5 min TTL, stored hashed in Redis; new OTP invalidates previous; resend after 30 s, max 5/hour per phone;
  5 wrong attempts -> 15 min lock on that PHONE only. Request/verify rate limits apply per phone AND per IP (IP lockout avoided: mobile carriers share IPs via CGNAT).
- Roles: user, host, admin. Middleware: authenticate -> requireRole -> resource ownership check (no IDOR: always filter by req.user.id).
- Admin web: same JWTs but delivered as httpOnly, Secure, SameSite=Strict cookies + CSRF token.
- Admin/host web login: email + password (argon2id), rate limit + 5-attempt lockout, first admin via seed script (no signup).
  Same users collection with roles.
- Admin viewing selfies: API returns 5-min signed URLs in the verification queue response; no cookie auth on /media.
- Gates: profile complete + selfie verified required to book; active booking required to join event; mutual connection + active Chat Pass required to chat.

## 6. Live event flow (server-authoritative)
1. Event status: draft -> published -> live -> ended (cancelled).
2. Join: socket `event:join` -> checks booking -> add to Redis waiting set by gender.
3. Round tick (BullMQ job): pair waiting users (opposite gender, interest/preference score, never re-pair same couple),
   create LiveKit room `evt_{eventId}_r{n}_{pairId}`, issue tokens with TTL = round length + 30 s, emit `match:found`.
4. Timer is server time: emit `round:started {endsAt}`; clients render countdown from endsAt.
5. `round:ended` -> both submit decision (like/pass/save) within 60 s -> mutual like creates Connection + notification.
6. Disconnect: 20 s grace for reconnect; else partner gets `partner:left`, returned to queue, round marked early_disconnect.
7. Users with zero completed dates at event end -> eligible for refund (auto-flag, user requests via app).

## 7. Payments [APPROVED: Google Play Billing]
- Paid event tickets = consumable in-app products, one SKU per price tier (e.g. `event_ticket_199`); event doc stores `playProductId`.
- Chat Pass = Play subscription (`chat_pass_monthly`).
- Flow: POST /bookings -> pending booking + 10 min seat hold -> app launches Play purchase with obfuscatedAccountId=userId,
  obfuscatedProfileId=bookingId -> app sends purchaseToken to POST /payments/play/verify -> server verifies via
  Google Play Developer API (purchases.products.get), checks product, account and booking ids, confirms booking,
  then acknowledges/consumes. Unverified or unacknowledged purchases are refunded by Google after 3 days.
- RTDN (Real-time Developer Notifications) via Google Cloud Pub/Sub push to POST /webhooks/play for subscription
  renewals, cancellations and refunds; Voided Purchases API polled daily as backup.
- Refund ("no match" flow): server calls Play Developer API orders.refund, marks booking refunded, releases nothing (event over).
- Free events skip billing entirely.
- iOS later will need Apple In-App Purchase; payment module is behind a provider interface so it can be added.
## 7b. Media storage [APPROVED: local disk]
- Upload: multipart POST /media/photos and /media/selfie to the API (multer), max 8 MB, jpeg/png/webp only,
  magic-byte check, re-encoded and stripped of EXIF with sharp, random file names.
- Paths: UPLOAD_DIR (default /var/sparkdate/uploads) -> public/photos/{userId}/ and private/selfies/{userId}/.
- Profile photos: served via short-lived signed URLs (GET /media/{key}?exp&sig) checked by the API, file sent by Nginx X-Accel-Redirect.
- Selfies: never public; only the owner and admins via authenticated endpoint.
- Keep UPLOAD_DIR on a DigitalOcean Volume (survives droplet rebuild) with weekly snapshots.
- Orphan cleanup job deletes files not referenced by any user after 24 h.

## 8. Caching
- Redis: event list/detail (60 s TTL, busted on admin edit), seat counters read from Mongo doc (source of truth).
- No cache for user-private data.

## 9. Failure handling
- Idempotency-Key header on POST /bookings, /payments, /refunds, decisions.
- Webhooks: verify signature, store raw event, process once.
- External calls (OTP, gateway, LiveKit): timeout 5 s, retry with backoff via BullMQ where safe; clear error codes to client.
- Redis loss during live event: rebuild waiting room from socket reconnects; rounds resume next tick.

## 10. Observability
- Structured JSON logs (pino) with requestId/userId/eventId; Sentry for API, admin and Flutter;
  /health and /ready endpoints; basic metrics: active sockets, waiting-room size, pairing latency, OTP failures, webhook failures.

## 11. Deployment (manual, for now)
- services/api: Dockerfile + .env.example; run behind Nginx with TLS on any VPS (DigitalOcean Bangalore [APPROVED]).
- apps/admin: static build (`dist/`) served by Nginx or any static host.
- apps/mobile: built APK/IPA by owner.
- Environments: dev, prod. Secrets only via env vars.

## 12. Open decisions (need owner approval)
None right now.
