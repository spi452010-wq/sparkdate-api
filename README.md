# SparkDate API (Node.js + TypeScript)
Sprint 1: WhatsApp OTP (Meta Cloud API) + Google login, rotating refresh tokens, profile, media uploads, admin verification/blocking.
Contracts: `docs/api/AUTH_PROFILE_MEDIA.md`, `docs/api/SPRINT2_API.md` (Sprint 2). Design: `docs/SPRINT2_BOOKING_PAYMENTS.md`. Architecture: `docs/ARCHITECTURE.md`.

## Run
```
cp .env.example .env    # fill secrets; never commit .env
npm ci && npm run build && npm start      # dev: npm run dev
npm test                                   # 57 tests, in-memory MongoDB
```
Needs Node 20+ and MongoDB. `WHATSAPP_PROVIDER=console` prints OTPs to the log and is refused when NODE_ENV=production.

## Deploy notes (DigitalOcean VPS)
- Put `UPLOAD_DIR` on a DigitalOcean Volume with snapshots; it must be outside the web root and owned by the API user.
- Nginx: set `USE_X_ACCEL=true` and add
  `location /protected-media/ { internal; alias /var/sparkdate/uploads/; }`
- Make the first admin manually: `db.users.updateOne({ phone: "+91..." }, { $set: { role: "admin" } })`.
- Meta Cloud API needs an approved authentication template (default name `otp_login`) with a code body param and copy-code button.

## Sprint 2 (events, booking, Play Billing, refunds)
- Jobs: with `REDIS_URL` set, jobs run on BullMQ. Without it in dev, they run on in-process timers, which are lost on restart. Tests use an in-memory queue. Production requires Redis.
- Without Play config, payment endpoints return `503 PLAY_UNAVAILABLE` in dev.
- In production, the server refuses to start unless these are set: `PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SA_JSON_PATH`, `PUBSUB_PUSH_AUDIENCE` (https), `PUBSUB_SA_EMAIL` and `REDIS_URL`. `GOOGLE_PLAY_SA_JSON_PATH` must be an absolute path outside the repo, for example `/etc/sparkdate/play-sa.json` with mode 600.
- Owner setup:
  - Play Console: create the event ticket products and the `chat_pass_monthly` subscription, and grant the service account access to financial data and order management.
  - Create a Pub/Sub topic and connect it to Play RTDN. Add a push subscription to `https://<api>/api/v1/webhooks/play` with OIDC auth (audience = `PUBSUB_PUSH_AUDIENCE`, service account = `PUBSUB_SA_EMAIL`).
  - Set up a Firebase project for FCM (the sender is a stub for now).
  - Run Redis.

## Not yet
LiveKit and the waiting room (S3), chat (S4), and real FCM sending. `attendedAt` is set by the live-session module (S3), so refund eligibility depends on it.

## Production secrets

In `NODE_ENV=production` the server refuses to start if `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` or `MEDIA_URL_SECRET` look like placeholders (for example the `change-me` values in `.env.example`) or are reused across keys. Generate each one with `openssl rand -base64 48`.
