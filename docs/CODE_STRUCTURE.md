# Code structure

All feature code lives in `src/modules/<module>/`. Each module is layered; a request flows
`routes -> (middleware: auth, validate) -> controller -> service -> model`.

| File | Responsibility | Must not |
|---|---|---|
| `<name>.routes.ts` | Express `Router` wiring: paths, `requireAuth`/`requireRole`, `validate(schema, part)`, idempotency, rate limiters, controller handler. | contain logic or DB calls |
| `<name>.controller.ts` | Map `req` -> service args and service result -> HTTP status/JSON/cookies. Every handler is wrapped in `asyncHandler`. | touch models / DB |
| `<name>.service.ts` | Business logic and DB access. Plain arguments in, plain data out. Errors are thrown as `AppError(status, CODE, message?)`. | see `req`/`res` |
| `<entity>.model.ts` | Mongoose schema/model. Named after the entity (`user.model`, `booking.model`), not the module. | |
| `<name>.validation.ts` | zod schemas used by `validate()` in routes. | |
| `<entity>.mapper.ts` | Pure response shapers (e.g. `bookingOut`, `appEvent`, `refundOut`, `paymentOut`). Shared between modules to avoid route→route imports. | do I/O |

## Modules

| Module | Mounted at | Files |
|---|---|---|
| auth | `/api/v1/auth` | `auth.*`, helpers `otp.service`, `tokens`, `password`, `whatsapp`; models `user`, `otp`, `refreshToken` |
| profile | `/api/v1/profile` | `profile.*` (also exports `requireCompletedProfile`) |
| media | `/api/v1/media` | `media.*`, helpers `storage`, `signing` |
| admin | `/api/v1/admin` | `admin.*` (users, stats, verification), `adminAuth.*` (cookie session + CSRF) |
| events | `/api/v1/events`, `/api/v1/admin/events` | `events.*`, `adminEvents.*`, `event.mapper`, models `event`, `reaction` |
| bookings | `/api/v1/bookings`, `/api/v1/me` | `bookings.*`, `booking.mapper`, `booking.model`; seat hold/expiry, reminders, refund request |
| notifications | `/api/v1/notifications` | `notifications.*`, `notify.ts` (store + push sender), `notification.model` |
| payments | `/api/v1/payments`, `/api/v1/subscriptions` | `payments.*`, `playClient.ts`, `payment.model`; Play verification, ack, RTDN handlers, voided sync |
| refunds | `/api/v1/admin` (refunds, payments, event cancel) | `refunds.*`, `refund.mapper` |
| webhooks | `/webhooks` | `webhooks.*`, `webhookEvent.model` |

A module may hold several sub-features with their own layer files, prefixed by the
sub-feature (`adminAuth.*`, `adminEvents.*`).

## Conventions

- Services may call other modules' services (e.g. payments → bookings `onConfirmed`); cross-module
  calls only happen inside functions, never at import time, so circular imports are safe.
- Background jobs (`src/jobs/handlers.ts`) call service functions directly.
- Status codes and error codes are part of the API contract; see `docs/` API docs.
- Secrets never appear in responses (e.g. `purchaseToken` is excluded from admin payment lists).

## Back-compat shims and test seams

Older import paths are kept as one-line re-exports so tests and callers keep working:

- `events/booking.model.ts` → `bookings/booking.model.ts`
- `bookings/bookings.routes.ts` re-exports `bookingOut` and `notifications`
- `events/events.routes.ts` re-exports `appEvent`, `VISIBLE`
- `refunds/adminPayments.routes.ts` → `refunds.routes.ts`
- `webhooks/play.routes.ts` → `webhooks.routes.ts` + `setPubsubVerifier`, `processWebhookEvent`

Test seams (swap external dependencies in tests): `setGoogleVerifier` (auth), `setPubsubVerifier`
(webhooks), `setPlayClient` / play client in `payments/playClient`, `setNotificationSender` (notify).
New code should import from the canonical files, not the shims.

## Relation to the earlier standard (commit 783e626)

The earlier standard below is kept for reference. Where it differs from what the code does today:

- Validation files are named `<name>.validation.ts` (per the refactor brief), not `.validator.ts`.
- No separate `*.repository.ts` / `*.types.ts` yet; queries live in services (allowed as "optional").
- Rule 2 (cross-module access only via services) is **not fully met**: some services still read
  other modules' models directly (e.g. bookings/payments/refunds read `User`, `Event`, `Payment`).
- Rule 4 (external clients in `src/integrations/`) is **not done**: `payments/playClient.ts`,
  `auth/whatsapp.ts`, `media/storage.ts` stay in their modules behind setter seams.
These are candidates for a follow-up refactor.

---

# Backend code structure (mandatory)

Each module: src/modules/<module>/
- <module>.routes.ts      path + middleware + controller mapping only
- <module>.controller.ts  parse req (validated DTO), call service, map to HTTP response; no DB access
- <module>.service.ts     business logic; no Express types (req/res) inside
- <module>.repository.ts  Mongo queries when non-trivial (optional for simple CRUD)
- <module>.model.ts       Mongoose schema + indexes, owned by this module only
- <module>.validator.ts   zod schemas for body/query/params
- <module>.types.ts       DTOs, interfaces

Rules
1. No business logic in routes. No DB calls in controllers.
2. Cross-module access only through the other module's service, never its model.
3. Services throw AppError(code, status); the error middleware maps it.
4. External clients (Play, WhatsApp, LiveKit, storage) live in src/integrations/<name>/ behind interfaces, injected into services (mockable in tests).
5. Shared code: src/middleware, src/utils, src/config, src/jobs. No module imports from another module's internal files except its service and types.
6. Refactors must not change API behaviour; full test suite must stay green.
