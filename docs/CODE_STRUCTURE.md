# Backend code structure (mandatory)

This is the single standard for `src/`. All code follows it; there is no list of exceptions.

## Layout

```
src/
  app.ts, server.ts          Express app wiring and process entry point
  config/                    env parsing and validation
  middleware/                auth, validate, idempotency, error mapping (shared, module-agnostic)
  utils/                     AppError/asyncHandler, logger, baseRepository, shared zod primitives
  jobs/                      queue and job handlers (call module services only)
  scripts/                   CLI scripts (call module services/repositories only)
  integrations/<name>/       external clients behind interfaces, each with a fake.ts
  modules/<module>/          feature modules (layout below)
```

## A module: `src/modules/<module>/`

| File | Responsibility |
|---|---|
| `<module>.routes.ts` | Path + middleware + controller mapping only. Exports routers, nothing else. |
| `<module>.controller.ts` | Reads the validated DTO from `req`, calls the service, maps the result to an HTTP response. No DB access, no business rules. |
| `<module>.service.ts` | Business logic. No Express types. Throws `AppError`. This is the module's public API. |
| `<module>.repository.ts` | All Mongo access for the module's models: `baseRepository(Model)` plus named domain queries (e.g. `reserveSeat`). |
| `<entity>.model.ts` | Mongoose schema + indexes. Imported only by the module's own repository (and its `types.ts` for document types). |
| `<module>.validator.ts` | zod schemas for body/query/params, used by the `validate()` middleware. |
| `<module>.types.ts` | DTOs (inferred from validators with `z.infer`) and interfaces shared across the module's layers. |
| `<entity>.mapper.ts` | Optional: document → response shape. Other modules reach it only via this module's service. |

A module may split into sub-features with the same suffixes (e.g. `adminEvents.*` inside `events/`, `otp.service.ts`, `tokens.ts` inside `auth/`).

Model ownership: `users` (User), `auth` (Otp, RefreshToken), `events` (Event, EventReaction), `bookings` (Booking), `payments` (Payment), `notifications` (Notification), `webhooks` (WebhookEvent). `IdempotencyKey` belongs to the shared idempotency middleware.

## Rules

1. No business logic in routes. No DB calls in controllers.
2. Only a module's repository imports its models. Services run queries only through repositories.
3. Cross-module access goes only through the other module's **service**, **repository** or **types**, never its model, controller, validator, mapper or helper files. Values another module needs (e.g. `bookingOut`, `appEvent`, `signedUrl`, `hashPassword`, `issueTokens`) are re-exported by the owning service.
4. Services throw `AppError(status, code)`; the error middleware maps it to `{ error: { code, message } }`.
5. External clients live in `src/integrations/<name>/index.ts` behind an interface, with a default implementation, a `set…()` test seam, and a `fake.ts`:
   - `play` — `PlayClient` (Google Play Developer API), `setPlayClient`, `FakePlayClient`
   - `whatsapp` — `OtpSender`, `setOtpSender`, `FakeOtpSender`
   - `storage` — `StorageProvider`, `setStorage`, `MemoryStorage`
   - `pubsub` — `PubsubVerifier` (push OIDC token), `setPubsubVerifier`, `fakePubsubVerifier`
   - `google` — `GoogleVerifier` (Sign-In ID token), `setGoogleVerifier`, `fakeGoogleVerifier`
   - `push` — `NotificationSender`, `setNotificationSender`, `FakeNotificationSender`
   Services import integrations; integrations never import modules.
6. Shared code lives in `middleware`, `utils`, `config`, `jobs`. These may import module services/repositories (e.g. `middleware/auth` uses the users repository) but never models.
7. No back-compat re-export shims: when a file moves, update its importers.
8. Circular imports between services are allowed only when the imported functions are used at call time, never at module load.
9. Refactors must not change API behaviour; the full test suite and `tsc --noEmit` stay green.

## Tests

Tests are black-box over HTTP (`supertest` + `mongodb-memory-server`). They swap external clients via the integration seams (`setPlayClient`, `setOtpSender`, `setGoogleVerifier`, `setPubsubVerifier`, `setNotificationSender`, `setStorage`) and may seed or inspect data through models directly.
