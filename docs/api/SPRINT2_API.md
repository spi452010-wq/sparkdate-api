# Sprint 2 API: events, bookings, Play Billing, refunds

Design: [../SPRINT2_BOOKING_PAYMENTS.md](../SPRINT2_BOOKING_PAYMENTS.md). Auth/profile contract: [AUTH_PROFILE_MEDIA.md](AUTH_PROFILE_MEDIA.md).
Errors use `{ "error": { "code", "message" } }`. Money is in paise. Times are ISO-8601 UTC.
App routes need `Authorization: Bearer <access>`. Admin routes use the admin cookie session plus `X-CSRF-Token` on writes.

## Idempotency
`POST /bookings`, `POST /payments/play/verify` and `POST /bookings/:id/refund-request` require `Idempotency-Key` (8-128 chars; otherwise `400 IDEMPOTENCY_KEY_REQUIRED`).
A retry with the same key replays the first response (`Idempotent-Replayed: true`) for 24 h. Responses with status 5xx are not stored, so a retry runs again.
Other errors: `409 IDEMPOTENCY_IN_PROGRESS` while the first request is still running, and `422 IDEMPOTENCY_KEY_REUSED` when the key was used on another route.

## Events (app)
| Method | Path | Notes |
|---|---|---|
| GET | /api/v1/events?status=upcoming\|live&city=&q=&limit=&cursor= | `upcoming` (default): published events that have not started. `live`: events currently live. Returns `{items, nextCursor}`; each item has `seatsLeft` for the caller's gender. Sent with `Cache-Control: private, max-age=60`. |
| GET | /api/v1/events/:id | Adds `myBooking`, `liked` and `saved`. A missing or hidden event returns `404 NOT_FOUND`. |
| POST/DELETE | /api/v1/events/:id/like, /save | Idempotent. |
| GET | /api/v1/me/events/saved | Saved events. |

## Bookings
| Method | Path | Result |
|---|---|---|
| POST | /api/v1/bookings `{eventId}` | Returns `201 {booking, play?}`. A free event is confirmed at once. A paid event becomes `pending`, holds the seat for `BOOKING_HOLD_MIN`, and returns `play: {productId, obfuscatedAccountId}`. Set `obfuscatedAccountId` as the purchase's account id (Flutter `in_app_purchase`: `applicationUserName`). If the caller already has an active booking, returns `200` with it. |
| DELETE | /api/v1/bookings/:id | Cancels a `pending` booking and releases the seat. Otherwise returns `409 BOOKING_NOT_CANCELLABLE`. |
| POST | /api/v1/bookings/:id/refund-request `{reason}` | Allowed only when `refundEligible`, which is set by the post-event finalize job. |
| GET | /api/v1/me/bookings | Returns `{upcoming, past}`. |

Errors: `PROFILE_INCOMPLETE`, `VERIFICATION_REQUIRED` (403), `NOT_FOUND` (404, missing event), `BOOKING_NOT_FOUND` (404), `EVENT_NOT_BOOKABLE`, `EVENT_FULL`, `REFUND_NOT_ELIGIBLE`, `REFUND_ALREADY_REQUESTED`, `REFUND_REJECTED` (409). Another user's booking returns 404.

## Payments
`POST /api/v1/payments/play/verify` takes `{purchaseToken, productId, kind: "ticket"|"chat_pass", bookingId}`; `bookingId` is required when `kind` is `ticket`.
The server reads the purchase from Play and checks, for tickets:
- the booking belongs to the caller (otherwise `404 BOOKING_NOT_FOUND`) and is `pending` (an `expired`/`cancelled` hold takes the late-purchase path below; anything else is `409 BOOKING_NOT_PENDING`, except a retry with the same token);
- `productId` equals the event's `playProductId` (otherwise `400 PRODUCT_MISMATCH`);
- the purchase's `obfuscatedExternalAccountId` is present and equals the caller's user id (otherwise `400 PURCHASE_INVALID`);
- `obfuscatedExternalProfileId` is not required; if Play returns one it must equal `bookingId` (otherwise `400 PURCHASE_INVALID`);
- a purchase token is used once: it cannot confirm a second booking or be used by another user (`409 PURCHASE_ALREADY_USED`).

It then saves the token and acknowledges the purchase. If the acknowledgement fails, the `payment.ack` job retries it.
- `200 {status:"confirmed", booking}` (ticket) or `200 {status:"confirmed", chatPassUntil}` (chat pass): done.
- `202 {status:"pending"}` (chat pass) or `202 {status:"pending", booking}` (ticket): the payment is pending, for example UPI. A ticket hold is extended by `PENDING_PURCHASE_HOLD_MIN`, and the RTDN completes the purchase.
- `400 PURCHASE_INVALID | PRODUCT_MISMATCH`
- `404 BOOKING_NOT_FOUND`
- `409 PURCHASE_ALREADY_USED | BOOKING_NOT_PENDING`
- `409 EVENT_FULL_REFUNDED`: the hold had expired and the seat was taken, so the order is refunded automatically.
- `503 PLAY_UNAVAILABLE`: retry later.

