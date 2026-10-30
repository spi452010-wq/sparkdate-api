# SparkDate API (Node.js + TypeScript)
Sprint 1: WhatsApp OTP (Meta Cloud API) + Google login, rotating refresh tokens, profile, media uploads, admin verification/blocking.
Contract: `../../docs/api/AUTH_PROFILE_MEDIA.md`. Architecture: `../../docs/ARCHITECTURE.md`.

## Run
```
cp .env.example .env    # fill secrets; never commit .env
npm ci && npm run build && npm start      # dev: npm run dev
npm test                                   # 20 tests, in-memory MongoDB
```
Needs Node 20+ and MongoDB. `WHATSAPP_PROVIDER=console` prints OTPs to the log and is refused when NODE_ENV=production.

## Deploy notes (DigitalOcean VPS)
- Put `UPLOAD_DIR` on a DigitalOcean Volume with snapshots; it must be outside the web root and owned by the API user.
- Nginx: set `USE_X_ACCEL=true` and add
  `location /protected-media/ { internal; alias /var/sparkdate/uploads/; }`
- Make the first admin manually: `db.users.updateOne({ phone: "+91..." }, { $set: { role: "admin" } })`.
- Meta Cloud API needs an approved authentication template (default name `otp_login`) with a code body param and copy-code button.

## Not in this drop
Events CRUD and seat booking (S1-4), Google Play Billing, LiveKit, chat (later sprints). Admin login currently uses the same OTP/Google login with role `admin`; a cookie-based admin session for the React panel comes with S1-4.

## Production secrets

In `NODE_ENV=production` the server refuses to start if `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` or `MEDIA_URL_SECRET` look like placeholders (for example the `change-me` values in `.env.example`) or are reused across keys. Generate each one with `openssl rand -base64 48`.
