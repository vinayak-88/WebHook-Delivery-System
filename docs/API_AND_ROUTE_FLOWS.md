# API_AND_ROUTE_FLOWS — Every Route and End-to-End Flow

> Source of truth: `src/app.js` + `src/routes/*.js` + `src/middlewares/*` + `src/utils/eventQueue.js`.
> Mount points: `/events`, `/webhooks`, `/dead-letters`, `/producers` (+ `/health`, `/ready`).
> All error bodies are `{ "error": ... }` (plus optional extras). `context.md` claims DLQ routes were public — **[DISCREPANCY]**: current code mounts `authenticateAdmin` on the whole DLQ router, so both are admin-only.

Global pipeline (`src/app.js`): `requestIdMiddleware` → `express.json({limit:BODY_LIMIT||'16kb', verify: req.rawBody=buf})` → per-mount rate limiter → router → 404 `{error:'Route not found'}` → error handler (`413 {error:'Payload too large',limit}` on body overflow; 500s sanitized in production; always `{error}`).

Rate limits: `/events` 100/min; `/webhooks`,`/dead-letters`,`/producers` 50/15min. Redis-backed (in-memory only when `NODE_ENV==='test'`); Redis down → `429` semantics unchanged but store errors fail closed `503 {error:'Service temporarily unavailable'}` (`passOnStoreError:false`).
Request ID: `X-Request-Id` accepted if `/^[A-Za-z0-9_-]{1,128}$/` else `randomUUID()`; set on `req.requestId` + response header; persisted to `Event.requestId`, job data, `DeliveryLog.requestId`, delivery header.

---

## 1. `POST /producers/register` — `src/routes/producer.js`, public

- **Auth:** none. **Limiter:** management (50/15min).
- **Body:** `{producerUrl:String, allowedEvents:[String]}`. Headers: none special.
- **Validation:** both required; `allowedEvents` non-empty array, each trimmed + `noun.verb` (`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`), else `400 {error, invalid?}`; `producerUrl.trim()` → `await validateNoSSRF()` (protocol http/https, https-only in production, DNS-block private ranges; `DISABLE_SSRF_CHECK=true` skips) else `400 {error}`.
- **DB:** `generateApiKey()` (32 random bytes hex) → `hashKey()` (sha256 hex) → `Producer.create({producerUrl:trimmed, apiSecret:hashed, allowedEvents:trimmed})`. `11000` → `409 {error:'A producer with this URL already exists'}`.
- **Success:** `201 {message, producerId, producerUrl, events:allowedEvents, apiKey:raw}` (raw shown once).
- **Errors:** `400` validation/SSRF; `409` duplicate; `500 {error:'Internal server error'}`.
- **Side effects:** log `Producer registered`. **Sync:** fully synchronous response (no queue).
- **Purpose/when:** one-time producer onboarding; caller stores `apiKey` for all future `x-api-key` calls.

## 2. `PATCH /producers/events` — `src/routes/producer.js`, producer-auth

- **Auth:** `authenticateProducer` (`x-api-key` → hashed → `findOne({apiSecret,isActive:true})`; missing → `401 {error:'API key required'}`; no match → `401 {error:'Invalid API key'}`; DB error → `500`).
- **Body:** `{allowedEvents:[String]}` same `noun.verb` validation as above.
- **DB:** `producer.allowedEvents=trimmed; await producer.save()`.
- **Success:** `200 {message:'Events updated successfully', allowedEvents}`.
- **Purpose:** rotate the event types a producer may emit (future `POST /events` `403`-checked against this list).

## 3. `DELETE /producers` — `src/routes/producer.js`, producer-auth

- **DB:** `producer.isActive=false; save()`. **Success:** `200 {message:'Producer deactivated successfully'}`.
- **Purpose:** soft-deactivate; key immediately stops authenticating; past `Event`s retained.

## 4. `POST /webhooks/register` — `src/routes/webhooks.js`, public

- **Body:** `{subscriberUrl, events, secret}`. **Validation:** all required (`400`); `events` non-empty array of trimmed `noun.verb` else `400 {error,invalid}`; `secret` must be string (`400`) and `>=32` chars (`400`); `subscriberUrl.trim()` → `validateNoSSRF()` else `400`.
- **DB:** `rawApiKey=generateApiKey(); hashed=hashKey(raw)` → `new Subscriber({subscriberUrl:trimmed, events:trimmed, apiSecret:hashed, secret})` (virtual setter encrypts via AES-256-GCM) → `save()`. `11000` → `409 {error:'A subscriber with this URL already exists'}`.
- **Success:** `201 {message, subscriberId, subscriberUrl, events, apiKey:raw}`.
- **Purpose:** subscriber onboarding; `secret` is the future HMAC key (encrypted at rest), `apiKey` manages the subscription.