`GET /api/v1/subscriptions/me` returns `{chatPass: {active, expiresAt, productId, autoRenewing, state}}`.

## Notifications (in-app)
`GET /api/v1/notifications?before=<ISO time>&limit=` (newest first, `limit` 1-50, default 20) returns `{items}`; for the next page pass the last item's `createdAt` as `before`. `POST /api/v1/notifications/read {ids?}` returns `{updated}` (with no ids, marks all as read).
Types: booking_confirmed, event_reminder, event_cancelled, refund_processed, refund_rejected, chat_pass_expiring. FCM push is a stub until Firebase is configured.

## Webhook
`POST /api/v1/webhooks/play` receives Pub/Sub push. It requires an OIDC bearer token whose audience is `PUBSUB_PUSH_AUDIENCE` and whose email is `PUBSUB_SA_EMAIL`, otherwise it returns 401.
Messages are deduplicated by `messageId`. Messages from other packages are ignored. The handler returns 204 and processes the message in the `webhook.process` job.
It handles subscription, one-time product, and voided purchase notifications. A one-time purchase without `obfuscatedExternalProfileId` (Flutter) is applied only when the user has exactly one `pending` booking for an event with that `playProductId`; with zero or several the server never guesses: it saves the payment with status `unlinked` (no booking, no refund) and schedules `payment.reconcile` in 15 min. A later app verify with `bookingId` links that payment to the booking (once, atomically). If it is still unlinked at reconcile, it gets `flaggedAt` and an `ADMIN ALERT` log line; admins see it at `GET /admin/payments?status=unlinked` and resolve it with `POST /admin/payments/:id/link {bookingId}`. It is never auto-refunded. Voided purchases are also reconciled daily by the `voided.sync` job.

## Admin (role admin only; hosts get 403)
| Method | Path |
|---|---|
| GET | /api/v1/admin/refunds?status=&q=&page=&limit= |
| POST | /api/v1/admin/refunds/:bookingId/approve (calls orders.refund) |
| POST | /api/v1/admin/refunds/:bookingId/reject `{reason}` (final) |
| GET | /api/v1/admin/payments?status=&userId=&eventId=&q=&page=&limit= (`purchaseToken` is never returned; `status=unlinked` is the alert list) |
| POST | /api/v1/admin/payments/:id/link `{bookingId}` → `{status, booking}`; only for `unlinked` payments (`409 PAYMENT_NOT_UNLINKED`), booking must belong to the payer (`404`) |
| POST | /api/v1/admin/events/:id/cancel → `{summary:{cancelledPending,cancelledFree,refunded,refundFailed}}`. Safe to re-run; failed refunds are retried by `refund.retry`. |

`PATCH /admin/events/:id {status:"cancelled"}` returns `409 USE_CANCEL_ENDPOINT` when the event has bookings.

### Admin list filters and item shape
- `q` (optional, 1-80 chars after trimming) is a case-insensitive substring match on the user's name, phone or email. It is matched as plain text, not a regex. At most 200 matching users are considered. It can be combined with the other filters.
- `eventId` (payments only) must be a valid ObjectId, otherwise `400`. It matches payments whose booking belongs to that event.
- Each item has `user: { id, fullName, phone }`, read from `users` at query time. Names are not copied into payments or bookings. When the user no longer exists, `fullName` and `phone` are `null`.

Payments response:
```json
{ "items": [{ "id": "…", "userId": "…", "user": { "id": "…", "fullName": "Asha Verma", "phone": "+9190…" },
  "bookingId": "…|null", "kind": "ticket|chat_pass", "productId": "event_ticket_199", "orderId": "GPA.…",
  "amountInPaise": 19900, "status": "verified|unlinked|refunded|refund_failed|voided", "acknowledged": true, "flaggedAt": "…|undefined",
  "createdAt": "…", "refundedAt": "…|undefined" }], "page": 1, "limit": 20, "total": 1 }
```
Refunds response:
```json
{ "items": [{ "bookingId": "…", "status": "refund_requested|refunded|confirmed", "refund": { "status": "requested", "reason": "…", "requestedAt": "…" },
  "amountInPaise": 19900, "playOrderId": "GPA.…", "user": { "id": "…", "fullName": "…", "phone": "…" },
  "event": { "id": "…", "title": "…", "startsAt": "…" } }], "page": 1, "limit": 20, "total": 1 }
```

### Event city
`POST /admin/events` requires `city`: a trimmed string of 1-60 characters, which the admin form must send. On `PATCH`, `city` is optional, but if it is sent it must be non-empty, so `""`, whitespace and `null` return 400. The database field stays optional so that older events without a city still load; they show `city: undefined` and are not matched by the `?city=` filter.
