# Sprint 2 design: Events, Booking, Google Play Billing, Refunds (v0.1)

Base path `/api/v1`. Auth: Bearer JWT (app). Errors: `{ error: { code, message } }`.
Money in paise. Times ISO-8601 UTC. All POSTs that create money/seat state require `Idempotency-Key` header.

## 1. Booking state machine
pending (seat held, 10 min) -> confirmed (free, or Play purchase verified)
pending -> expired (hold timeout, seat released by BullMQ job)
pending -> cancelled (user cancels before paying, seat released)
confirmed -> refund_requested -> refunded (seat NOT released if event already live/ended)
confirmed -> cancelled_by_admin (event cancelled -> auto refund for paid)

## 2. Seat hold (atomic, no overbooking)
1. `events.updateOne({_id, status:"published", startsAt:{$gt:now}, $expr:{$lt:["$booked.<g>","$capacity.<g>"]}}, {$inc:{"booked.<g>":1}})`
   matched=0 -> 409 `EVENT_FULL` (or `EVENT_NOT_BOOKABLE`).
2. Insert booking (unique {eventId,userId}). Duplicate key -> roll back `$inc` and return the existing booking (idempotent).
3. Paid: status `pending`, `holdExpiresAt=now+10m`, enqueue `booking.expire` job (delay 10m, jobId=bookingId).
4. Free: status `confirmed` immediately.
Release = `$inc:{"booked.<g>":-1}` guarded by booking status transition (findOneAndUpdate on status), so a seat is released exactly once.

## 3. Endpoints (app)
| Method | Path | Notes |
|---|---|---|
| GET | /events?status=upcoming\|live&city=&q=&cursor= | list, cached 60 s; returns seatsLeft for caller's gender |
| GET | /events/:id | detail + myBooking + liked/saved |
| POST/DELETE | /events/:id/like, /events/:id/save | idempotent |
| GET | /me/events/saved | saved list |
| POST | /bookings `{eventId}` | gates: profile complete, verification approved, not blocked. 201 `{booking, play?:{productId, obfuscatedAccountId, obfuscatedProfileId}}` |
| GET | /me/bookings | upcoming + past |
| DELETE | /bookings/:id | only while `pending` |
| POST | /payments/play/verify `{bookingId?, purchaseToken, productId, kind:"ticket"\|"chat_pass"}` | see 4 |
| POST | /bookings/:id/refund-request `{reason}` | allowed only if refundEligible (see 6) |
| GET | /subscriptions/me | chat pass status (name matches Flutter mock) |

## 4. Play purchase verification
- Ticket: Play API `purchases.products.get(packageName, productId, token)`. Accept only if purchaseState=0 (purchased),
  productId == event.playProductId, obfuscatedExternalAccountId == userId (set via in_app_purchase applicationUserName), bookingId taken from request body and must belong to the user and be pending/expired,
  and token not already in `payments` (unique index). Then in this order: insert payment(verified) -> confirm booking
  -> `purchases.products.acknowledge` -> mark payment acknowledged. App then consumes the purchase.
- If booking already expired when a valid purchase arrives: re-try the seat hold; if full, confirm nothing and refund via `orders.refund` immediately, return 409 `EVENT_FULL_REFUNDED`.
- purchaseState=2 (pending, e.g. UPI pending): keep booking pending, extend hold to 30 min, wait for RTDN.
- Chat Pass: `purchases.subscriptionsv2.get`; set `users.chatPassUntil = lineItems[0].expiryTime`; acknowledge.
- Unacknowledged after 10 min (crash): `payments.acknowledge` retry job, until Google's 3-day limit.
- Errors: `PURCHASE_INVALID`, `PURCHASE_ALREADY_USED`, `PRODUCT_MISMATCH`, `PLAY_UNAVAILABLE` (retryable, 503).

## 5. Webhooks
- POST /webhooks/play: Google Cloud Pub/Sub push, verify the OIDC JWT (audience = our URL, email = Pub/Sub service account).
  Store in `webhook_events` (unique messageId), ack 200 fast, process in BullMQ.
  Handles: subscription renewed/cancelled/expired/revoked (update chatPassUntil), one-time product purchased (finish pending), voided.
- Daily job: Voided Purchases API -> mark payments voided, revoke booking/pass.

## 6. Refunds ("no match" flow)
- refundEligible = booking confirmed AND paid AND event ended AND datesCompleted == 0 AND user attended (joined waiting room).
  Computed by `event.finalize` job at endsAt; app shows "Request refund" only when true.
- User request -> `refund_requested` -> admin approves in panel (or auto-approve when eligible, config `AUTO_REFUND_NO_MATCH=true`)
  -> `orders.refund(orderId)` -> status refunded + notification. Rejection needs reason.
- Admin cancels event -> all paid confirmed bookings auto-refunded, notifications sent.

## 7. Admin endpoints (cookie auth)
GET /admin/events/:id/bookings · GET /admin/refunds?status= · POST /admin/refunds/:bookingId/approve|reject
GET /admin/payments?userId=&status= · POST /admin/events/:id/cancel

## 8. Notifications (BullMQ jobs, FCM + in-app)
booking confirmed · event reminder T-24h and T-10min · refund requested/processed · chat pass expiring T-3d.
Jobs keyed by deterministic jobId (e.g. `remind:{eventId}:{userId}:10m`) so rescheduling never duplicates.

## 9. New env vars
PLAY_PACKAGE_NAME, GOOGLE_PLAY_SA_JSON_PATH (file outside repo), PUBSUB_PUSH_AUDIENCE, PUBSUB_SA_EMAIL,
REDIS_URL, BOOKING_HOLD_MIN=10, AUTO_REFUND_NO_MATCH=false, FCM_SA_JSON_PATH.

## 10. Owner setup needed (cannot be done by agents)
1. Play Console: create app, in-app products (`event_ticket_199`, ...) and subscription `chat_pass_monthly`.
2. Google Cloud service account linked in Play Console (financial + order management permissions), JSON key kept only on the server.
3. Pub/Sub topic + push subscription to `https://<api-domain>/api/v1/webhooks/play`, set in Play Console RTDN.
4. Firebase project for FCM.
5. Redis on the VPS.

## 11. QA focus
Last-seat race (N parallel POST /bookings), hold expiry vs late purchase, token replay, pending UPI purchase,
double refund request, RTDN duplicate delivery, admin event cancel with mixed free/paid bookings.


## Addendum (2026-10-30)
- Purchase token already linked to another booking -> `409 PURCHASE_TOKEN_USED` (distinct from `BOOKING_NOT_PENDING`).
- `POST /admin/payments/:id/link` body `{bookingId}`: payment must be `unlinked`; booking must belong to payment's user, be pending/expired, product must match. On success: confirm booking, then acknowledge the Play purchase. Errors: `PAYMENT_NOT_UNLINKED`, `BOOKING_MISMATCH`. Audit-logged. Must happen within Play's 3-day acknowledge window, else Google auto-refunds.