## 5. `GET /webhooks` — `src/routes/webhooks.js`, subscriber-auth

- Returns caller profile: `{subscriberId, subscriberUrl, events, isActive, createdAt, updatedAt}` (`200`). Purpose: inspect own subscription.

## 6. `PATCH /webhooks` — `src/routes/webhooks.js`, subscriber-auth

- **Body:** `{subscriberUrl?, events?}`; rejects `subscriberId/apiSecret/signingKey` keys with `400`; requires ≥1 of url/events (`400`).
- **Validation:** url → non-empty string + `validateNoSSRF()` (`400`); events → non-empty `noun.verb` array (`400`); `save()` `11000` → `409` duplicate URL.
- **Success:** `{message:'Subscriber updated successfully', subscriberId, subscriberUrl, events}`.
- **Purpose:** change endpoint and/or subscriptions. Note: already-queued `Event.deliveryTargets` snapshots are **not** retro-updated.

## 7. `PATCH /webhooks/events` — subscriber-auth (events-only alias)

- Same events validation; `200 {message:'Events updated successfully', events}`. Kept alongside `PATCH /webhooks` for narrow updates.

## 8. `DELETE /webhooks` — subscriber-auth

- `isActive=false; save()` → `{message:'Subscriber deactivated successfully'}`. Excluded from future matching; in-flight jobs for it fail fast to DLQ via worker.

## 9. `GET /webhooks/logs` — subscriber-auth

- **Query:** `page≥1` (default 1), `limit` clamped 1–100 (default 50). **DB:** `Promise.all([DeliveryLog.find({subscriberId}).sort({createdAt:-1}).skip().limit().populate('eventId','type payload createdAt requestId'), countDocuments({subscriberId})])`.
- **Success:** `200 {subscriberId, total, page, limit, pages:ceil(total/limit), logs}`.
- **Purpose:** per-attempt audit for own deliveries (status, bodies truncated at write, `durationMs`, `requestId`).

## 10. `POST /events` — `src/routes/events.js`, producer-auth (ingest)

- **Headers:** `x-api-key` (auth); optional `Idempotency-Key`. **Body:** `{type, payload, idempotencyKey?}`.
- **Validation:** `type` non-empty string + `noun.verb` (`400`); `payload` must not be `undefined`/`null` (`400 {error:'type and payload are required'}`); `producer.allowedEvents.includes(type)` else `403`.
- **Idempotency:** key = trimmed `body.idempotencyKey || headers['idempotency-key']` (empty→null). If key: `Event.findOne({producerId, idempotencyKey})`; hit + same type + `JSON.stringify` payload equal → `200 {message:'Event already accepted (idempotent replay)', eventId, queueStatus, jobsQueued:queuedJobCount, isDuplicate:true}` (no new Event/jobs); hit + different → `409 {error:'Idempotency key already used with different event type or payload', eventId}`.
- **DB:** `Subscriber.find({events:type, isActive:true})` → `Event.create({producerId, idempotencyKey, type, payload, requestId:req.requestId||null, deliveryTargets:[{subscriberId,subscriberUrl}]})`. `11000` race with key → re-`findOne` → `200` idempotent.
- **Queue:** `await queueEventDeliveries(event)` (see `eventQueue.js`): builds `{eventId,subscriberId,subscriberUrl,payload,requestId}` per target, `assertValidDeliveryJobData`, `addBulk` with `jobId:event-<e>-subscriber-<s>`; zero targets → `queueStatus:'no_subscribers'`; OK → `queued` + `queuedJobCount` + `queueEnqueuedAt`; throws → `pending` + `lastQueueError`, rethrown.
- **Responses:** `202 {message:'Event accepted and queued for delivery', eventId, jobsQueued:N}`; `202 {message:'Event accepted — no active subscribers…', eventId, jobsQueued:0}`; `202 {message:'Event accepted; delivery queue is temporarily unavailable…', eventId, jobsQueued:0, recoveryScheduled:true}`. `500` on DB failure (nothing queued).
- **Async:** response returns after Mongo writes + `addBulk` attempt, **before** any HTTP delivery. Worker delivers later.
- **Purpose:** decoupled fan-out ingress; recovery covers queue-side failure, not validation/auth failure.

## 11. `GET /events/:id` — producer-auth (status lookup)

- **DB:** `Event.findById(id)`; `CastError` → `400 {error:'Invalid event ID format'}`; missing → `404`; `event.producerId && !equals(req.producer._id)` → `403 {error:'Access denied: you do not own this event'}` (legacy null-`producerId` events readable by any authenticated producer).
- **Success:** `{eventId, producerId|null, type, queueStatus, queuedJobCount, queueEnqueuedAt, deliveryTargetCount, deliveryTargets:[{subscriberId,subscriberUrl}], replayCount, lastReplayedAt, lastReplayJobId, requestId, createdAt, updatedAt}`.
- **Purpose:** handoff status + replay tracking. `queueStatus` is **not** delivery outcome — use `GET /webhooks/logs`.

