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
| GET | /api/v1/events?status=upcoming\|past&city=&q=&limit=&cursor= | Published or live events. Returns `{items, nextCursor}`; each item has `seatsLeft` for the caller's gender. Sent with `Cache-Control: private, max-age=60`. |
| GET | /api/v1/events/:id | Adds `myBooking`, `liked` and `saved`. |
| POST/DELETE | /api/v1/events/:id/like, /save | Idempotent. |
| GET | /api/v1/me/events/saved | Saved events. |

## Bookings
| Method | Path | Result |
|---|---|---|
| POST | /api/v1/bookings `{eventId}` | Returns `201 {booking, play?}`. A free event is confirmed at once. A paid event becomes `pending`, holds the seat for `BOOKING_HOLD_MIN`, and returns `play: {productId, obfuscatedAccountId, obfuscatedProfileId}`. Pass these to BillingFlowParams. If the caller already has an active booking, returns `200` with it. |
| DELETE | /api/v1/bookings/:id | Cancels a `pending` booking and releases the seat. Otherwise returns `409 BOOKING_NOT_CANCELLABLE`. |
| POST | /api/v1/bookings/:id/refund-request `{reason}` | Allowed only when `refundEligible`, which is set by the post-event finalize job. |
| GET | /api/v1/me/bookings | Returns `{upcoming, past}`. |

Errors: `PROFILE_INCOMPLETE`, `VERIFICATION_REQUIRED` (403), `EVENT_NOT_FOUND` (404), `EVENT_NOT_BOOKABLE`, `EVENT_FULL`, `REFUND_NOT_ELIGIBLE`, `REFUND_ALREADY_REQUESTED`, `REFUND_REJECTED` (409). Another user's booking returns 404.

## Payments
`POST /api/v1/payments/play/verify` takes `{purchaseToken, productId, kind: "ticket"|"chat_pass", bookingId?}`.
The server reads the purchase from Play, checks the product, account id and booking id, saves the token, and acknowledges the purchase. If the acknowledgement fails, the `payment.ack` job retries it.
- `200 {booking}` or `200 {chatPass}`: done.
- `202 {status:"pending"}`: the payment is pending, for example UPI. The hold is extended by `PENDING_PURCHASE_HOLD_MIN`, and the RTDN completes the purchase.
- `400 PURCHASE_INVALID | PRODUCT_MISMATCH`
- `409 PURCHASE_ALREADY_USED`
- `409 EVENT_FULL_REFUNDED`: the hold had expired and the seat was taken, so the order is refunded automatically.
- `503 PLAY_UNAVAILABLE`: retry later.

`GET /api/v1/subscriptions/me` returns `{chatPass: {active, expiresAt, autoRenewing, state}}`.

## Notifications (in-app)
`GET /api/v1/notifications?cursor=` and `POST /api/v1/notifications/read {ids?}` (with no ids, marks all as read).
Types: booking_confirmed, event_reminder, event_cancelled, refund_processed, refund_rejected, chat_pass_expiring. FCM push is a stub until Firebase is configured.

## Webhook
`POST /api/v1/webhooks/play` receives Pub/Sub push. It requires an OIDC bearer token whose audience is `PUBSUB_PUSH_AUDIENCE` and whose email is `PUBSUB_SA_EMAIL`, otherwise it returns 401.
Messages are deduplicated by `messageId`. Messages from other packages are ignored. The handler returns 204 and processes the message in the `webhook.process` job.
It handles subscription, one-time product, and voided purchase notifications. Voided purchases are also reconciled daily by the `voided.sync` job.

## Admin (role admin only; hosts get 403)
| Method | Path |
|---|---|
| GET | /api/v1/admin/refunds?status=&page=&limit= |
| POST | /api/v1/admin/refunds/:bookingId/approve (calls orders.refund) |
| POST | /api/v1/admin/refunds/:bookingId/reject `{reason}` (final) |
| GET | /api/v1/admin/payments?status=&userId=&eventId= (`purchaseToken` is never returned) |
| POST | /api/v1/admin/events/:id/cancel → `{summary:{cancelledPending,cancelledFree,refunded,refundFailed}}`. Safe to re-run; failed refunds are retried by `refund.retry`. |

`PATCH /admin/events/:id {status:"cancelled"}` returns `409 USE_CANCEL_ENDPOINT` when the event has bookings.
