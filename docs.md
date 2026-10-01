# DOCS — Combined reference (8 files)

> Generated from docs/*.md. Each section below is one file, separated by its name. Source of truth is current src/ implementation.


---

# FILE 1/8: docs/DATA_STORAGE.md

# DATA_STORAGE â€” Where and How Every Piece of Data Is Stored

> Source of truth: current `src/` implementation (verified 2026-09-29).
> `README.md` / `context.md` / `code.txt` were treated as secondary; discrepancies are marked **[DISCREPANCY]**.

---

## 1. MongoDB

Connection: `src/config/db.js` â†’ `mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/webhook-delivery')`.
Failure at startup logs and `process.exit(1)`. No TTL indexes anywhere. No transactions used.

### 1.1 Producer â€” `src/models/Producer.js`, collection `producers`

**Purpose:** Authorized event emitters. Owns `allowedEvents`; authenticates `POST /events` and `GET /events/:id`.

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | â€” | Primary key. |
| `producerUrl` | String trimmed | yes, unique | â€” | Identifier only, never dialed. Regex validated in schema: `/^https?:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9-].*$/` (requires dotted hostname). Route also runs `validateNoSSRF()` (DNS-based; see Â§SSRF). |
| `apiSecret` | String | yes, unique | â€” | SHA-256 hex of the 32-byte management API key. Plaintext shown once at registration, never stored. |
| `allowedEvents` | [String] | yes | â€” | Non-empty, no duplicates (two schema validators). Each entry should match `noun.verb` (enforced at route level, not schema level). |
| `isActive` | Boolean | no | `true` | `false` = deactivated; auth middleware rejects (`findOne({apiSecret, isActive:true})`). |
| `createdAt` / `updatedAt` | Date | auto | â€” | `timestamps:true`. |

**Indexes:** `_id_` (default), `producerUrl_1` unique, `apiSecret_1` unique (both from `unique:true`).
**Relationships:** `Event.producerId â†’ Producer._id` (optional, for ownership + idempotency scope).
**Created by:** `POST /producers/register` (`src/routes/producer.js` â†’ `Producer.create`).
**Read by:** `authenticateProducer` (`findOne({apiSecret:hashed,isActive:true})` on every producer-authenticated call); `GET /events/:id` ownership check uses `req.producer._id`.
**Updated by:** `PATCH /producers/events` (replaces `allowedEvents`); `DELETE /producers` (sets `isActive:false`). No hard delete anywhere.
**State fields:** `isActive`. **Append-only:** none. **Idempotency/recovery/replay:** `allowedEvents` gates `403` on ingest; `_id` scopes idempotency.
**Consistency:** duplicate `producerUrl` or `apiSecret` â†’ Mongo `11000` â†’ route returns `409`.

### 1.2 Subscriber â€” `src/models/Subscriber.js`, collection `subscribers`

**Purpose:** Webhook receivers. Owns `events` subscription list + encrypted signing secret.

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | â€” | Primary key; embedded in job IDs and logs. |
| `subscriberUrl` | String trimmed | yes, unique | â€” | Dialed by worker via Axios. Validated by `validateNoSSRF()` on register + `PATCH /webhooks`. |
| `events` | [String] | yes | â€” | Non-empty + no-duplicates validators. Multikey indexed for `find({events:type})`. |
| `signingKey` | String | yes | â€” | **AES-256-GCM encrypted** webhook secret, format `ivHex:authTagHex:ciphertextHex`. Plaintext never stored. Written only via `virtual('secret')` setter â†’ `encrypt(val)`. |
| `apiSecret` | String | yes, unique | â€” | SHA-256 hex of management API key, shown once at registration. |
| `isActive` | Boolean | no | `true` | `false` excludes from `Subscriber.find({events, isActive:true})` and causes worker fail-fast. |
| `createdAt` / `updatedAt` | Date | auto | â€” | `timestamps:true`. |

**Indexes:** `_id_`, `subscriberUrl_1` unique, `apiSecret_1` unique, `events_1` multikey (`schema.index({events:1})`).
**Relationships:** `Event.deliveryTargets[].subscriberId â†’ Subscriber._id` (snapshot, not populate); `DeliveryLog.subscriberId â†’ Subscriber._id`.
**Created by:** `POST /webhooks/register` (`new Subscriber({subscriberUrl, events, apiSecret, secret})` â†’ virtual encrypts â†’ `save()`).
**Read by:** `authenticateSubscriber`; `POST /events` matching query; worker `findById(subscriberId).select('signingKey isActive')`; `GET /webhooks`, `GET /webhooks/logs`.
**Updated by:** `PATCH /webhooks` (url and/or events), `PATCH /webhooks/events` (events only), `DELETE /webhooks` (`isActive:false`). No hard delete; no secret-rotation endpoint (historical scope note â€” correctly absent).
**State fields:** `isActive`, `events`, `subscriberUrl`. **Append-only:** none.
**Consistency:** duplicate URL â†’ `11000` â†’ `409`. Secret <32 chars rejected at route (not schema).

### 1.3 Event â€” `src/models/Event.js`, collection `events`

**Purpose:** Ingested event + delivery-target snapshot + queue-handoff state + idempotency + replay tracking.

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | â€” | Embedded in BullMQ job IDs, delivery headers (`X-Webhook-Event-Id`), logs. |
| `producerId` | ObjectId ref `Producer` | no (`required:false`, `index:true`) | â€” | Backward-compat optional. Set on all new ingests. Used for `GET /events/:id` ownership + idempotency scope. |
| `idempotencyKey` | String trimmed | no | `null` | From `Idempotency-Key` header or `idempotencyKey` body field; blank â†’ `null`. |
| `type` | String trimmed | yes | â€” | `noun.verb` enforced at route (`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`). |
| `payload` | Mixed | yes | â€” | Arbitrary JSON; must not be `null`/`undefined`. Compared with `JSON.stringify` for idempotency (key-order sensitive). |
| `deliveryTargets` | [{`subscriberId` ObjectId ref `Subscriber` req, `subscriberUrl` String req}] `_id:false` | no | `[]` | Snapshot of `Subscriber.find({events:type,isActive:true})` at ingest. Duplicate-`subscriberId` validator. Secret never snapshotted (code comment). |
| `queueStatus` | String enum | no | `'pending'` | `pending` (not yet queued / Redis failed) \| `queued` (addBulk OK) \| `no_subscribers` (zero targets). **State field.** |
| `queuedJobCount` | Number | no | `0` | N jobs handed to BullMQ; also returned as `jobsQueued`. |
| `queueEnqueuedAt` | Date | no | `null` | Stamped on successful `addBulk`. |
| `lastQueueError` | `{message:String null, code:String null, occurredAt:Date null}` | no | all null | Written when `addBulk` throws; cleared on success. |
| `replayCount` | Number | no | `0` | `$inc` on each DLQ replay. |
| `lastReplayedAt` | Date | no | `null` | Stamped on each replay. |
| `lastReplayJobId` | String | no | `null` | `replay-<dlqId>` of latest replay. |
| `requestId` | String | no | `null` | From `req.requestId` (middleware); propagated to jobs, worker logs, delivery header. |
| `createdAt` / `updatedAt` | Date | auto | â€” | `createdAt` drives recovery sort. |

**Indexes:** `_id_`; `producerId_1`; `{queueStatus:1,createdAt:1}` (recovery scan `find({queueStatus:'pending'}).sort({createdAt:1})`); `{producerId:1,idempotencyKey:1}` **unique + sparse + partialFilter `{idempotencyKey:{$ne:null}}`** (null keys excluded, unlimited keyless events).
**Created by:** `POST /events` (`Event.create` with producerId, idempotencyKey, type, payload, requestId, deliveryTargets). Duplicate-key `11000` race â†’ resolved to `200` idempotent replay.
**Read by:** `GET /events/:id` (`findById`); idempotency pre-check (`findOne({producerId,idempotencyKey})`); recovery loop (`find({queueStatus:'pending'}).sort().limit()`).
**Updated by:** `queueEventDeliveries` (`findByIdAndUpdate` â†’ queued/no_subscribers/pending + counts + error); `POST /dead-letters/:jobId/replay` (`findByIdAndUpdate` â†’ `$inc replayCount`, stamps). Never deleted.
**State fields:** `queueStatus`, `queuedJobCount`, `queueEnqueuedAt`, `lastQueueError`. **Recovery fields:** above + `deliveryTargets` (re-queued verbatim). **Idempotency fields:** `producerId+idempotencyKey`. **Replay fields:** `replayCount/lastReplayedAt/lastReplayJobId`.
**Consistency:** `queueStatus` describes **handoff to BullMQ only**, not delivery outcome (`queued` â‰  delivered â€” check `DeliveryLog`).

### 1.4 DeliveryLog â€” `src/models/DeliveryLog.js`, collection `deliverylogs`

**Purpose:** Append-only audit record per delivery **attempt** (success, retryable failure, and pre-delivery failure).

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `eventId` | ObjectId ref `Event` | yes | â€” | Populated in `GET /webhooks/logs` (`type payload createdAt requestId`). |
| `subscriberId` | ObjectId ref `Subscriber` | yes | â€” | Query key for logs endpoint. |
| `subscriberUrl` | String | yes | â€” | Denormalized dialed URL. |
| `attemptNumber` | Number | yes | â€” | `job.attemptsMade+1` (1â€“5). |
| `statusCode` | Number | no | `null` | HTTP status; `null` on network error **and** on pre-delivery failures. |
| `responseBody` | String | no | `null` | `JSON.stringify(response.data)`, truncated to `MAX_DELIVERY_RESPONSE_BODY_CHARS` (8192) + `...[truncated]`; `null` on network/pre-delivery. Bound is audit-only. |
| `success` | Boolean | yes | â€” | `true` iff 2xx. |
| `errorMessage` | String | no | `null` | `err.message` on failure; `null` on success. |
| `durationMs` | Number | no | `null` | `Date.now()` around Axios call (success + failure); `null` on pre-delivery (no HTTP). |
| `requestId` | String | no | `null` | Propagated tracing ID. |
| `createdAt` | Date | auto | â€” | Only timestamp (`timestamps:{createdAt:true,updatedAt:false}`). |

**Indexes:** `_id_`; `{subscriberId:1,createdAt:-1}` (logs query newest-first).
**Created by:** worker `persistDeliveryLog` (`DeliveryLog.create`) on every attempt. `rethrowOnFailure:false` default â€” log-write failure is logged but does not fail delivery.
**Read by:** `GET /webhooks/logs` (`find({subscriberId}).sort({createdAt:-1}).skip().limit().populate('eventId',...)` + `countDocuments`).
**Updated/deleted:** never (append-only; no update or delete path in code).
**State vs audit:** pure audit; `queueStatus` lives on `Event`, outcome lives here.

**[DISCREPANCY â€” older docs]:** stale sections of `context.md` (pre-update) claimed `Event` had no `{queueStatus,createdAt}` index, `DeliveryLog` had no `{subscriberId,createdAt}` index and had `updatedAt`, and ingestion had no idempotency. All three contradict current schema/routes and are **false** for the current implementation.

---

## 2. Redis

Redis is **not a generic cache** here. It is (a) the BullMQ broker/state store and (b) the rate-limit counter store â€” on **two separate connections**.

### 2.1 BullMQ connection â€” `src/config/redis.js`

- Client: `new Redis({host:REDIS_HOST||'localhost', port:REDIS_PORT||6379, maxRetriesPerRequest:null})` â€” `null` is **required by BullMQ**.
- Shared by: `deliveryQueue`, `deadLetterQueue` (`src/queues/deliveryQueue.js`), worker (`new Worker('webhook-delivery',...)`), recovery/ingest `addBulk`, DLQ replay `add/getJob/getJobs`.
- Behavior: unbounded offline queue + indefinite retries **by design**. During an outage BullMQ halts polling; commands wait rather than fail. This is why readiness races `ping()` against 2s.
- Queues:
  - `webhook-delivery` (main): `attempts:5`, `backoff:{type:'exponential',delay:1000}` (1sâ†’2sâ†’4sâ†’8s + jitter via worker `backoffStrategy`), `removeOnComplete:100`, `removeOnFail:200`.
  - `webhook-dead-letter` (DLQ): `removeOnComplete:500`, `removeOnFail:200`, no attempts/backoff (terminal store).
- Keys/data structures: BullMQ-owned keys (`bull:webhook-delivery:*`, `bull:webhook-dead-letter:*` â€” hashes, sorted sets for delayed/waiting, lists, streams for events). Not hand-managed; identifiable only as BullMQ internals.
- Queue state: `waiting` / `active` / `delayed` (backoff) / `completed` (kept 100) / `failed` (kept 200). DLQ inspection reads `getJobs(['waiting'])`.
- Deterministic job IDs (custom, colon-free): `event-<eventId>-subscriber-<subscriberId>`; DLQ `dead-letter-<jobId>`; replay `replay-<dlqJobId>`. Duplicate `add` with same ID while job retained â†’ BullMQ dedupes; after eviction (`removeOnComplete:100`) the same ID is treated as new.

### 2.2 Rate-limit connection â€” `src/config/rateLimitRedis.js` (dedicated, bounded)

- Client: `new Redis({host, port, enableOfflineQueue:false, maxRetriesPerRequest:1})`. Opposite tuning from BullMQ **on purpose**.
- Used only by: `express-rate-limit` + `rate-limit-redis` `RedisStore({sendCommand, prefix:'rl:events:'|'rl:mgmt:'})` in `src/app.js`.
- `sendRateLimitCommand(...args)`: waits for `ready` (`whenUsable`), races against `RATE_LIMIT_REDIS_TIMEOUT_MS` (default 1000ms); **any** failure â†’ throws generic `503 {error:'Service temporarily unavailable'}` (fail-closed, no internals leaked). `passOnStoreError:false` enforces this.
- `registerRateLimitStore` + `ready` listener: re-runs `store.init({windowMs})` on every reconnect so Lua scripts reload (covers boot-while-Redis-down without restart).
- Rate-limit state: Redis keys `rl:events:<ip>` / `rl:mgmt:<ip>` counters with window TTLs (100/min on `/events`, 50/15min on management). In `NODE_ENV==='test'` the store is `undefined` â†’ in-memory fallback (avoids open handles in Jest).
- Reconnect: default ioredis strategy kept; resumes automatically when Redis returns.

### 2.3 What happens when Redis goes down

| Path | BullMQ conn | Rate-limit conn | User-visible |
|---|---|---|---|
| `POST /events` ingress | â€” | `sendRateLimitCommand` times out â‰¤1000ms â†’ `503` fail-closed | Request **never reaches** persistence; no `Event` created. |
| `POST /events` after limiter passes, `addBulk` fails | throws â†’ `queueStatus:'pending'` + `lastQueueError` | â€” | `202 recoveryScheduled:true`; recovery loop re-queues later. |
| Worker polling | stalls; active jobs may stall â†’ reclaimed on reconnect | â€” | Deliveries pause, then resume; BullMQ retries. |
| `GET /ready` | `ping()` raced 2s â†’ `redis:'disconnected'` | â€” | `503 {status:'unready'}`. |
| Recovery loop | `addBulk` fails â†’ stays `pending` | â€” | Retried next tick. |

---

## 3. Cache / transient state â€” explicit determination

- **Application cache:** none. No response caching, no memoization of DB/Redis reads.
- **Redis as cache:** no. Redis holds **queue state + rate-limit counters**, both authoritative for their purpose, not a cache fronting MongoDB.
- **In-memory cache:** none (except `NODE_ENV==='test'` rate-limit memory store â€” test-only).
- **Session storage:** none (stateless API-key auth per request).
- **Process-local state:** `isRunning` boolean guarding the recovery tick (single process only); `isShuttingDown` guard in `app.listen` shutdown; `registeredStores[]` for rate-limit re-init; worker `workerConcurrency` const. None shared across processes.
- **Queue state (durable in Redis):** jobs (data + attemptsMade + delays), completed/failed retention windows, DLQ entries.
- **Temporary state:** BullMQ delayed-retry timers; `whenUsable` one-shot listeners; `forceExitTimer` during shutdown.
- **Recovery state (durable in MongoDB):** `Event.queueStatus:'pending'` + `lastQueueError`; scanned every `RECOVERY_INTERVAL_MS` (5000ms) in batches of `RECOVERY_BATCH_SIZE` (25).

---

## 4. Filesystem / logs

- **Winston** (`src/config/logger.js`): `level:info`, timestamped `printf`, transports = Console + `logs/error.log` (level error) + `logs/combined.log` (all). `logs/` created at require-time (`mkdir -p` equivalent). Every lifecycle event (ingest, queue, delivery success/failure, DLQ move, replay, recovery, shutdown) is logged with `eventId/subscriberId/attempt/requestId` where available.
- **Docker:** `docker-compose.yml` mounts `./logs:/app/logs` for both `app` and `worker`; `Dockerfile` runs `mkdir -p logs`. Log files survive container restart via bind mount; without the mount they live in container overlay and are lost on recreation.
- **Generated files:** only logs. No uploads, no file-backed queue, no snapshots.
- **Application data on filesystem:** none. All domain state is MongoDB + Redis.
- **Survives container recreation:** MongoDB volume `mongo_data`, Redis volume `redis_data` (both declared), host `./logs` bind mount. Everything else (node_modules layer, tmp) is ephemeral.

---

## 5. Secrets and credentials

| Secret | Lifetime / form | Storage | Notes |
|---|---|---|---|
| Producer management API key | 64-hex transient plaintext (returned once in `201`) | **Stored as SHA-256 hex** in `Producer.apiSecret` | `generateApiKey()=randomBytes(32).hex`; `hashKey()=sha256.hex`. Auth recomputes hash per request. |
| Subscriber management API key | Same as above | **Stored as SHA-256 hex** in `Subscriber.apiSecret` | Same generation/hashing; `authenticateSubscriber` same pattern. |
| Webhook signing secret | Plaintext supplied by subscriber at register (â‰¥32 chars), transient in `req.body` + `new Subscriber({secret})` | **Stored AES-256-GCM encrypted** in `Subscriber.signingKey` as `ivHex:authTagHex:ciphertextHex` | Key = `WEBHOOK_ENCRYPTION_KEY` (64-hex env). Worker `decrypt()` per delivery; secret also used as HMAC key. Never in job data, never in `Event`, never returned. |
| `WEBHOOK_ENCRYPTION_KEY` | 64-hex env var | **Environment only** (`process.env`), read per encrypt/decrypt; startup-validated (fatal in production) | Example in `.env.example`; must generate fresh for real use. |
| Admin key | Plaintext env `ADMIN_API_KEY` | **Environment only**; compared as SHA-256 hashes with `timingSafeEqual` per request | Missing header â†’ `401`; unconfigured server â†’ `503`; wrong â†’ `401`. Never persisted. |
| `X-Request-Id` | UUID v4 (or safe client value) | Transient header + `Event.requestId` + job data + `DeliveryLog.requestId` | Not a credential; tracing only. |

Distinctions: **hashed** = one-way SHA-256 (API keys, admin compare); **encrypted** = reversible AES-256-GCM (signing secrets); **plaintext transient** = registration responses, `req.body.secret`, decrypted secret inside worker delivery (freed after HMAC); **never plaintext at rest** = signing secrets and management keys.

---

## 6. Data lifecycle

### Producer: register â†’ hash â†’ auth
`POST /producers/register {producerUrl,allowedEvents}` â†’ `validateNoSSRF` â†’ `generateApiKey` â†’ `hashKey` â†’ `Producer.create({producerUrl,apiSecret:hashed,allowedEvents})` â†’ `201 {producerId,apiKey:raw}` (once) â†’ later calls send `x-api-key:raw` â†’ `authenticateProducer` hashes â†’ `findOne({apiSecret:hashed,isActive:true})` â†’ `req.producer`.

### Subscriber: secret â†’ encrypt â†’ decrypt â†’ sign
`POST /webhooks/register {subscriberUrl,events,secret}` â†’ SSRF + validators â†’ `generateApiKey/hashKey` + virtual `secretâ†’encrypt(secret)` â†’ `Subscriber.create` â†’ `201 {subscriberId,apiKey:raw}` â†’ ingest snapshots `{subscriberId,subscriberUrl}` â†’ worker `findById.select('signingKey isActive')` â†’ `decrypt(signingKey)` â†’ `generateSignature(bodyBuffer,secret,timestamp)` â†’ Axios POST with `X-Webhook-Signature`.

### Event â†’ job â†’ log â†’ DLQ/replay
`POST /events {type,payload[,idempotencyKey]}` (+`Idempotency-Key` header) â†’ auth + type/allowedEvents checks â†’ idempotency lookup â†’ `Subscriber.find({events:type,isActive:true})` â†’ `Event.create({producerId,idempotencyKey,type,payload,requestId,deliveryTargets,queueStatus:'pending'})` â†’ `queueEventDeliveries`: zero targets â†’ `no_subscribers/202`; `addBulk` OK â†’ `queued/202`; `addBulk` throws â†’ `pending/202 recoveryScheduled:true` â†’ worker `processDeliveryJob` per target â†’ `DeliveryLog.create` per attempt â†’ 2xx â†’ done; retryable â†’ BullMQ backoff; permanent/`attemptsMade>=5` â†’ `failed` listener â†’ `deadLetterQueue.add('failed-delivery',{...job.data,failureReason,originalJobId,failedAt},{jobId:'dead-letter-<id>'})` â†’ admin `POST /dead-letters/:jobId/replay` â†’ `deliveryQueue.add('deliver',{eventId,subscriberId,subscriberUrl,payload,requestId},{jobId:'replay-<dlqId>'})` + `Event $inc replayCount` (DLQ entry retained).

### Survival matrix

| Restart | MongoDB docs | BullMQ jobs/counters | Rate-limit counters | Logs | In-flight HTTP |
|---|---|---|---|---|---|
| API restart | survive | survive (Redis) | survive (Redis) | survive (file) | dropped (client retries) |
| Worker restart | survive | survive; stalled `active` reclaimed by BullMQ | n/a | survive | dropped; job retried |
| Redis restart | survive | **waiting/delayed jobs may be lost** unless Redis persisted (volume `redis_data` helps; AOF/RDB config not in repo) | counters reset if unpersisted | survive | in-flight dropped |
| MongoDB restart | survive (volume `mongo_data`) | survive | survive | survive | jobs needing `Subscriber` retry |
| Container recreate | survive via volumes/bind mount | survive via `redis_data` (subject to Redis persistence) | same | survive via `./logs` mount | dropped |

Not determinable from the current implementation: exact Redis persistence mode (no `redis.conf`/command in `docker-compose.yml`; default image settings apply).


---

# FILE 2/8: docs/API_AND_ROUTE_FLOWS.md

# API_AND_ROUTE_FLOWS â€” Every Route and End-to-End Flow

> Source of truth: `src/app.js` + `src/routes/*.js` + `src/middlewares/*` + `src/utils/eventQueue.js`.
> Mount points: `/events`, `/webhooks`, `/dead-letters`, `/producers` (+ `/health`, `/ready`).
> All error bodies are `{ "error": ... }` (plus optional extras). `context.md` claims DLQ routes were public â€” **[DISCREPANCY]**: current code mounts `authenticateAdmin` on the whole DLQ router, so both are admin-only.

Global pipeline (`src/app.js`): `requestIdMiddleware` â†’ `express.json({limit:BODY_LIMIT||'16kb', verify: req.rawBody=buf})` â†’ per-mount rate limiter â†’ router â†’ 404 `{error:'Route not found'}` â†’ error handler (`413 {error:'Payload too large',limit}` on body overflow; 500s sanitized in production; always `{error}`).

Rate limits: `/events` 100/min; `/webhooks`,`/dead-letters`,`/producers` 50/15min. Redis-backed (in-memory only when `NODE_ENV==='test'`); Redis down â†’ `429` semantics unchanged but store errors fail closed `503 {error:'Service temporarily unavailable'}` (`passOnStoreError:false`).
Request ID: `X-Request-Id` accepted if `/^[A-Za-z0-9_-]{1,128}$/` else `randomUUID()`; set on `req.requestId` + response header; persisted to `Event.requestId`, job data, `DeliveryLog.requestId`, delivery header.

---

## 1. `POST /producers/register` â€” `src/routes/producer.js`, public

- **Auth:** none. **Limiter:** management (50/15min).
- **Body:** `{producerUrl:String, allowedEvents:[String]}`. Headers: none special.
- **Validation:** both required; `allowedEvents` non-empty array, each trimmed + `noun.verb` (`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`), else `400 {error, invalid?}`; `producerUrl.trim()` â†’ `await validateNoSSRF()` (protocol http/https, https-only in production, DNS-block private ranges; `DISABLE_SSRF_CHECK=true` skips) else `400 {error}`.
- **DB:** `generateApiKey()` (32 random bytes hex) â†’ `hashKey()` (sha256 hex) â†’ `Producer.create({producerUrl:trimmed, apiSecret:hashed, allowedEvents:trimmed})`. `11000` â†’ `409 {error:'A producer with this URL already exists'}`.
- **Success:** `201 {message, producerId, producerUrl, events:allowedEvents, apiKey:raw}` (raw shown once).
- **Errors:** `400` validation/SSRF; `409` duplicate; `500 {error:'Internal server error'}`.
- **Side effects:** log `Producer registered`. **Sync:** fully synchronous response (no queue).
- **Purpose/when:** one-time producer onboarding; caller stores `apiKey` for all future `x-api-key` calls.

## 2. `PATCH /producers/events` â€” `src/routes/producer.js`, producer-auth

- **Auth:** `authenticateProducer` (`x-api-key` â†’ hashed â†’ `findOne({apiSecret,isActive:true})`; missing â†’ `401 {error:'API key required'}`; no match â†’ `401 {error:'Invalid API key'}`; DB error â†’ `500`).
- **Body:** `{allowedEvents:[String]}` same `noun.verb` validation as above.
- **DB:** `producer.allowedEvents=trimmed; await producer.save()`.
- **Success:** `200 {message:'Events updated successfully', allowedEvents}`.
- **Purpose:** rotate the event types a producer may emit (future `POST /events` `403`-checked against this list).

## 3. `DELETE /producers` â€” `src/routes/producer.js`, producer-auth

- **DB:** `producer.isActive=false; save()`. **Success:** `200 {message:'Producer deactivated successfully'}`.
- **Purpose:** soft-deactivate; key immediately stops authenticating; past `Event`s retained.

## 4. `POST /webhooks/register` â€” `src/routes/webhooks.js`, public

- **Body:** `{subscriberUrl, events, secret}`. **Validation:** all required (`400`); `events` non-empty array of trimmed `noun.verb` else `400 {error,invalid}`; `secret` must be string (`400`) and `>=32` chars (`400`); `subscriberUrl.trim()` â†’ `validateNoSSRF()` else `400`.
- **DB:** `rawApiKey=generateApiKey(); hashed=hashKey(raw)` â†’ `new Subscriber({subscriberUrl:trimmed, events:trimmed, apiSecret:hashed, secret})` (virtual setter encrypts via AES-256-GCM) â†’ `save()`. `11000` â†’ `409 {error:'A subscriber with this URL already exists'}`.
- **Success:** `201 {message, subscriberId, subscriberUrl, events, apiKey:raw}`.
- **Purpose:** subscriber onboarding; `secret` is the future HMAC key (encrypted at rest), `apiKey` manages the subscription.

## 5. `GET /webhooks` â€” `src/routes/webhooks.js`, subscriber-auth

- Returns caller profile: `{subscriberId, subscriberUrl, events, isActive, createdAt, updatedAt}` (`200`). Purpose: inspect own subscription.

## 6. `PATCH /webhooks` â€” `src/routes/webhooks.js`, subscriber-auth

- **Body:** `{subscriberUrl?, events?}`; rejects `subscriberId/apiSecret/signingKey` keys with `400`; requires â‰¥1 of url/events (`400`).
- **Validation:** url â†’ non-empty string + `validateNoSSRF()` (`400`); events â†’ non-empty `noun.verb` array (`400`); `save()` `11000` â†’ `409` duplicate URL.
- **Success:** `{message:'Subscriber updated successfully', subscriberId, subscriberUrl, events}`.
- **Purpose:** change endpoint and/or subscriptions. Note: already-queued `Event.deliveryTargets` snapshots are **not** retro-updated.

## 7. `PATCH /webhooks/events` â€” subscriber-auth (events-only alias)

- Same events validation; `200 {message:'Events updated successfully', events}`. Kept alongside `PATCH /webhooks` for narrow updates.

## 8. `DELETE /webhooks` â€” subscriber-auth

- `isActive=false; save()` â†’ `{message:'Subscriber deactivated successfully'}`. Excluded from future matching; in-flight jobs for it fail fast to DLQ via worker.

## 9. `GET /webhooks/logs` â€” subscriber-auth

- **Query:** `pageâ‰¥1` (default 1), `limit` clamped 1â€“100 (default 50). **DB:** `Promise.all([DeliveryLog.find({subscriberId}).sort({createdAt:-1}).skip().limit().populate('eventId','type payload createdAt requestId'), countDocuments({subscriberId})])`.
- **Success:** `200 {subscriberId, total, page, limit, pages:ceil(total/limit), logs}`.
- **Purpose:** per-attempt audit for own deliveries (status, bodies truncated at write, `durationMs`, `requestId`).

## 10. `POST /events` â€” `src/routes/events.js`, producer-auth (ingest)

- **Headers:** `x-api-key` (auth); optional `Idempotency-Key`. **Body:** `{type, payload, idempotencyKey?}`.
- **Validation:** `type` non-empty string + `noun.verb` (`400`); `payload` must not be `undefined`/`null` (`400 {error:'type and payload are required'}`); `producer.allowedEvents.includes(type)` else `403`.
- **Idempotency:** key = trimmed `body.idempotencyKey || headers['idempotency-key']` (emptyâ†’null). If key: `Event.findOne({producerId, idempotencyKey})`; hit + same type + `JSON.stringify` payload equal â†’ `200 {message:'Event already accepted (idempotent replay)', eventId, queueStatus, jobsQueued:queuedJobCount, isDuplicate:true}` (no new Event/jobs); hit + different â†’ `409 {error:'Idempotency key already used with different event type or payload', eventId}`.
- **DB:** `Subscriber.find({events:type, isActive:true})` â†’ `Event.create({producerId, idempotencyKey, type, payload, requestId:req.requestId||null, deliveryTargets:[{subscriberId,subscriberUrl}]})`. `11000` race with key â†’ re-`findOne` â†’ `200` idempotent.
- **Queue:** `await queueEventDeliveries(event)` (see `eventQueue.js`): builds `{eventId,subscriberId,subscriberUrl,payload,requestId}` per target, `assertValidDeliveryJobData`, `addBulk` with `jobId:event-<e>-subscriber-<s>`; zero targets â†’ `queueStatus:'no_subscribers'`; OK â†’ `queued` + `queuedJobCount` + `queueEnqueuedAt`; throws â†’ `pending` + `lastQueueError`, rethrown.
- **Responses:** `202 {message:'Event accepted and queued for delivery', eventId, jobsQueued:N}`; `202 {message:'Event accepted â€” no active subscribersâ€¦', eventId, jobsQueued:0}`; `202 {message:'Event accepted; delivery queue is temporarily unavailableâ€¦', eventId, jobsQueued:0, recoveryScheduled:true}`. `500` on DB failure (nothing queued).
- **Async:** response returns after Mongo writes + `addBulk` attempt, **before** any HTTP delivery. Worker delivers later.
- **Purpose:** decoupled fan-out ingress; recovery covers queue-side failure, not validation/auth failure.

## 11. `GET /events/:id` â€” producer-auth (status lookup)

- **DB:** `Event.findById(id)`; `CastError` â†’ `400 {error:'Invalid event ID format'}`; missing â†’ `404`; `event.producerId && !equals(req.producer._id)` â†’ `403 {error:'Access denied: you do not own this event'}` (legacy null-`producerId` events readable by any authenticated producer).
- **Success:** `{eventId, producerId|null, type, queueStatus, queuedJobCount, queueEnqueuedAt, deliveryTargetCount, deliveryTargets:[{subscriberId,subscriberUrl}], replayCount, lastReplayedAt, lastReplayJobId, requestId, createdAt, updatedAt}`.
- **Purpose:** handoff status + replay tracking. `queueStatus` is **not** delivery outcome â€” use `GET /webhooks/logs`.

## 12. `GET /dead-letters?limit=` â€” admin-auth

- **Auth:** `authenticateAdmin` (`X-Admin-Api-Key`; `401` missing/invalid, `503` unconfigured). **DB/Redis:** `deadLetterQueue.getJobs(['waiting'],0,limit-1,false)` (limit clamped 1â€“100, default 50) â†’ per-job `getState()` + `{jobId,name,state,eventId,subscriberId,subscriberUrl,failureReason,failedAt,originalJobId,timestamp:ISO(job.timestamp)}`.
- **Success:** `{count, jobs}`. **Purpose:** inspect permanently failed deliveries.

## 13. `POST /dead-letters/:jobId/replay` â€” admin-auth

- **Lookup:** `deadLetterQueue.getJob(jobId)` â†’ `404` if absent; missing `eventId/subscriberId/subscriberUrl/payload` â†’ `400`.
- **Guard:** `replayJobId='replay-'+dlq.id`; `deliveryQueue.getJob(replayJobId)` active/waiting (state not `failed`/`completed`) â†’ `409 {error, replayJobId, state}`.
- **Queue+DB:** `deliveryQueue.add('deliver',{eventId,subscriberId,subscriberUrl,payload,requestId||null},{jobId:replayJobId})` â†’ `Event.findByIdAndUpdate(eventId,{$inc:{replayCount:1},lastReplayedAt:new Date(),lastReplayJobId})`.
- **Success:** `202 {message:'Dead-letter job replayed', deadLetterJobId, replayJobId}`. DLQ entry **retained**; `queueStatus` untouched; post-terminal re-replay enqueues anew.
- **Purpose:** manual single-job redelivery after fixing subscriber/secret.

## 14. `GET /health` â€” public liveness

- `200 {status:'ok', timestamp}`. No dependency checks. Purpose: process-alive probe (load balancer/K8s liveness).

## 15. `GET /ready` â€” public readiness

- `mongoose.connection.readyState===1` + `redisConnection.ping()` raced 2s â†’ `redisConnected`. `200 {status:'ready',dependencies:{mongodb,redis},timestamp}` or `503 {status:'unready',...}`. Purpose: readiness gate (K8s ready / deploy checks).

## Route ordering (matters)

- `src/app.js`: `/events` â†’ `/webhooks` â†’ `/dead-letters` â†’ `/producers` (distinct prefixes, no cross-shadow). Inside `webhooks.js`: `GET /` before `GET /logs` â€” Express matches literally so `/logs` is safe; `PATCH /` before `PATCH /events` similarly literal. `events.js`: `GET /:id` is the only GET (no `/` GET to shadow); `POST /` distinct method. `deadLetters.js`: `GET /` before `POST /:jobId/replay` (different methods). `authenticateAdmin` via `router.use()` runs before both DLQ handlers.

## End-to-end flows (condensed)

1. **Producer register:** `POST /producers/register` â†’ validate+SSRF â†’ key/hash â†’ `Producer.create` â†’ `201 apiKey` (store it).
2. **Subscriber register:** `POST /webhooks/register` â†’ validate+SSRF â†’ key/hash + `encrypt(secret)` â†’ `Subscriber.create` â†’ `201 apiKey`.
3. **Subscriber update:** `PATCH /webhooks` (or `/events`) with `x-api-key` â†’ validate â†’ `save()` â†’ future events use new targets; old snapshots frozen.
4. **Deactivation:** `DELETE /webhooks` â†’ `isActive:false` â†’ excluded from matching; in-flight jobs fail fast to DLQ.
5. **Ingest:** `POST /events` (`x-api-key`, `{type,payload}`) â†’ auth/type/allowedEvents â†’ match â†’ `Event.create` â†’ `addBulk` â†’ `202` (queued / no_subscribers / recoveryScheduled).
6. **Idempotent ingest:** same + `Idempotency-Key`/body key â†’ pre-check hit â†’ `200 isDuplicate:true` (or `409` on type/payload mismatch; `11000` race â†’ `200`).
7. **Lookup:** `GET /events/:id` (`x-api-key`) â†’ ownership check â†’ handoff + replay fields.
8. **Logs:** `GET /webhooks/logs` (`x-api-key`, `page/limit`) â†’ own `DeliveryLog`s newest-first with event populate.
9. **DLQ inspect:** `GET /dead-letters` (`X-Admin-Api-Key`) â†’ waiting DLQ jobs formatted.
10. **DLQ replay:** `POST /dead-letters/:jobId/replay` (admin) â†’ guard `409` â†’ `deliveryQueue.add replay-*` + `Event $inc` â†’ `202`.
11. **Health/readiness:** `GET /health` (alive) / `GET /ready` (mongo+redis, 200/503).


---

# FILE 3/8: docs/MIDDLEWARE.md

# MIDDLEWARE â€” Every Middleware, Behavior, and Route Map

> Source of truth: `src/middlewares/*.js` + `src/app.js` wiring. 4 middleware files + 2 app-level functions (rate limiters, 404/error handlers).

---

## 1. `requestId.js` â€” `requestIdMiddleware(req,res,next)`

- **Purpose/why:** distributed tracing across API â†’ Mongo (`Event.requestId`) â†’ BullMQ job â†’ worker logs â†’ delivery header â†’ `DeliveryLog.requestId`.
- **Registered:** first in `src/app.js` (`app.use(requestIdMiddleware)`), so every route, 404, and error handler sees `req.requestId` and every response carries `X-Request-Id`.
- **Inputs:** `req.headers['x-request-id']`. Accepts iff `/^[A-Za-z0-9_-]{1,128}$/`; else `crypto.randomUUID()`. Unsafe/overlong client values are replaced, not rejected.
- **Mutates:** `req.requestId`; `res.setHeader('X-Request-Id', id)`.
- **`next()`:** always called (never short-circuits). **Errors:** none (cannot fail).
- **Security:** allowlist prevents header-injection/log-forgery via exotic IDs; length cap bounds storage.

## 2. `authenticateProducer(req,res,next)` â€” `src/middlewares/authenticateProducer.js`

- **Purpose:** gate all producer operations (`/events*`, `/producers` PATCH/DELETE) to the owning active producer.
- **Reads:** `req.headers['x-api-key']`. Missing â†’ `401 {error:'API key required'}` (no DB hit).
- **Logic:** `hashKey(apiKey)` (SHA-256) â†’ `Producer.findOne({apiSecret:hashed, isActive:true})`. No match (wrong key or `isActive:false`) â†’ `401 {error:'Invalid API key'}`. Match â†’ `req.producer=doc; next()`. DB throw â†’ `500 {error:'Internal server error'}`.
- **Security:** hash-compare (no plaintext lookup); inactive keys fail closed; identical shape to subscriber auth but different collection (keys not interchangeable).
- **Downstream:** `POST /events` uses `req.producer._id` (ownership/idempotency) + `allowedEvents`; `GET /events/:id` ownership check; producer PATCH/DELETE mutate `req.producer`.

## 3. `authenticateSubscriber(req,res,next)` â€” `src/middlewares/authenticateSubscriber.js`

- **Purpose:** gate subscriber self-management + private logs to the owning active subscriber.
- **Logic:** identical to producer auth but `Subscriber.findOne({apiSecret:hashed, isActive:true})` â†’ `req.subscriber`. Same 401/500 shapes.
- **Downstream:** `GET/PATCH/DELETE /webhooks`, `GET /webhooks/logs` (query scoped to `req.subscriber._id`).

## 4. `authenticateAdmin(req,res,next)` â€” `src/middlewares/authenticateAdmin.js`

- **Purpose:** gate DLQ inspection/replay to operators. Only middleware using constant-time compare.
- **Reads:** `req.headers['x-admin-api-key']` (Express lowercases). Missing â†’ `401 {error:'Admin API key required (X-Admin-Api-Key header)'}`.
- **Logic:** reads `process.env.ADMIN_API_KEY` **per request** (no module-load caching â€” test/reload safe). Empty/unset â†’ `503 {error:'Admin authentication is not configured on this server'}` (fail-closed, distinct from 401). Else `timingSafeEqual(sha256(provided), sha256(configured))` in try/catch â†’ mismatch â†’ `401 {error:'Invalid admin API key'}`; match â†’ `next()`.
- **Security:** SHA-256 + `timingSafeEqual` blocks timing side-channels; 503-vs-401 distinguishes misconfiguration from wrong key without leaking the key.

## 5. Rate limiting â€” `eventLimiter`, `managementLimiter` (`src/app.js` + `src/config/rateLimitRedis.js`)

- **What:** `express-rate-limit` + `rate-limit-redis` `RedisStore({sendCommand:sendRateLimitCommand, prefix:'rl:events:'|'rl:mgmt:'})`, `passOnStoreError:false`.
- **Where:** `app.use('/events',eventLimiter,eventRoutes)` (100/min); `app.use('/webhooks'|'/dead-letters'|'/producers',managementLimiter,â€¦)` (50/15min). Runs **after** request-ID, **before** auth/validation (abusive traffic rejected before DB work).
- **`sendRateLimitCommand`:** `whenUsable()` (immediate if `status==='ready'`, else one-shot `ready`/`close` listeners) raced against `RATE_LIMIT_REDIS_TIMEOUT_MS` (1000ms); any failure â†’ generic `503 {error:'Service temporarily unavailable'}`. `enableOfflineQueue:false` + `maxRetriesPerRequest:1` on this connection (vs BullMQ's `null`/unbounded) so requests fail fast instead of hanging. `registerRateLimitStore` + `ready`-listener re-`init()`s Lua scripts on reconnect (boot-while-Redis-down safe).
- **Test env:** `NODE_ENV==='test'` â†’ `store:undefined` â†’ in-memory (avoids open handles in Jest).
- **Behavior:** over-limit â†’ `429 {error:'Too many requests, slow down'}`; Redis down â†’ `503` fail-closed (never lets traffic through un-limited).

## 6. Body parser + 404 + global error handler (`src/app.js`)

- **`express.json({limit:BODY_LIMIT||'16kb', verify:(req,res,buf)=>req.rawBody=buf})`:** rejects oversize before routes; preserves raw bytes (used by mock subscriber/HMAC flows; API itself signs worker-side buffers).
- **404:** `app.use((req,res)=>res.status(404).json({error:'Route not found'}))` after all mounts.
- **Error handler:** `(err,req,res,next)`: `entity.too.large`/413 â†’ `413 {error:'Payload too large',limit:BODY_LIMIT}`; else logs with `requestId`, `statusCode=err.statusCode||500`, production 500s sanitized to `'Internal server error'` (no stacks/driver messages), always `{error:message}`.

## Differences at a glance

| Concern | Producer auth | Subscriber auth | Admin auth | Request ID | Rate limit |
|---|---|---|---|---|---|
| Header | `x-api-key` | `x-api-key` | `x-admin-api-key` | `x-request-id` | none (IP-based) |
| Store | `Producer` | `Subscriber` | env `ADMIN_API_KEY` | none | Redis counters |
| Compare | sha256 equality via query | sha256 equality via query | sha256 + `timingSafeEqual` | allowlist/UUID | counters |
| Inactive | `401` | `401` | n/a | n/a | n/a |
| Attaches | `req.producer` | `req.subscriber` | nothing | `req.requestId` | nothing |

## Route â†’ middleware execution map

| Route | Order (after global JSON) |
|---|---|
| `POST /producers/register` | requestId â†’ mgmtLimiter â†’ handler |
| `PATCH/DELETE /producers*` | requestId â†’ mgmtLimiter â†’ authenticateProducer â†’ handler |
| `POST /webhooks/register` | requestId â†’ mgmtLimiter â†’ handler |
| `GET/PATCH/DELETE /webhooks*`, `GET /webhooks/logs` | requestId â†’ mgmtLimiter â†’ authenticateSubscriber â†’ handler |
| `POST /events`, `GET /events/:id` | requestId â†’ eventLimiter â†’ authenticateProducer â†’ handler |
| `GET /dead-letters`, `POST /dead-letters/:jobId/replay` | requestId â†’ mgmtLimiter â†’ authenticateAdmin (`router.use`) â†’ handler |
| `GET /health`, `GET /ready` | requestId only (no limiter/auth) |
| Unknown | requestId â†’ 404 |
| Throw/next(err) anywhere | â†’ global error handler |


---

# FILE 4/8: docs/SRC_CODE_REFERENCE.md

# SRC_CODE_REFERENCE â€” Every File Under `src/`

> 44 JS files. Source of truth: current implementation. Purpose/Imports/Functions/Constants/Flow/Failure/Security/Relationships per file. Tests summarized by protected behavior + mocks.

---

## `src/app.js` â€” Express entrypoint, middleware wiring, health/ready, shutdown

**Purpose:** builds `app`, wires global middleware â†’ limiters â†’ routers, exposes `/health` `/ready`, starts server + recovery loop, graceful shutdown.
**Imports:** dotenv, express, mongoose (readyState + close), express-rate-limit + rate-limit-redis RedisStore, `config/db` (connectDB), `config/redis` (BullMQ conn, ping), `config/rateLimitRedis` (bounded conn, sendCommand, register), `config/logger`, 4 routers, `middlewares/requestId`, `utils/eventQueue:startPendingEventRecovery`, `queues/deliveryQueue:deliveryQueue` (close).
**Functions:** `createRedisStore(prefix,windowMs)` â€” testâ†’undefined else RedisStore+register; `shutdown(signal)` (closure in `listen` cb: `server.close()`, clear recovery timer, `deliveryQueue.close()`, `redis.quit()`, `rateLimit.quit()`, `mongoose.close()`, `SHUTDOWN_TIMEOUT_MS` 10s force-exit); `startServer()` â€” `connectDB()`, `listen(PORT)`, start recovery, arm SIGTERM/SIGINT. `GET /health`, `GET /ready` (mongo readyState + ping race 2s â†’ 200/503), 404, error handler (413 + sanitized 500s).
**Constants:** `BODY_LIMIT` 16kb, limiter windows 60s/15min + max 100/50, `READY_REDIS_TIMEOUT_MS` 2000, `SHUTDOWN_TIMEOUT_MS` 10000.
**Flow:** dotenv â†’ validate `WEBHOOK_ENCRYPTION_KEY` (fatal in production) â†’ requestId â†’ json(rawBody) â†’ limiter â†’ router â†’ 404 â†’ errors. `require.main===module` gates listen; exports `app` for tests.
**Failure:** DB connect fail â†’ exit 1; Redis down â†’ limiters 503, ready 503; oversize â†’ 413.
**Security:** fail-closed limiters, sanitized prod errors, bounded Redis, rawBody preserved.
**Relationships:** mounts all routers/middlewares; owns recovery timer + shutdown.

## `src/config/db.js` â€” `connectDB()`

Connects `MONGODB_URI||localhost/webhook-delivery` via mongoose; logs; `process.exit(1)` on failure. Called by `app.js` + worker. No pooling options set.

## `src/config/logger.js` â€” Winston `logger`

`logs/` resolved from `process.cwd()` + created; format timestamp+errors+printf; transports Console + `logs/error.log`(error) + `logs/combined.log`. Imported everywhere.

## `src/config/redis.js` â€” `redisConnection` (BullMQ/shared)

`new Redis({host,port,maxRetriesPerRequest:null})` (BullMQ-required). `connect`/`error` logs. Shared by queues, worker, `GET /ready` ping, `shutdown quit()`.

## `src/config/rateLimitRedis.js` â€” bounded rate-limit Redis

**Purpose:** request-time-safe Redis. `RATE_LIMIT_REDIS_TIMEOUT_MS` 1000. `rateLimitRedisConnection=new Redis({host,port,enableOfflineQueue:false,maxRetriesPerRequest:1})` (fails fast, auto-reconnects). `serviceUnavailable()` â†’ 503 Error. `registeredStores[]` + `registerRateLimitStore(store,windowMs)` + `ready`-listener re-`init()` (Lua reload). `whenUsable()` (immediate if ready else once-ready/close). `sendRateLimitCommand(...args)` = `race(whenUsable().then(call), timeout)` â†’ 503 on any failure, clears timer. Used only by `app.js` limiters.

## `src/middlewares/requestId.js` â€” `requestIdMiddleware`

Accepts `x-request-id` iff safe `/^[A-Za-z0-9_-]{1,128}$/` else `randomUUID()`; sets `req.requestId` + response header; always `next()`. First middleware globally.

## `src/middlewares/authenticateProducer.js` â€” `authenticateProducer`

`x-api-key` â†’ `hashKey` â†’ `Producer.findOne({apiSecret:hashed,isActive:true})` â†’ `req.producer` or 401/500. Used by `/events*`, producer PATCH/DELETE.

## `src/middlewares/authenticateSubscriber.js` â€” `authenticateSubscriber`

Same shape on `Subscriber` â†’ `req.subscriber`. Used by `/webhooks*` management + logs.

## `src/middlewares/authenticateAdmin.js` â€” `authenticateAdmin`

`x-admin-api-key`; per-request `ADMIN_API_KEY`; unsetâ†’503; `timingSafeEqual(sha256(p),sha256(c))` â†’ 401 or `next()`. `router.use()` on DLQ router.

## `src/models/Producer.js` â€” `Producer`

Schema: `producerUrl` (trim, unique, regex dotted-host), `apiSecret` (unique), `allowedEvents` ([String] non-empty + no-dup validators), `isActive` (default true), timestamps. No extra indexes. Created by producer register; read by auth + ingest; updated by PATCH events / DELETE deactivate.

## `src/models/Subscriber.js` â€” `Subscriber`

Schema: `subscriberUrl` (trim, unique), `events` (non-empty + no-dup), `signingKey` (required; encrypted `iv:tag:ct`), `apiSecret` (unique), `isActive`, timestamps; `index({events:1})` multikey; `virtual('secret').set(v=>signingKey=encrypt(v))`. Created by webhook register; read by auth/match/worker; updated by PATCHÃ—2/DELETE.

## `src/models/Event.js` â€” `Event`

Fields: `producerId` (ObjectId ref Producer, optional, indexed), `idempotencyKey` (trim, null), `type`, `payload` (Mixed), `deliveryTargets` ([{subscriberId ref, subscriberUrl}] `_id:false`, no-dup validator), `queueStatus` enum pending/queued/no_subscribers, `queuedJobCount`, `queueEnqueuedAt`, `lastQueueError{message,code,occurredAt}`, `replayCount`, `lastReplayedAt`, `lastReplayJobId`, `requestId`, timestamps. Indexes: `{queueStatus,createdAt}`, `{producerId,idempotencyKey}` unique sparse partial `$ne:null`. Created by ingest; read by lookup/idempotency/recovery; updated by `queueEventDeliveries` + DLQ replay.

## `src/models/DeliveryLog.js` â€” `DeliveryLog`

Fields: `eventId`, `subscriberId`, `subscriberUrl`, `attemptNumber`, `statusCode` (null), `responseBody` (null, truncated at write), `success`, `errorMessage` (null), `durationMs` (null), `requestId` (null); `timestamps:{createdAt:true,updatedAt:false}` (append-only); `index({subscriberId,createdAt:-1})`. Created per attempt by worker; read by logs endpoint; never updated/deleted.

## `src/routes/producer.js` â€” `/producers` router

`EVENT_TYPE_RE` noun.verb. `POST /register` (public: validate, `validateNoSSRF`, key/hash, `Producer.create`, 201/400/409/500). `PATCH /events` (producer-auth: validate, save, 200). `DELETE /` (producer-auth: `isActive=false`). Imports Producer, logger, auth, apiKey, ssrf.

## `src/routes/webhooks.js` â€” `/webhooks` router

`SECRET_MIN_LENGTH` 32, `EVENT_TYPE_RE`. `GET /` (profile). `POST /register` (public: validate secret/events/SSRF, key/hash, virtual-encrypt, save, 201/409). `PATCH /` (url and/or events, rejects id/secret keys, SSRF, 409). `PATCH /events` (events-only). `DELETE /` (deactivate). `GET /logs` (page/limit, `find+sort+skip+limit+populate` + count â†’ `{subscriberId,total,page,limit,pages,logs}`). All but register subscriber-authed.

## `src/routes/events.js` â€” `/events` router

`EVENT_TYPE_RE`. `GET /:id` (producer-auth: `findById`, 400 CastError, 404, 403 ownership, returns handoff+replay+targets). `POST /` (producer-auth: require type/payload, noun.verb, allowedEvents 403, idempotency pre-check 200/409, `Subscriber.find`, `Event.create` with 11000-race â†’200, `queueEventDeliveries` â†’ 202 queued/no_subscribers/recoveryScheduled, 500 on DB fail).

## `src/routes/deadLetters.js` â€” `/dead-letters` router (admin)

`router.use(authenticateAdmin)`. `formatJob(job)` (id,name,`getState()`,event/sub/url,failureReason,failedAt,originalJobId,ISO timestamp). `GET /` (limit 1â€“100 def 50, `getJobs(['waiting'])`, `{count,jobs}`). `POST /:jobId/replay` (`getJob` 404, missing-data 400, `replay-<id>` + active-guard 409, `deliveryQueue.add deliver`, `Event $inc replayCount`, 202; DLQ retained).

## `src/queues/deliveryQueue.js` â€” `deliveryQueue`, `deadLetterQueue`, `MAX_DELIVERY_ATTEMPTS=5`

`Queue('webhook-delivery',{connection:redisConnection, defaultJobOptions:{attempts:5,backoff:{exponential,1000},removeOnComplete:100,removeOnFail:200}})`; `Queue('webhook-dead-letter',{â€¦,removeOnComplete:500,removeOnFail:200})`. Imported by ingest, recovery, replay, worker, shutdown.

## `src/workers/deliveryWorker.js` â€” `processDeliveryJob`, worker, DLQ escalation

**Imports:** dotenv, BullMQ `Worker/UnrecoverableError`, axios, redis conn, db, logger, DeliveryLog, Subscriber, queues, `hmac:generateSignature`, `encryption:decrypt`, `ssrf:validateNoSSRF`, `jobSchema:assertValidDeliveryJobData`, `retryPolicy:isRetryableError`.
**Consts:** `RETRY_JITTER_MS` 500, `WEBHOOK_TIMEOUT_MS` 5000, `MAX_RESPONSE_BODY_CHARS` 8192 + `...[truncated]`, `workerConcurrency` (env>0 else 5).
**Functions:** `truncateResponseBody(s)`; `buildLogPayload(...)`; `persistDeliveryLog(payload,{rethrowOnFailure:false})` (logs failure, optional rethrow); `processDeliveryJob(job)` â€” assert schema â†’ SSRF â†’ `Subscriber.findById.select` (DB throwâ†’retry) â†’ missing/inactiveâ†’pre-delivery log + `UnrecoverableError` â†’ decrypt+`Buffer(JSON(payload))`+`Date.now()`+`generateSignature` (throwâ†’pre-delivery log + Unrecoverable) â†’ `axios.post(url,bodyBuffer,{headers:Content-Type/X-Webhook-Signature/X-Webhook-Event-Id/X-Webhook-Attempt/X-timestamp/[X-Request-Id],timeout,maxRedirects:0})` â†’ success log + `{statusCode,eventId,subscriberId,attemptNumber}` (never raw Axios) / catch: duration+status/body/errorMessage â†’ failure log â†’ `!isRetryableErrorâ†’UnrecoverableError` else rethrow; `shutdown(signal)` â†’ `worker.close()`.
**Worker:** `new Worker('webhook-delivery',processDeliveryJob,{connection,concurrency,settings:{backoffStrategy:attemptsMade=>round(1000*2^(n-1)+rand*jitter)}})`; `on('failed')` â€” permanent (`instanceof UnrecoverableError`) or `attemptsMade>=MAX` â†’ `deadLetterQueue.add('failed-delivery',{...data,failureReason,originalJobId,failedAt:ISO},{jobId:'dead-letter-'+id})`; `on('completed'/'error')` logs; `startWorker()` connects DB; `require.main` gate; exports worker+handler+truncate+const.
**Failure/security:** transientâ†’retry, permanentâ†’DLQ immediately; pre-delivery logs have null status/body/duration; SSRF+no-redirect+timeout+jitter; secrets never in job data.

## `src/utils/apiKey.js` â€” `generateApiKey()`, `hashKey(key)`

`randomBytes(32).hex` (64 hex); `sha256.hex`. Used by both registers + both auth middlewares.

## `src/utils/encryption.js` â€” AES-256-GCM `encrypt/decrypt`, `getEncryptionKey()`

`ALGORITHM aes-256-gcm`, `IV 12B`, `TAG 16B`. `getEncryptionKey()` reads `WEBHOOK_ENCRYPTION_KEY`, requires 64-hex else throw. `encrypt(plaintext)` â†’ `iv:tag:ct` hex (random IV). `decrypt(stored)` validates 3-part hex + lengths, `createDecipheriv`+`setAuthTag`, throws on tamper/wrong key; never treats undecryptable as plaintext (worker fail-fast). Used by Subscriber virtual + worker.

## `src/utils/hmac.js` â€” `generateSignature(payload,secret,timestamp)`, `verifySignature(payload,secret,timestamp,received)`

`generate`: Buffer(payload or `JSON.stringify`) + `update(String(ts)+'.')` + HMAC-sha256 hex. `verify`: 5-min `abs(now-Number(ts))` window (NaNâ†’false) â†’ expected â†’ `timingSafeEqual(hex,hex)` try/catch â†’ bool. Used by worker (sign) + mock subscriber (verify).

## `src/utils/jobSchema.js` â€” `validateDeliveryJobData(data)`, `assertValidDeliveryJobData(data)`

Checks: object; `eventId/subscriberId` 24-hex strings; `subscriberUrl` `^https?://.+`; `payload` not null/undef; optional `requestId` non-empty string. Returns `{valid,errors}` / throws `Invalid delivery job data: â€¦`. Called producer-side (`buildDeliveryJobs`) + consumer-side (worker entry).

## `src/utils/retryPolicy.js` â€” `isRetryableError(err)`

No-response (no `err.response.status`) â†’ true; 408/429 â†’ true; 500â€“599 â†’ true; else false (all other 4xx permanent). Used by worker to choose rethrow vs `UnrecoverableError`.

## `src/utils/ssrf.js` â€” `validateNoSSRF(url)`, `isBlockedIP(ip)` (+ helpers)

`BLOCKED_CIDRS` (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. metadata, 0/8, 255.255.255.255/32, 192.0.2/24, 198.51.100/24, 203.0.113/24) + `BLOCKED_IPV6_CIDRS` (::1/128, fe80/10, fc00/7, ::/128, ::ffff:0:0/96). Helpers `parseCIDR/ipToInt/ipv4InCIDR/parseIPv6CIDR/expandIPv6/ipv6InCIDR`. `isBlockedIP` handles v4/v6 + mapped. `validateNoSSRF`: `DISABLE_SSRF_CHECK==='true'`â†’return; `new URL` (â†’Invalid URL); protocol http/https (https-only in production); raw-IPâ†’block check; `localhost*` hostnames blocked; else `resolve4+resolve6` (allSettled, â‰¥1 required) â†’ every addr block-checked. Used by producer/subscriber registers, PATCH url, worker pre-dial. TOCTOU (DNS re-resolve) is a known residual risk.

## `src/utils/eventQueue.js` â€” job build/queue/recovery

Consts `PENDING/QUEUED/NO_SUBSCRIBERS`. `buildJobId(e,s)` â†’ `event-<e>-subscriber-<s>` (no colons). `buildDeliveryJobs(event)` â†’ per-target `{name:'deliver',data:{eventId,subscriberId,subscriberUrl,payload,requestId},opts:{jobId}}` + assert schema (secret omitted). `markEventQueueState(id,updates)` â†’ `findByIdAndUpdate`. `queueEventDeliveries(event)` â€” zero jobsâ†’`no_subscribers`; `addBulk` OKâ†’`queued`+count+`queueEnqueuedAt`+clear error; throwâ†’`pending`+`lastQueueError`+rethrow. `recoverPendingEvents({limit:25})` â€” `find({queueStatus:'pending'}).sort({createdAt:1}).limit` â†’ per-event queue â†’ `{scanned,recovered}`. `startPendingEventRecovery({intervalMs:RECOVERY_INTERVAL_MS||5000,batchSize:RECOVERY_BATCH_SIZE||25})` â€” `intervalMs<=0`â†’null; `DISABLE_RECOVERY==='true'`â†’warn+null; else process-local `isRunning` guard, immediate + interval run, logs. Called by `app.listen`.

## `src/mock/subscriber.js` â€” mock receiver :4000

Express + rawBody; `WEBHOOK_SECRET` or dev default (warns); `POST /receive` reads signature/attempt/timestamp, `verifySignature(rawBody,secret,ts,sig)` â†’ 401 if bad; 30% random 503; else 200 `{received:true}`. Demo HMAC verifier.

## `src/mock/producer.js` â€” demo driver

`BASE_URL/SUBSCRIBER_URL/SHARED_SECRET(WEBHOOK_SECRET)/DELIVERY_WAIT_MS` envs; `registerProducer()` (POST producers/register `mock-producer.local:5000`), `registerSubscriber()` (POST webhooks/register), `fireEvent(key,type,payload,idempotencyKey?)` (POST /events with `x-api-key`), `checkLogs(subKey)` (GET /webhooks/logs), `run()` â€” register both, 3 events (payment.success/order.created/payment.failed), wait, print logs. Requires `DISABLE_SSRF_CHECK=true` for localhost URLs; re-run 409s on duplicate URLs.

## Tests (16 suites, 122 tests â€” all passing via `jest --runInBand src/tests`)

- `src/tests/admin.test.js` â€” missing/invalid/inactive admin keys (401), unconfigured (503), constant-time path.
- `src/tests/auth.test.js` â€” producer+subscriber: missing (401), invalid/inactive (401), DB error (500); mocked models+hash.
- `src/tests/deadLetters.test.js` â€” admin gate, GET format, replay 202/409(active)/404/400-missing-data; mocked queues+Event; live express server.
- `src/tests/delivery.test.js` â€” worker: 2xx success log+summary, 4xx permanentâ†’Unrecoverable, 5xx/408/429/networkâ†’rethrow, pre-delivery inactive/decrypt fail-fast, timeout+`maxRedirects:0`, `durationMs`, body truncation; mocked axios/models/Worker.
- `src/tests/deliveryLog.test.js` â€” schema has `createdAt` not `updatedAt` + all audit fields.
- `src/tests/encryption.test.js` â€” round-trip, random IVs, wrong-key/tamper reject, bad formats.
- `src/tests/eventQueue.test.js` â€” deterministic IDs, `addBulk`, no_subscribers/queued/pending transitions, error capture.
- `src/tests/hmac.test.js` â€” 64-hex deterministic signing, secret/payload/ts sensitivity, tamper + replay-window reject.
- `src/tests/idempotency.test.js` â€” createâ†’`200 isDuplicate`â†’`409` mismatch, header+body keys, `11000` race; live express + mocked models.
- `src/tests/jobSchema.test.js` â€” valid pass, optional requestId, ObjectId/URL/payload rejections.
- `src/tests/rateLimitRedis.test.js` â€” dedicated opts (`enableOfflineQueue:false,maxRetriesPerRequest:1`), timeout-bound 503 fail-closed, re-init on ready, BullMQ isolation.
- `src/tests/recovery.test.js` â€” pendingâ†’queued when Redis back, stays pending on failure, batch sort/limit.
- `src/tests/retry.test.js` â€” end-to-end handler retry paths + HMAC round-trip (like delivery, coarser).
- `src/tests/retryPolicy.test.js` â€” matrix: no-response/408/429/5xx retry; other 4xx permanent.
- `src/tests/routes.test.js` â€” `/health` shape, `/ready` 200/503 by mongo+redis, request-ID echo/generation, body-limit 413, 404, recovery wiring.
- `src/tests/ssrf.test.js` â€” blocked v4/v6/mapped/metadata/localhost, public allowed, bypass flag, DNS-failure errors.


---

# FILE 5/8: docs/ARCHITECTURE_DECISIONS.md

# ARCHITECTURE_DECISIONS â€” Decisions Actually Present in the Code

> Each entry: Decision â†’ Implementation â†’ Why â†’ Problem â†’ Alternatives â†’ Advantages â†’ Costs â†’ Limits â†’ Code location.

## 1. Express API + separate worker processes

**Impl:** `src/app.js` (HTTP, Mongo writes, `addBulk`) vs `src/workers/deliveryWorker.js` (BullMQ `Worker`, Axios, logs) sharing only Mongo+Redis. Docker `app` + `worker` services.
**Why:** slow/unresponsive subscribers must not block ingest event loop/sockets.
**Problem:** synchronous delivery couples API latency to downstream.
**Alternatives:** in-request Axios; in-process queue; Lambda-per-delivery.
**Advantages:** independent scaling/tuning (`WORKER_CONCURRENCY`), deploys, failure isolation; `202` stays fast.
**Costs:** two runtimes to operate/monitor; Redis as coupling point.
**Limits:** no priority queues; single worker concurrency knob.
**Code:** `src/app.js`, `src/workers/deliveryWorker.js`, `docker-compose.yml`.

## 2. BullMQ over Redis for delivery queue

**Impl:** `webhook-delivery` (attempts 5, exponential 1s, retain 100/200) + `webhook-dead-letter` (500/200).
**Why:** built-in attempts/backoff/delayed/retention/dedup by jobId vs hand-rolled timers.
**Alternatives:** RabbitMQ/SQS/Kafka, DB-polling.
**Advantages:** state transitions + stalled reclamation + `getJob/getJobs` for DLQ/replay.
**Costs:** Redis SPOF without Sentinel/Cluster; eviction breaks dedup after 100 completions.
**Code:** `src/queues/deliveryQueue.js`.

## 3. MongoDB (Mongoose) for entities + audit

**Impl:** Producer/Subscriber/Event/DeliveryLog collections with schema validation + indexes.
**Why:** flexible payload (`Mixed`), snapshot arrays, queryable audit, unique constraints for idempotency.
**Alternatives:** Postgres+JSONB, DynamoDB.
**Costs:** no transactions; dual-write Mongoâ†”Redis consistency boundary (Event written, jobs may fail â†’ `pending` + recovery).
**Code:** `src/models/*`, `src/config/db.js`.

## 4. Two Redis connections (BullMQ unbounded vs rate-limit bounded)

**Impl:** `config/redis.js` (`maxRetriesPerRequest:null`, offline queue) vs `config/rateLimitRedis.js` (`enableOfflineQueue:false`, `maxRetriesPerRequest:1`, 1s race â†’ 503).
**Why:** BullMQ needs indefinite retries; request path needs fail-fast (sharing hangs HTTP during outage before persistence).
**Alternatives:** one connection; in-memory limiter; sidecar.
**Advantages:** deliveries eventually resume; HTTP never hangs; Lua re-init on reconnect.
**Costs:** two pools to configure/monitor.
**Code:** `src/config/redis.js`, `src/config/rateLimitRedis.js`, `src/app.js`.

## 5. Async `202 Accepted` ingest decoupled from delivery

**Impl:** persist Event + `addBulk` attempt â†’ `202` (queued / no_subscribers / recoveryScheduled); worker later.
**Why:** honest semantics (acceptedâ‰ delivered), absorbs subscriber slowness.
**Alternatives:** `200` after delivery; webhook relay sync.
**Costs:** client must poll logs/status; `queueStatusâ‰ delivered` confusion.
**Code:** `src/routes/events.js`, `src/utils/eventQueue.js`.

## 6. At-least-once delivery

**Impl:** retries (5) + recovery re-queue + replay; no dedup on subscriber side; docs mandate `X-Webhook-Event-Id` idempotency.
**Why:** network timeouts make exactly-once infeasible without subscriber cooperation.
**Costs:** duplicates on timeout-before-response, recovery race, post-eviction re-add.
**Code:** worker retry/DLQ + `eventQueue.js` + docs.

## 7. Deterministic dash-separated job IDs

**Impl:** `event-<e>-subscriber-<s>`, `dead-letter-<id>`, `replay-<dlqId>` (colons forbidden by BullMQ).
**Why:** recovery/replay retries dedupe while retained; `409` in-flight replay guard.
**Costs:** post-`removeOnComplete:100` eviction re-adds as new; payload key-order affects idempotency compare.
**Code:** `src/utils/eventQueue.js`, `src/routes/deadLetters.js`.

## 8. Producer-scoped idempotency + DB uniqueness

**Impl:** header/body key â†’ `{producerId,idempotencyKey}` sparse-unique partial index; same type+`JSON.stringify` payload â†’ `200 isDuplicate`; mismatch â†’ `409`; `11000` race â†’ `200`.
**Why:** safe producer retries without `Event`/job duplication; per-producer scope prevents cross-tenant collisions.
**Alternatives:** global keys, Redis dedup window, no idempotency.
**Costs:** key-order-sensitive compare; blank keys never dedupe.
**Code:** `src/routes/events.js`, `src/models/Event.js`.

## 9. Retry classification + `UnrecoverableError`

**Impl:** `isRetryableError` (no-response/408/429/5xx â†’ retry; other 4xx â†’ permanent) + pre-delivery deterministic fails (inactive/missing, decrypt/serialize) â†’ `UnrecoverableError` + pre-delivery log; `failed` listener escalates permanent immediately or `attemptsMade>=5`.
**Why:** don't burn 5 attempts on requests that can never succeed; preserve attempts for transient.
**Costs:** 4xx misclassified by subscriber (e.g., 429-as-400) retried or not per rule, not intent.
**Code:** `src/utils/retryPolicy.js`, `src/workers/deliveryWorker.js`.

## 10. Exponential backoff + jitter

**Impl:** BullMQ `exponential/1000` + worker `backoffStrategy: 1000*2^(n-1)+rand*RETRY_JITTER_MS(500)`.
**Why:** spread thundering-herd restrikes while subscriber recovers.
**Costs:** worst-case ~15s+ per job; jitter non-deterministic in tests (mocked).
**Code:** `deliveryQueue.js`, `deliveryWorker.js`.

## 11. Dead-letter queue + single-job replay

**Impl:** terminal `webhook-dead-letter` (`failed-delivery`, `{...data,failureReason,originalJobId,failedAt}`); admin `GET` waiting + `POST replay` with `409` guard and `Event $inc replayCount`.
**Why:** permanently failed deliveries stay visible and manually redrivable.
**Alternatives:** drop, auto-retry forever, bulk replay (deliberately removed per scope note).
**Costs:** manual per-job operation; DLQ retained on replay; no `queueStatus` sync.
**Code:** worker `failed` listener, `src/routes/deadLetters.js`.

## 12. Global webhook timeout + no redirects

**Impl:** `WEBHOOK_TIMEOUT_MS` (5000) on every Axios POST; `maxRedirects:0` + pre-dial SSRF re-check.
**Why:** one slow subscriber can't pin worker slots; redirects are SSRF bypass vectors. Per-subscriber timeout deliberately removed (scope simplification).
**Costs:** no per-subscriber SLO tuning.
**Code:** `src/workers/deliveryWorker.js`.

## 13. DNS-based SSRF protection (+ dev bypass)

**Impl:** `validateNoSSRF`: protocol gate, raw-IP + `localhost*` block, `resolve4+resolve6` every IP vs v4/v6 CIDRs (loopback, RFC1918, link-local/metadata, docs, `::/8` families); `DISABLE_SSRF_CHECK=true` skips (demos/tests only).
**Why:** subscribers supply dial targets â€” must not reach instance metadata/internal hosts.
**Costs:** DNS TOCTOU (resolveâ†’dial gap); `localhost` demos need bypass + `host.docker.internal` in Docker.
**Code:** `src/utils/ssrf.js`.

## 14. AES-256-GCM for signing secrets; SHA-256 hash for API keys

**Impl:** secrets encrypted `iv:tag:ct` via `WEBHOOK_ENCRYPTION_KEY`, decrypted per delivery; API/admin keys only SHA-256 stored/compared.
**Why:** secrets need reversible use (HMAC) â†’ encrypt; API keys need verify-only â†’ hash (DB read doesn't leak usable key).
**Costs:** KMS-less env key management/rotation; per-delivery decrypt cost.
**Code:** `src/utils/encryption.js`, `src/utils/apiKey.js`, `Subscriber` virtual.

## 15. HMAC-SHA256 + timestamp window + timing-safe compare

**Impl:** sign `String(ts)+'.'+bodyBuffer` hex; `X-Webhook-Signature/X-timestamp`; verify 5-min `abs` window + `timingSafeEqual`, raw `req.rawBody` bytes.
**Why:** authenticity + tamper evidence + replay bound without clock sync strictness; constant-time blocks side-channels; raw bytes avoid JSON re-ordering.
**Costs:** subscriber must mirror exact construction + clock discipline.
**Code:** `src/utils/hmac.js`, worker, mock subscriber.

## 16. Append-only DeliveryLog + bounded bodies

**Impl:** `createdAt`-only schema, never updated; response text capped `MAX_DELIVERY_RESPONSE_BODY_CHARS` 8192 + marker (audit-only, behavior untouched); `durationMs` both outcomes.
**Why:** trustworthy audit without mutation; bound prevents huge responses blowing up Mongo.
**Costs:** truncated bodies may hide debugging detail (fetch from subscriber instead).
**Code:** `src/models/DeliveryLog.js`, worker.

## 17. Health (`/health`) vs readiness (`/ready`)

**Impl:** liveness = static ok; readiness = mongo `readyState===1` + Redis `ping` race 2s â†’ 200/503 with per-dep status.
**Why:** liveness = restart signal; readiness = traffic gate; BullMQ's infinite retry forces the ping timeout.
**Code:** `src/app.js`.

## 18. Pending-event recovery loop

**Impl:** `setInterval(RECOVERY_INTERVAL_MS 5000)` + immediate run, batch 25, `find({queueStatus:'pending'}).sort({createdAt:1})`, `isRunning` guard, `DISABLE_RECOVERY` escape.
**Why:** `202+pending` on `addBulk` failure self-heals without operator.
**Costs:** single-instance coordination only (see Limitations); full-Redis-outage ingress never reaches it (limiter 503 first).
**Code:** `src/utils/eventQueue.js`.

## 19. Graceful shutdown (API + worker)

**Impl:** API: stop accept â†’ clear timer â†’ close queue â†’ quit both Redis â†’ close mongo â†’ exit (10s force). Worker: `worker.close()` drains in-flight.
**Why:** avoid dropping queued work / half-written logs on deploy.
**Costs:** `SIGKILL` still drops in-flight HTTP (job retried/stalled-reclaimed).
**Code:** `src/app.js`, `deliveryWorker.js`.

## 20. Docker 4-service topology + fail-closed rate limiting

**Impl:** `app`+`worker` (build, `WEBHOOK_ENCRYPTION_KEY`/`ADMIN_API_KEY` passthrough, `./logs` mount, mongo/redis health deps) + `mongo:7` + `redis:7-alpine` with volumes/healthchecks; limiter `passOnStoreError:false` + 1s bound â†’ 503 instead of un-limited pass.
**Why:** local prod-like stack; never fail open on limiter outage.
**Costs:** Redis still SPOF; limiter 503s during Redis outage even when Mongo healthy.
**Code:** `Dockerfile`, `docker-compose.yml`, `src/app.js`.


---

# FILE 6/8: docs/LIMITATIONS_AND_TRADEOFFS.md

# LIMITATIONS_AND_TRADEOFFS â€” Real Limits and Deliberate Tradeoffs

> Every claim tied to code. `Choice â†’ Benefit â†’ Cost â†’ Why acceptable`.

## Current limitations (genuinely cannot do today)

1. **Single-job DLQ replay only; no bulk replay.** `POST /dead-letters/:jobId/replay` handles one DLQ ID; bulk endpoint was deliberately removed (scope note). Large backlogs need scripting.
2. **Replay doesn't remove DLQ entry nor sync `queueStatus`.** Replay adds `replay-*` job + `$inc replayCount`; DLQ job retained; `Event.queueStatus/deliveryTargets` untouched; post-terminal re-replay enqueues anew (`src/routes/deadLetters.js`).
3. **No per-subscriber timeout/policy.** Single `WEBHOOK_TIMEOUT_MS` for all dials (per-subscriber config removed by design).
4. **No secret rotation endpoint.** Secret change requires direct DB/manual flow; no migration path in code.
5. **No EventType registry.** `noun.verb` is regex-only; producer `allowedEvents` + subscriber `events` are free-form strings (typos fail silently as `no_subscribers`).
6. **No DLQ monitoring/alerting.** DLQ is poll-only (`GET /dead-letters`); no metrics/webhooks (removed by scope).
7. **No ordering guarantee.** BullMQ concurrency + backoff + retries + replay can reorder per-subscriber deliveries; no sequence numbers.
8. **Payload compare is key-order sensitive.** Idempotency uses `JSON.stringify` equality; semantically equal objects with different key order â†’ `409`.
9. **DNS TOCTOU in SSRF.** Validate-then-dial window allows DNS change between `resolve4/6` and Axios connect; no dial-time IP pinning.
10. **Truncated audit bodies.** Responses >8192 chars persisted with `...[truncated]`; full bodies not recoverable from `DeliveryLog`.

## Deliberate tradeoffs

- **At-least-once (not exactly-once).** Choice: retry+recovery+replay â†’ Benefit: no silent loss â†’ Cost: duplicates (timeout-before-response, recovery race, post-eviction re-add) â†’ Acceptable: subscribers keyed on `X-Webhook-Event-Id`.
- **Async `202` (not sync `200`).** Choice: persist+enqueue then respond â†’ Benefit: API immune to subscriber slowness â†’ Cost: client polls logs/status; `queuedâ‰ delivered` â†’ Acceptable: documented + `GET /events/:id` + logs.
- **Fail-fast permanent 4xx via `UnrecoverableError`.** Choice: 400/401/403/404 etc. â†’ DLQ immediately â†’ Benefit: preserves attempts/capacity â†’ Cost: subscriber misusing 4xx for transient gets no retry â†’ Acceptable: rule documented (`408/429/5xx`/no-response retry).
- **Deterministic job IDs with eviction window.** Choice: `event-*-subscriber-*` dedup â†’ Benefit: recovery/replay safe while retained â†’ Cost: after `removeOnComplete:100` same ID re-executes â†’ Acceptable: small demo scale; documented.
- **Encrypted secrets + hashed keys.** Choice: AES-GCM reversible secrets, SHA-256 verify-only keys â†’ Benefit: DB read â‰  forge/authenticate â†’ Cost: env key management + per-delivery decrypt â†’ Acceptable: standard pattern at this scale.
- **Fail-closed rate limiting.** Choice: Redis error â†’ `503` not pass-through â†’ Benefit: never un-limited during outage â†’ Cost: `503`s even for valid traffic when Redis down â†’ Acceptable: safe default; test env uses memory store.
- **Global timeout + `maxRedirects:0`.** Choice: one timeout, no follows â†’ Benefit: bounded slots, no redirect-SSRF â†’ Cost: no per-subscriber tuning; redirecting subscribers break â†’ Acceptable: simplicity + security.
- **Sparse unique idempotency (per-producer).** Choice: `{producerId,idempotencyKey}` unique, nulls excluded â†’ Benefit: keyless events unlimited, tenants isolated â†’ Cost: cross-producer sharing impossible; blank keys never dedupe â†’ Acceptable: matches ownership model.

## Operational limitations

- **Redis down at ingress â†’ `503`, no Event stored.** Limiter (bounded conn) rejects before persistence; `202+pending` recovery only covers post-limiter `addBulk` failures (`src/app.js`, `rateLimitRedis.js`).
- **Redis down mid-flight â†’ deliveries pause; stalled `active` reclaimed on reconnect.** Waiting/delayed durability depends on Redis persistence (image defaults; no custom `redis.conf` in repo â€” Not determinable beyond volume `redis_data`).
- **Mongo down at ingest â†’ `500`, nothing queued.** Worker subscriber-fetch fail â†’ retry; log-write fail â†’ logged, delivery continues (`rethrowOnFailure:false`).
- **Config sensitivity:** missing/invalid `WEBHOOK_ENCRYPTION_KEY` fatal in production; missing `ADMIN_API_KEY` â†’ DLQ `503`; `BODY_LIMIT` overflow â†’ `413`; `DISABLE_SSRF_CHECK=true` must never reach production.
- **Logs:** file+console; Docker bind-mount `./logs` required to survive recreation; no log rotation in code.

## Scalability limitations

- **Single-instance recovery.** `isRunning` is process-local; N API replicas â†’ overlapping scans + duplicate `addBulk` (mitigated while jobs retained, not after eviction). Mitigation in code: `DISABLE_RECOVERY=true` on all but one. Production fix: Redlock/leader election (`src/utils/eventQueue.js`).
- **Rate limits hold across replicas (Redis-backed)** â€” safe to scale API horizontally for throttling; worker scales via `WORKER_CONCURRENCY` (event-loop concurrency, not threads) + more worker containers (at-least-once duplicates rise with concurrency).
- **No queue partitioning/priority.** One `webhook-delivery` queue; hot subscriber head-of-line blocks behind same concurrency pool.
- **Retention windows bound history.** `removeOnComplete:100/removeOnFail:200` (main), `500/200` (DLQ) â€” high throughput evicts fast; replay-after-eviction creates new work silently.

## Reliability limitations

- **Mongoâ†”Redis dual-write boundary.** `Event.create` then `addBulk`: crash between â†’ `pending` (healed by recovery); crash after `addBulk` before `queueStatus` update â†’ duplicate enqueue on recovery (deduped while retained).
- **Idempotency race:** concurrent same-key creates â†’ one `11000` â†’ both resolve `200` (safe); same-key different-payload race â†’ winner's Event stands, loser may `409` or `200` depending on interleaving.
- **Replay race:** concurrent replays â†’ one wins `add`, other `409` (safe while first active); after terminal, both enqueue anew (duplicate delivery).
- **Backoff ceiling:** 1sâ†’2sâ†’4sâ†’8s+jitter (~15s+ per job); long subscriber outage â†’ DLQ after 5 attempts regardless of recovery mid-window.
- **`SIGKILL`/container kill:** in-flight Axios dropped; BullMQ reclaims stalled; API un-`queueStatus`-updated Events healed by recovery.

## Security tradeoffs

- **SSRF bypass flag.** `DISABLE_SSRF_CHECK=true` enables localhost demos (`host.docker.internal` in Docker) but disables all DNS/IP checks â€” dev-only by contract, no code gate on `NODE_ENV`.
- **Key-order idempotency + `JSON.stringify`.** Simplicity over canonical JSON; cost documented above.
- **Response bodies in `DeliveryLog`.** Audit value vs PII retention: subscriber responses (possibly sensitive) persisted up to 8k; no redaction/ Ð·Ð°ÐºÑƒÐ»Ð¸ TTL.
- **`producerUrl` regex is loose.** Schema regex requires dotted hostname but not full URL validity; SSRF layer provides the real protection.
- **No mTLS / payload encryption.** HMAC authenticates + TLS (HTTPS in production) protects transit; payload itself is plaintext JSON to subscriber.


---

# FILE 7/8: docs/SECURITY_DECISIONS.md

# SECURITY_DECISIONS â€” Mechanisms, Threats, and Residual Risk

> Format per mechanism: `Threat â†’ Defense â†’ Implementation â†’ Remaining risk`. No mechanism is claimed to make an attack "impossible".

## 1. Authentication â€” producer / subscriber / admin

**Threat:** unauthorized ingest, subscription takeover, DLQ snooping/replay.
**Defense:** per-request API-key auth; inactive keys rejected; admin plane separated.
**Implementation:**
- Keys: `generateApiKey()=randomBytes(32).hex` (64 hex, 256-bit); stored `hashKey()=sha256.hex` in `Producer.apiSecret` / `Subscriber.apiSecret` (`src/utils/apiKey.js`, routes). Raw shown once in `201`.
- Producer: `authenticateProducer` â€” `x-api-key` â†’ hash â†’ `Producer.findOne({apiSecret,isActive:true})` â†’ `req.producer` (401 missing/invalid, 500 DB err).
- Subscriber: `authenticateSubscriber` â€” same on `Subscriber` â†’ `req.subscriber`.
- Admin: `authenticateAdmin` â€” `x-admin-api-key` vs per-request `ADMIN_API_KEY` as SHA-256 + `timingSafeEqual`; missingâ†’401, unconfiguredâ†’503, mismatchâ†’401 (`src/middlewares/authenticateAdmin.js`).
**Remaining risk:** key theft via logs/leaks (bearer tokens, no expiry/rotation endpoint); producer/subscriber `x-api-key` namespaces separate but same header (cross-use fails closed as 401); timing side-channel on producer/subscriber lookup negligible (DB query dominates) vs admin compare hardened.

## 2. Authorization â€” ownership + admin-only DLQ

**Threat:** cross-tenant read/update, replaying others' failures.
**Defense:** ownership checks + collection-separated credentials + router-level admin gate.
**Implementation:** `GET /events/:id` compares `event.producerId.equals(req.producer._id)` â†’ 403 (null-`producerId` legacy events readable by any authed producer); `GET /webhooks/logs` scopes `find({subscriberId:req.subscriber._id})`; `PATCH/DELETE` mutate only `req.*`; DLQ router `router.use(authenticateAdmin)`.
**Remaining risk:** legacy null-`producerId` events lack ownership; no role granularity beyond producer/subscriber/admin.

## 3. Webhook signing â€” HMAC-SHA256 + raw body + timestamp + constant-time compare

**Threat:** forged deliveries, tampered payloads, replayed captures.
**Defense:** shared-secret HMAC over exact wire bytes + freshness window + timing-safe verify.
**Implementation:** worker: `bodyBuffer=Buffer(JSON.stringify(payload))`, `ts=Date.now()`, `sig=HMAC_SHA256(secret, String(ts)+'.'+bodyBuffer).hex` (`src/utils/hmac.js:generateSignature`); headers `X-Webhook-Signature/X-timestamp/X-Webhook-Event-Id/X-Webhook-Attempt/[X-Request-Id]`. `verifySignature(payload,secret,ts,received)`: `abs(now-Number(ts))>5min` or NaN â†’ false; else `timingSafeEqual(hex(expected),hex(received))` try/catch. Mock subscriber verifies `req.rawBody` (express `verify` capture) â€” byte-exact, order-safe.
**Remaining risk:** 5-min replay window accepts fast replays (subscriber must add nonce/`Event-Id` dedup); clock skew >5min breaks legit traffic; key-order `JSON.stringify` must match byte-exactly (worker signs its serialization, subscriber verifies wire bytes â€” safe as long as subscriber uses raw body, not re-stringify).

## 4. Secret protection â€” AES-256-GCM + env key + minimal plaintext lifetime

**Threat:** DB read â†’ forge all subscriber deliveries.
**Defense:** encrypt-at-rest with authenticated encryption; decrypt only inside worker at sign time.
**Implementation:** `WEBHOOK_ENCRYPTION_KEY` 64-hex env, startup-validated (fatal in prod); `encrypt`: random 12B IV, 16B tag, `iv:tag:ct` hex; `decrypt` validates format/lengths, `setAuthTag`, throws on tamper/wrong key â€” never falls back to plaintext (`src/utils/encryption.js`). `Subscriber.virtual('secret')` encrypts on write; worker `decrypt` per attempt; secret never in `Event`/job data/logs.
**Remaining risk:** env-key theft = total decrypt; no KMS/rotation; decrypted secret lives transiently in worker heap per delivery; `WEBHOOK_SECRET` (mock demo HMAC secret) is distinct from `WEBHOOK_ENCRYPTION_KEY` â€” confusing the two breaks auth silently.

## 5. SSRF â€” DNS resolution, blocked ranges, no-redirect, bypass

**Threat:** malicious `subscriberUrl`/`producerUrl` reaching loopback, RFC1918, link-local/metadata (`169.254.169.254`), IPv6 equivalents.
**Defense:** validate-then-dial + redirect ban.
**Implementation:** `validateNoSSRF` (`src/utils/ssrf.js`): `DISABLE_SSRF_CHECK` bypass; `new URL`; http/https (https-only prod); raw-IP `isBlockedIP`; `localhost*` block; `resolve4+resolve6` (allSettled, â‰¥1) â†’ every IP vs `BLOCKED_CIDRS` (127/8,10/8,172.16/12,192.168/16,169.254/16,0/8,255â€¦/32,docs /24s) + `BLOCKED_IPV6_CIDRS` (::1,fe80/10,fc00/7,::,mapped). Called on both registers, `PATCH /webhooks` url, and worker pre-dial; Axios `maxRedirects:0`.
**Remaining risk:** DNS TOCTOU (re-resolves between check and connect); DNS-rebinding; bypass flag has no prod guard (process discipline only); `producerUrl` never dialed so its SSRF check is hygiene, not exploit prevention.

## 6. Rate limiting â€” Redis-backed, dedicated bounded connection, fail-closed

**Threat:** ingest floods, DLQ/management abuse, brute-force.
**Defense:** per-IP counters that hold across replicas and never fail open.
**Implementation:** `express-rate-limit`+`RedisStore` on `rateLimitRedisConnection` (`enableOfflineQueue:false`,`maxRetriesPerRequest:1`), `sendRateLimitCommand` raced `RATE_LIMIT_REDIS_TIMEOUT_MS` 1000ms â†’ generic 503; `passOnStoreError:false`; 100/min `/events`, 50/15min mgmt; Lua re-`init` on `ready`; test-only memory store (`src/app.js`, `src/config/rateLimitRedis.js`).
**Remaining risk:** 503s during Redis outage (by design); IP-keyed limits shared behind NAT; no per-key quotas.

## 7. Input / transport limits

- **JSON `BODY_LIMIT` 16kb** (env-overridable) â†’ `413 {error:'Payload too large',limit}`. Threat: memory/CPU exhaustion â†’ bounded parse. Risk: legit large payloads rejected; chunked bypass not applicable (single JSON body).
- **`WEBHOOK_TIMEOUT_MS` 5000 global.** Threat: slowloris pinning worker slots â†’ bounded dial. Risk: slow legit subscribers DLQ after retries.
- **`maxRedirects:0`.** Threat: redirect-SSRF â†’ blocked. Risk: redirecting subscribers fail (logged as Axios error, retried per policy).
- **`X-Request-Id` allowlist/UUID.** Threat: log/header injection â†’ constrained charset/length. Risk: none material.
- **Response-body bound 8192+marker.** Threat: huge subscriber bodies bloating Mongo â†’ capped audit copy. Risk: debug detail lost (behavior unaffected).

## 8. Information disclosure

- **Prod 500s sanitized** (`'Internal server error'`, no stacks) in `app.js` error handler; 503 rate-limit generic; DLQ `503` unconfigured (no key hint); SSRF `400`s expose resolved IP (`:<addr>`) â€” aids debugging but confirms DNS outcome to registrant.
- **Secrets:** raw API keys only in `201` (once); never logged; `DeliveryLog.responseBody` may carry subscriber PII (no redaction/TTL); Winston file logs include `eventId/attempt/error.message` but not secrets/keys.
- **`requestId` echo** is tracing-only, no auth bypass.

## Threat model summary

| Threat | Mitigated by | Residual |
|---|---|---|
| Forged webhook | HMAC + secret encryption + timestamp window + timing-safe | 5-min replay; key theft via env/DB+key |
| Tampered payload | HMAC over raw bytes | subscriber must verify raw body |
| SSRF/metadata | DNS CIDR blocks + https-prod + no-redirect + pre-dial | TOCTOU/rebinding; bypass flag |
| Credential DB leak | SHA-256 keys, AES-GCM secrets | env key theft; bearer replay |
| Timing side-channel | `timingSafeEqual` (HMAC + admin) | DB-lookup timing (negligible) |
| Flood/abuse | Redis rate limits, fail-closed | NAT sharing; Redis-down 503s |
| Silent loss | retries + recovery + DLQ + audit | duplicates; manual replay only |
| Secret rotation gap | â€” (no endpoint) | rotation requires out-of-band DB work |


---

# FILE 8/8: docs/INTERVIEW_QUESTIONS.md

# INTERVIEW_QUESTIONS â€” Based Only on This Repository

> Every expected answer cites current files. No textbook-only answers.

## Level 1: Basic

### Q1. Sketch the architecture from producer to subscriber.
**Testing:** system decomposition. **Answer:** Producer â†’ `POST /events` (Express `src/app.js`) â†’ Mongo `Event` + BullMQ `webhook-delivery` (Redis) â†’ `deliveryWorker.js` (Axios HMAC POST) â†’ subscriber; failures â†’ retries â†’ `webhook-dead-letter` â†’ admin replay; every attempt â†’ `DeliveryLog`. **Concepts:** decoupling, at-least-once, 202. **Evidence:** `src/app.js`, `src/routes/events.js`, `src/queues/deliveryQueue.js`, `src/workers/deliveryWorker.js`.

### Q2. What routes exist and who can call them?
**Testing:** route inventory. **Answer:** 15: producers (register public; PATCH/DELETE producer-auth), webhooks (register public; GET/PATCHÃ—2/DELETE/logs subscriber-auth), events (POST/GET/:id producer-auth), dead-letters (GET/replay admin), `/health`+`/ready` public. **Evidence:** `src/routes/*.js`, `API_AND_ROUTE_FLOWS.md`.

### Q3. What lives in MongoDB vs Redis?
**Testing:** storage separation. **Answer:** Mongo: Producer/Subscriber/Event/DeliveryLog (durable entities+audit). Redis: BullMQ jobs/state + rate-limit counters (two connections). Redis is not a cache. **Evidence:** `src/models/*`, `src/config/redis.js`, `src/config/rateLimitRedis.js`.

### Q4. How does BullMQ deliver and retry?
**Testing:** queue semantics. **Answer:** `webhook-delivery` attempts 5, exponential 1s base + jitter; worker throws â†’ delayed retry; permanent â†’ `UnrecoverableError` â†’ DLQ immediately; `attemptsMade>=5` â†’ DLQ. **Evidence:** `deliveryQueue.js`, `retryPolicy.js`, `deliveryWorker.js`.

### Q5. How is a producer/subscriber authenticated?
**Testing:** authN. **Answer:** `x-api-key` â†’ SHA-256 â†’ `findOne({apiSecret,isActive:true})` on own collection â†’ `req.producer/req.subscriber`; admin uses `X-Admin-Api-Key` vs env with `timingSafeEqual`. **Evidence:** `src/middlewares/*`, `src/utils/apiKey.js`.

### Q6. How is a webhook signed and verified?
**Testing:** HMAC. **Answer:** `HMAC_SHA256(secret, String(ts)+'.'+bodyBuffer).hex` in `X-Webhook-Signature` + `X-timestamp`; verify raw bytes + 5-min window + `timingSafeEqual`. **Evidence:** `src/utils/hmac.js`, worker, `mock/subscriber.js`.

## Level 2: Intermediate

### Q7. Why `202` not `200` on `POST /events`?
**Testing:** async semantics. **Answer:** Acceptedâ‰ delivered; response after persist+`addBulk`, before dial. Variants: queued / no_subscribers / recoveryScheduled. `GET /events/:id` is handoff status, not outcome. **Evidence:** `src/routes/events.js`.

### Q8. How does idempotency work?
**Testing:** dedup. **Answer:** `Idempotency-Key`/body key scoped `{producerId,idempotencyKey}` sparse-unique; same type+`JSON.stringify` payload â†’ `200 isDuplicate`; mismatch â†’ `409`; `11000` race â†’ `200`. **Evidence:** `events.js`, `Event.js` index.

### Q9. Why deterministic job IDs with dashes?
**Testing:** dedup. **Answer:** `event-<e>-subscriber-<s>` (+`dead-letter-`, `replay-`) dedupes recovery/replay while retained; colons illegal in BullMQ IDs; `409` replay guard; eviction after 100 completions re-allows same ID. **Evidence:** `eventQueue.js`, `deadLetters.js`.

### Q10. How are retries classified?
**Testing:** failure handling. **Answer:** `isRetryableError`: no-response/408/429/5xx â†’ retry; other 4xx + deterministic pre-delivery (inactive/missing, decrypt fail) â†’ `UnrecoverableError` + pre-delivery log (null status/body/duration). **Evidence:** `retryPolicy.js`, `deliveryWorker.js`.

### Q11. What is the DLQ + replay contract?
**Testing:** ops. **Answer:** Terminal `webhook-dead-letter` (`failed-delivery`, failureReason/originalJobId/failedAt); admin GET waiting + POST replay (guard 409, `$inc replayCount`, retain DLQ entry, no queueStatus sync). **Evidence:** worker `failed` listener, `deadLetters.js`.

### Q12. AES-GCM vs hashing â€” when and why?
**Testing:** crypto choice. **Answer:** Secrets reversible-needed â†’ AES-256-GCM `iv:tag:ct` (`WEBHOOK_ENCRYPTION_KEY`), decrypted per delivery; API keys verify-only â†’ SHA-256 stored/compared. **Evidence:** `encryption.js`, `apiKey.js`, `Subscriber.js`.

### Q13. How does SSRF protection work?
**Testing:** security. **Answer:** `validateNoSSRF`: protocol, raw-IP/localhost blocks, `resolve4+6` every IP vs v4/v6 CIDRs, prod-https, `maxRedirects:0`, pre-dial re-check; `DISABLE_SSRF_CHECK` dev-only. **Evidence:** `ssrf.js`, worker, routes.

### Q14. How does rate limiting survive Redis outage?
**Testing:** resilience. **Answer:** Dedicated bounded conn (`enableOfflineQueue:false`, `maxRetriesPerRequest:1`, 1s race) â†’ generic 503 fail-closed (`passOnStoreError:false`); Lua re-init on ready; BullMQ conn untouched (unbounded). **Evidence:** `rateLimitRedis.js`, `app.js`.

### Q15. How does pending-event recovery work?
**Testing:** self-healing. **Answer:** `setInterval(5000)`+immediate, batch 25, `find({queueStatus:'pending'}).sort({createdAt:1})` via compound index, `queueEventDeliveries` per event, `isRunning` guard, `DISABLE_RECOVERY` escape. Covers post-limiter `addBulk` fails only (limiter 503 never reaches it). **Evidence:** `eventQueue.js`.

### Q16. What happens on graceful shutdown?
**Testing:** ops. **Answer:** API: stop accept â†’ clear timer â†’ close queue â†’ quit both Redis â†’ close mongo (10s force). Worker: `worker.close()` drains in-flight. `SIGKILL` drops in-flight (reclaimed/retried). **Evidence:** `app.js`, `deliveryWorker.js`.

## Level 3: Advanced

### Q17. List every duplicate-delivery path.
**Testing:** at-least-once reasoning. **Answer:** timeout-before-response retry; recovery duplicate `addBulk` (post-eviction); replay-after-terminal; `11000`-race window; concurrent replay. Mitigation: subscriber `X-Webhook-Event-Id` dedup. **Evidence:** worker, `eventQueue.js`, `deadLetters.js`.

### Q18. What races exist around idempotency?
**Testing:** concurrency. **Answer:** Concurrent same-key creates â†’ one `11000` â†’ both `200` (safe); same-key different-payload interleave â†’ winner stands; `JSON.stringify` order sensitivity â†’ false `409`. **Evidence:** `events.js` try/catch `11000`.

### Q19. Where is the Mongo/Redis consistency boundary?
**Testing:** distributed state. **Answer:** `Event.create` then `addBulk` (no txn): crash between â†’ `pending` (healed); crash after addBulk before status update â†’ duplicate add (deduped while retained). Log-write fail doesn't fail delivery (`rethrowOnFailure:false`). **Evidence:** `events.js`, `eventQueue.js`, worker.

### Q20. What breaks if Redis is fully down?
**Testing:** failure modes. **Answer:** Ingress â†’ limiter 503 (no Events); post-limiter adds â†’ `pending`; worker stalls (stalled reclaimed); `/ready` 503; recovery spins pending. BullMQ unbounded waits; limiter bounded fails fast. **Evidence:** `rateLimitRedis.js`, `app.js`, `DATA_STORAGE.md` matrix.

### Q21. What breaks with 10 API replicas? Multiple workers?
**Testing:** scale. **Answer:** 10 APIs: overlapping recovery scans (process-local `isRunning`) â†’ duplicate adds (fix: `DISABLE_RECOVERY` all-but-one / Redlock). Rate limits still correct (Redis). Workers: higher throughput, more duplicates + ordering skew; BullMQ handles distribution; stalled reclamation on crash. **Evidence:** `eventQueue.js`, `deliveryQueue.js`.

### Q22. How do replay races behave?
**Testing:** DLQ ops. **Answer:** Concurrent replays â†’ one `add`, other `409` (safe while active/waiting); after terminal â†’ both enqueue anew (duplicate). DLQ retained always. **Evidence:** `deadLetters.js`.

### Q23. Why jitter on top of exponential backoff?
**Testing:** retry storms. **Answer:** `1000*2^(n-1)+rand*500` via `backoffStrategy` spreads restrikes when a subscriber flaps with many queued jobs; pure exponential still herds. **Evidence:** `deliveryWorker.js` settings.

### Q24. SSRF/DNS edge cases?
**Testing:** security depth. **Answer:** TOCTOU (check-vs-dial), rebinding, mapped-IPv6 (`::ffff:`) handled, `localhost*` blocked, docs ranges blocked, metadata `169.254.169.254` blocked; bypass flag unguarded by env. **Evidence:** `ssrf.js` + tests.

### Q25. Secret handling lifetime?
**Testing:** data protection. **Answer:** Plaintext only in register body â†’ encrypted immediately (virtual); at rest encrypted; decrypted transiently per delivery; never in jobs/events/logs; env key rotation out-of-band (no endpoint). **Evidence:** `Subscriber.js`, `encryption.js`, worker.

## Level 4: Deep-dive / system design

### Q26. Scale to 100k events/sec â€” what changes?
**Testing:** bottleneck analysis. **Answer:** Needs: queue partitioning (per-subscriber/sharded queues), worker fleet + autoscale, Mongo sharding + `DeliveryLog` TTL/rollup, Redis Cluster/Sentinel + persistence, bulk DLQ tooling, per-subscriber backoff/quotas, observability (lag, attempts, DLQ depth). Current single queue + retention 100/200 + per-attempt Mongo writes won't hold. **Evidence:** `deliveryQueue.js`, `DeliveryLog.js`, `LIMITATIONS_AND_TRADEOFFS.md`.

### Q27. Fix multi-replica recovery?
**Testing:** distributed coordination. **Answer:** Redlock lease around `recoverPendingEvents` or Mongo leader election / `findOneAndUpdate` claim per Event (`queueStatus:pendingâ†’claimed`) so only one replica owns a batch. **Evidence:** current `isRunning` in `eventQueue.js`.

### Q28. Stronger delivery semantics? Ordering?
**Testing:** semantics. **Answer:** At-least-once is ceiling without subscriber cooperation; exactly-once needs transactional outbox + subscriber dedup on `Event-Id` + idempotent handlers. Ordering needs per-subscriber FIFO queue + sequence numbers + head-of-line blocking acceptance. **Evidence:** snapshot targets, concurrent worker, no sequence fields.

### Q29. Redesign DLQ replay at scale?
**Testing:** ops at scale. **Answer:** Bulk/filtered replay (by event/subscriber/time), dry-run, rate-limited replay queue, DLQ removal on success, `queueStatus` reconciliation, replay audit. Current single-job manual + retained DLQ is the bottleneck. **Evidence:** `deadLetters.js` (no bulk by scope).

### Q30. Observability + backpressure?
**Testing:** production readiness. **Answer:** Add: queue lag/depth, attempt histograms, `durationMs` SLOs, DLQ age/depth alerts (removed scope), per-subscriber circuit breaker (removed scope), shed/load-shed (429 + `Retry-After`), subscriber quotas. Current: Winston logs + `/ready` only. **Evidence:** `logger.js`, `/health` vs `/ready`.

### Q31. Per-subscriber policies + secret rotation?
**Testing:** configurability. **Answer:** Extend `Subscriber` with timeout/retry/burst fields (scope removed global-only today); rotation via dual-secret (`primary/secondary` + grace window) + versioned signatures. **Evidence:** `WEBHOOK_TIMEOUT_MS` global, no rotation endpoint.

### Q32. Survive Mongo/Redis outages?
**Testing:** resilience design. **Answer:** Mongo: read replicas, retryable writes, outbox pattern, degrade (accept-and-buffer vs reject). Redis: Sentinel/Cluster, persistence (AOF), separate rate-limit fallback (local token bucket when Redis down vs current fail-closed 503), queue spill to Mongo. **Evidence:** current fail-closed + `pending` + volumes.

## Questions you should be able to answer by reading this repository (checklist)

- [ ] What are the exact BullMQ queue names and retention counts?
- [ ] What are the three deterministic job-ID formats and why dashes?
- [ ] What does `queueStatus` mean (and what it does NOT mean)?
- [ ] Which headers does the worker send, and which is conditional?
- [ ] What is `MAX_DELIVERY_RESPONSE_BODY_CHARS` and what does it bound?
- [ ] Which `4xx` are retried vs fail-fast, and which class throws?
- [ ] Where is `DISABLE_SSRF_CHECK` honored, and why `host.docker.internal`?
- [ ] What are the two Redis connections and how do their options differ?
- [ ] What happens on `POST /events` when Redis is down at limiter vs at `addBulk`?
- [ ] What does DLQ replay update on `Event`, and what does it NOT update?
- [ ] Which timestamp formats/indexes back recovery vs logs queries?
- [ ] How many suites/tests pass and what command runs them?