## 12. `GET /dead-letters?limit=` — admin-auth

- **Auth:** `authenticateAdmin` (`X-Admin-Api-Key`; `401` missing/invalid, `503` unconfigured). **DB/Redis:** `deadLetterQueue.getJobs(['waiting'],0,limit-1,false)` (limit clamped 1–100, default 50) → per-job `getState()` + `{jobId,name,state,eventId,subscriberId,subscriberUrl,failureReason,failedAt,originalJobId,timestamp:ISO(job.timestamp)}`.
- **Success:** `{count, jobs}`. **Purpose:** inspect permanently failed deliveries.

## 13. `POST /dead-letters/:jobId/replay` — admin-auth

- **Lookup:** `deadLetterQueue.getJob(jobId)` → `404` if absent; missing `eventId/subscriberId/subscriberUrl/payload` → `400`.
- **Guard:** `replayJobId='replay-'+dlq.id`; `deliveryQueue.getJob(replayJobId)` active/waiting (state not `failed`/`completed`) → `409 {error, replayJobId, state}`.
- **Queue+DB:** `deliveryQueue.add('deliver',{eventId,subscriberId,subscriberUrl,payload,requestId||null},{jobId:replayJobId})` → `Event.findByIdAndUpdate(eventId,{$inc:{replayCount:1},lastReplayedAt:new Date(),lastReplayJobId})`.
- **Success:** `202 {message:'Dead-letter job replayed', deadLetterJobId, replayJobId}`. DLQ entry **retained**; `queueStatus` untouched; post-terminal re-replay enqueues anew.
- **Purpose:** manual single-job redelivery after fixing subscriber/secret.

## 14. `GET /health` — public liveness

- `200 {status:'ok', timestamp}`. No dependency checks. Purpose: process-alive probe (load balancer/K8s liveness).

## 15. `GET /ready` — public readiness

- `mongoose.connection.readyState===1` + `redisConnection.ping()` raced 2s → `redisConnected`. `200 {status:'ready',dependencies:{mongodb,redis},timestamp}` or `503 {status:'unready',...}`. Purpose: readiness gate (K8s ready / deploy checks).

## Route ordering (matters)

- `src/app.js`: `/events` → `/webhooks` → `/dead-letters` → `/producers` (distinct prefixes, no cross-shadow). Inside `webhooks.js`: `GET /` before `GET /logs` — Express matches literally so `/logs` is safe; `PATCH /` before `PATCH /events` similarly literal. `events.js`: `GET /:id` is the only GET (no `/` GET to shadow); `POST /` distinct method. `deadLetters.js`: `GET /` before `POST /:jobId/replay` (different methods). `authenticateAdmin` via `router.use()` runs before both DLQ handlers.

## End-to-end flows (condensed)

1. **Producer register:** `POST /producers/register` → validate+SSRF → key/hash → `Producer.create` → `201 apiKey` (store it).
2. **Subscriber register:** `POST /webhooks/register` → validate+SSRF → key/hash + `encrypt(secret)` → `Subscriber.create` → `201 apiKey`.
3. **Subscriber update:** `PATCH /webhooks` (or `/events`) with `x-api-key` → validate → `save()` → future events use new targets; old snapshots frozen.
4. **Deactivation:** `DELETE /webhooks` → `isActive:false` → excluded from matching; in-flight jobs fail fast to DLQ.
5. **Ingest:** `POST /events` (`x-api-key`, `{type,payload}`) → auth/type/allowedEvents → match → `Event.create` → `addBulk` → `202` (queued / no_subscribers / recoveryScheduled).
6. **Idempotent ingest:** same + `Idempotency-Key`/body key → pre-check hit → `200 isDuplicate:true` (or `409` on type/payload mismatch; `11000` race → `200`).
7. **Lookup:** `GET /events/:id` (`x-api-key`) → ownership check → handoff + replay fields.
8. **Logs:** `GET /webhooks/logs` (`x-api-key`, `page/limit`) → own `DeliveryLog`s newest-first with event populate.
9. **DLQ inspect:** `GET /dead-letters` (`X-Admin-Api-Key`) → waiting DLQ jobs formatted.
10. **DLQ replay:** `POST /dead-letters/:jobId/replay` (admin) → guard `409` → `deliveryQueue.add replay-*` + `Event $inc` → `202`.
11. **Health/readiness:** `GET /health` (alive) / `GET /ready` (mongo+redis, 200/503).
