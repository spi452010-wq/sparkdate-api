# SparkDate – MongoDB schema & indexes (v0.1, draft)

All docs: `_id: ObjectId`, `createdAt`, `updatedAt`. Money in paise (integer). Times in UTC.

## users
{ phone?: "+919876543210", email?, googleSub?, roles: ["user"|"host"|"admin"], status: "active"|"blocked"|"deleted",
  profile: { fullName, dob, gender: "male"|"female", interestedIn: "male"|"female", city, interestedCities: [],
             bio, interests: [], professionalInterests: [], lookingFor: [], photos: [{ key, order }] },
  profileCompletedAt?, verification: { status: "none"|"pending"|"approved"|"rejected", selfieKey?, reviewedBy?, reviewedAt?, reason? },
  chatPassUntil?, fcmTokens: [], lastActiveAt }
Indexes: { phone:1 } unique sparse; { email:1 } unique sparse; { googleSub:1 } unique sparse;
         { "verification.status":1, createdAt:-1 } (admin review queue); { status:1 }

## refresh_tokens
{ userId, tokenHash, familyId, expiresAt, revokedAt?, userAgent, ip }
Indexes: { tokenHash:1 } unique; { userId:1 }; { expiresAt:1 } TTL

## events
{ title, description, hostName, coverKey, city, mode: "online", startsAt, endsAt, roundMinutes: 3, maxRounds,
  priceInPaise: 0|19900, playProductId?: "event_ticket_199", status: "draft"|"published"|"live"|"ended"|"cancelled",
  capacity: { male: 150, female: 150 }, booked: { male: 0, female: 0 }, tags: [], createdBy }
Indexes: { status:1, startsAt:1 }; { city:1, startsAt:1 }; text index on { title, hostName, city }
Seat booking (atomic): updateOne({ _id, status:"published", $expr:{ $lt:["$booked.male","$capacity.male"] } }, { $inc:{ "booked.male":1 } })

## bookings
{ eventId, userId, gender, status: "pending"|"confirmed"|"cancelled"|"expired"|"refunded",
  holdExpiresAt?, paymentId?, amountInPaise, datesCompleted: 0, refund?: { status:"requested"|"processing"|"processed"|"rejected", requestedAt, playOrderId } }
Indexes: { eventId:1, userId:1 } unique; { userId:1, createdAt:-1 }; { status:1, holdExpiresAt:1 }

## payments
{ userId, purpose: "booking"|"chat_pass", refId, provider: "google_play", productId, purchaseToken, orderId,
  amountInPaise, status: "pending"|"verified"|"acknowledged"|"refunded"|"voided", subscriptionExpiresAt? }
Indexes: { purchaseToken:1 } unique (prevents token replay); { orderId:1 } unique sparse; { userId:1, createdAt:-1 }

## webhook_events
{ source: "play_rtdn", messageId, type, payload, processedAt? }
Indexes: { source:1, messageId:1 } unique

## event_likes  (like / save an event)
{ userId, eventId, type: "like"|"save" }
Indexes: { userId:1, eventId:1, type:1 } unique

## dates  (one 1:1 round)
{ eventId, round, userA, userB, livekitRoom, startedAt, endsAt, endedAt?, endReason: "completed"|"early_disconnect"|"no_show",
  decisions: { [userId]: "like"|"pass"|"save" } }
Indexes: { eventId:1, round:1 }; { eventId:1, userA:1, userB:1 } unique (no re-pairing); { userA:1 }; { userB:1 }

## connections  (likes between people)
{ fromUser, toUser, eventId, dateId, kind: "like"|"save", mutual: false }
Indexes: { fromUser:1, toUser:1 } unique; { toUser:1, createdAt:-1 } (They Liked You); { fromUser:1, mutual:1 }

## conversations
{ participants: [userId, userId] (sorted), connectionId, lastMessageAt, lastMessagePreview }
Indexes: { participants:1 } unique (sorted pair); { participants:1, lastMessageAt:-1 }

## messages
{ conversationId, senderId, text, clientMsgId, readAt? }
Indexes: { conversationId:1, _id:-1 } (pagination); { senderId:1, clientMsgId:1 } unique (dedupe retries)

## notifications
{ userId, type, title, body, data, readAt? }
Indexes: { userId:1, createdAt:-1 }; { createdAt:1 } TTL 90 days

## reports
{ reporterId, reportedId, eventId?, dateId?, reason, details, status: "open"|"actioned"|"dismissed", handledBy? }
Indexes: { status:1, createdAt:-1 }; { reportedId:1 }

## blocks
{ blockerId, blockedId }
Indexes: { blockerId:1, blockedId:1 } unique; { blockedId:1 }

## Redis keys (ephemeral)
otp:{phone} (hash, TTL 5m) · otp:lock:{phone} · rl:{scope}:{id}
live:{eventId}:waiting:{gender} (set) · live:{eventId}:round · live:{eventId}:presence:{userId} (TTL 30s)
cache:events:list:{hash} (TTL 60s)
