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
