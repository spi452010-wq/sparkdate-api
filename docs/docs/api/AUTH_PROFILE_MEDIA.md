# SparkDate API v1 – Auth, Profile, Media, Admin users (Sprint 1)
Base: `/api/v1`. JSON unless noted. Errors: `{ "error": { "code", "message", "details?" } }`.
Auth: `Authorization: Bearer <accessToken>` (JWT HS256, 15 min). Refresh tokens rotate; reusing an old one revokes the whole session family.

## Auth
| Method | Path | Body | 200 response |
|---|---|---|---|
| POST | /auth/otp/request | `{ phone }` (E.164, `+91...`) | `{ expiresInSec: 300, resendAfterSec: 30 }` |
| POST | /auth/otp/verify | `{ phone, code }` (6 digits) | `{ user, accessToken, refreshToken }` (creates user on first login) |
| POST | /auth/google | `{ idToken }` (Google Sign-In ID token) | `{ user, accessToken, refreshToken }`; links to existing account with same verified email |
| POST | /auth/refresh | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| POST | /auth/logout | `{ refreshToken }` | 204 |

OTP rules: 6 digits, 5 min expiry, single use, new OTP invalidates the previous one, resend after 30 s, max 5 sends/hour per phone, 5 wrong attempts → phone locked 15 min. IP limit: `AUTH_IP_LIMIT_PER_15MIN` (default 30) auth requests / 15 min.
Codes: `OTP_INVALID` 400, `OTP_EXPIRED` 400, `OTP_LOCKED` 429 (`details.retryAfterSec`), `OTP_RATE_LIMITED` 429, `PROVIDER_UNAVAILABLE` 503 (nothing saved, safe to retry), `GOOGLE_TOKEN_INVALID` 401, `ACCOUNT_BLOCKED` 403, `REFRESH_INVALID` / `REFRESH_REUSED` 401, `UNAUTHORIZED` / `TOKEN_INVALID` 401.

`user` = `{ id, phone?, email?, role: user|host|admin, profileCompleted, verification: { status } }`

## Media (multipart/form-data, field `file`, max 8 MB, jpeg/png/webp)
| POST | /media/photos | → 201 `{ key }` |
| POST | /media/selfie | → 201 `{ key }` |
Server checks real format by decoding, re-encodes to WebP (max 1440px), strips EXIF/GPS, random UUID names. Codes: `FILE_REQUIRED` 400, `FILE_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `STORAGE_FULL` 507.
- Photos are read only via the signed `url` returned in profile responses (expires in 15 min; do not cache long term).
- Selfies: never served without a signature. Owner: `GET /media/selfies/me` (Bearer) → `{ url }`. Admin: `selfieUrl` in `/admin/users` items. Selfie URLs expire in 5 min.

## Profile (auth required)
| GET | /profile/me | → profile view |
| PUT | /profile/me | complete profile, once (`409 PROFILE_ALREADY_COMPLETED` after) |
| PATCH | /profile/me | edit `fullName, interestedIn, bio, city, interests, photos` (gender and dob locked) |
| POST | /profile/me/verification | `{ selfieKey }` → 202 `{ status: "pending" }` |
PUT body: `{ fullName (2-50), gender: male|female, interestedIn: male|female, dob (18+), bio? (≤300), city? (≤60), interests? (≤10), photos: [key] (1-6, own keys only) }`. Unknown fields → 400 `VALIDATION_ERROR`. Foreign photo key → 403 `MEDIA_NOT_OWNED`.
Response: `{ id, phone, email, role, profileCompleted, verification: { status, reason? }, profile: { ..., photos: [{ key, order, url }] } }`

## Admin (role admin)
| GET | /admin/users?verification=&status=&page=&limit= | `{ items (with signed selfieUrl), page, limit, total }` |
| POST | /admin/users/{id}/verification | `{ decision: approved|rejected, reason? }` |
| POST | /admin/users/{id}/status | `{ status: active|blocked }` (blocked users get 403 everywhere) |
Normal users get 403 `FORBIDDEN`.

## Admin web session (cookies, for the React panel)
| POST | /admin/auth/login | `{ email, password }` → `{ id, email, role, fullName? }`; sets httpOnly `sd_at` (path /api/v1, 15 min), httpOnly `sd_rt` (path /api/v1/admin/auth), readable `csrf_token`. 401 `INVALID_CREDENTIALS`, 403 `ACCOUNT_BLOCKED` / `FORBIDDEN` (role user). 10 tries / 15 min / IP → 429 `TOO_MANY_ATTEMPTS`; 5 wrong passwords → account locked 15 min, 429 `ACCOUNT_LOCKED`. Passwords hashed with argon2id |
| GET | /admin/auth/me | → user; rotates refresh cookie if access cookie expired; 401 otherwise |
| POST | /admin/auth/logout | 204, revokes refresh family, clears cookies |
Cookie auth is accepted only under `/api/v1/admin/*` (not on media or mobile routes). Unsafe methods with cookie auth need `X-CSRF-Token` = `csrf_token` cookie, else 403 `CSRF_INVALID`. Cookies are SameSite=Strict, Secure in production: serve panel and API from the same origin.
Admins/hosts are created on the server: `ADMIN_EMAIL=.. ADMIN_PASSWORD=.. ADMIN_ROLE=admin npm run create-admin:prod` (password 12+ chars).

## Admin events (roles admin, host; hosts see only their own)
| GET | /admin/events?status=&page=&limit= | `{ items: Event[], total }` |
| GET | /admin/events/{id} | Event |
| POST | /admin/events | EventInput → 201 |
| PATCH | /admin/events/{id} | partial EventInput → Event |
| GET | /admin/events/{id}/bookings | `{ items: Booking[], total }` (empty until Sprint 2 booking) |
EventInput: `title (3-80), description? (≤1000), startsAt (future), endsAt?, roundMinutes (1-30, default 3), capacity { male ≥1, female ≥1, total ≤300 }, priceInPaise (0 = free), playProductId (required if paid), status? (draft|published on create)`. `booked` is server-only.
Status moves: draft→published|cancelled, published→draft|cancelled|live, live→ended. Others → 409 `INVALID_STATUS_TRANSITION`. Live/ended events can't change schedule, price or capacity (409 `EVENT_LOCKED`). Lowering capacity below booked seats → 409 `CAPACITY_BELOW_BOOKED` (atomic check).
`GET /admin/users` also takes `q` (name, phone or email). `GET /admin/stats` (admin) → `{ totalUsers, pendingVerifications, publishedEvents, liveEvents, openReports, pendingRefunds }` (last two are 0 until those modules exist).
Not yet: reports, refunds, payments admin APIs (Sprints 2 and 4).
