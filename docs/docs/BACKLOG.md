# SparkDate – Project Backlog (single source of truth)
Status values: TODO / IN PROGRESS / BLOCKED / IN REVIEW / DONE (only mark DONE when code exists in this folder and QA passed).

## Decisions (approved by sp infotech, 30 Oct 2026)
- Flutter mobile app, Node.js backend, React admin panel (now)
- Video: LiveKit (Agora no). No AWS for now. No GitHub for now: code lives in folders, user deploys manually
- Event capacity: admin sets boys + girls seats separately; ~300 users per event

- Payments: Google Play Billing (not Razorpay) – paid events as consumable in-app products, Chat Pass as subscription; server-side purchase verification + refunds via Google Play Developer API
- WhatsApp OTP: Meta Cloud API
- Video: LiveKit Cloud (managed)

- Storage: photos/selfies on the VPS local disk folder (no R2 for now); selfies private, served only via authorized API
- Hosting: DigitalOcean VPS

## Pending approvals
- None

## Folders
- apps/mobile – Flutter (Senior Flutter Agent)
- apps/admin – React admin (Senior React.js Agent)
- services/api – Node.js API (Senior Node.js Backend Agent)
- docs/api – OpenAPI contract (Node.js + System Architect)
- docs/ – architecture, schema (System Architect), test plans (QA)

## Sprint 1 – Auth, onboarding, admin basics
| ID | Task | Owner | Status |
|----|------|-------|--------|
| S1-1 | Architecture doc + MongoDB schema (users, profiles, events w/ gender capacity) | System Architect | DONE (docs/ARCHITECTURE.md, docs/DB_SCHEMA.md) |
| S1-2 | OpenAPI: auth (WhatsApp OTP, Google, JWT refresh), profile, admin auth, events CRUD | Node.js | IN REVIEW (docs/api/AUTH_PROFILE_MEDIA.md incl. admin session + events) |
| S1-3 | API: OTP + Google login, JWT, profile CRUD, media uploads, admin verification | Node.js | IN REVIEW (20 tests passing, waiting on QA) |
| S1-4 | API: admin auth, events CRUD with atomic seat limits | Node.js | IN REVIEW (admin cookie+CSRF session, events CRUD, users q, stats; reports/refunds/payments admin APIs moved to S2/S4) |
| S1-5 | Flutter setup, theme tokens, splash, intro, login, WhatsApp verify, complete profile (mock) | Flutter | In review |
| S1-6 | Admin: login, event create/edit, events list, users + verification review (mock) | React.js | IN REVIEW (code ready for QA; apps/admin on real cookie auth, users, stats, events APIs; reports/refunds/payments mock-only until Sprint 2/4, see apps/admin/docs/admin-api.md) |
| S1-7 | Test plan + automated tests for auth, OTP, profile, capacity, admin roles | QA | TODO |

## Later sprints
- S2 Events + booking + payments · S3 Waiting room, matching, LiveKit calls · S4 Connections, chat, subscription, refunds, notifications

## Blockers
- None yet
