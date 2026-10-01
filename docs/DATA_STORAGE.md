# DATA_STORAGE — Where and How Every Piece of Data Is Stored

> Source of truth: current `src/` implementation (verified 2026-09-29).
> `README.md` / `context.md` / `code.txt` were treated as secondary; discrepancies are marked **[DISCREPANCY]**.

---

## 1. MongoDB

Connection: `src/config/db.js` → `mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/webhook-delivery')`.
Failure at startup logs and `process.exit(1)`. No TTL indexes anywhere. No transactions used.

### 1.1 Producer — `src/models/Producer.js`, collection `producers`

**Purpose:** Authorized event emitters. Owns `allowedEvents`; authenticates `POST /events` and `GET /events/:id`.

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | — | Primary key. |
| `producerUrl` | String trimmed | yes, unique | — | Identifier only, never dialed. Regex validated in schema: `/^https?:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9-].*$/` (requires dotted hostname). Route also runs `validateNoSSRF()` (DNS-based; see §SSRF). |
| `apiSecret` | String | yes, unique | — | SHA-256 hex of the 32-byte management API key. Plaintext shown once at registration, never stored. |
| `allowedEvents` | [String] | yes | — | Non-empty, no duplicates (two schema validators). Each entry should match `noun.verb` (enforced at route level, not schema level). |
| `isActive` | Boolean | no | `true` | `false` = deactivated; auth middleware rejects (`findOne({apiSecret, isActive:true})`). |
| `createdAt` / `updatedAt` | Date | auto | — | `timestamps:true`. |

**Indexes:** `_id_` (default), `producerUrl_1` unique, `apiSecret_1` unique (both from `unique:true`).
**Relationships:** `Event.producerId → Producer._id` (optional, for ownership + idempotency scope).
**Created by:** `POST /producers/register` (`src/routes/producer.js` → `Producer.create`).
**Read by:** `authenticateProducer` (`findOne({apiSecret:hashed,isActive:true})` on every producer-authenticated call); `GET /events/:id` ownership check uses `req.producer._id`.
**Updated by:** `PATCH /producers/events` (replaces `allowedEvents`); `DELETE /producers` (sets `isActive:false`). No hard delete anywhere.
**State fields:** `isActive`. **Append-only:** none. **Idempotency/recovery/replay:** `allowedEvents` gates `403` on ingest; `_id` scopes idempotency.
**Consistency:** duplicate `producerUrl` or `apiSecret` → Mongo `11000` → route returns `409`.

### 1.2 Subscriber — `src/models/Subscriber.js`, collection `subscribers`

**Purpose:** Webhook receivers. Owns `events` subscription list + encrypted signing secret.

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | — | Primary key; embedded in job IDs and logs. |
| `subscriberUrl` | String trimmed | yes, unique | — | Dialed by worker via Axios. Validated by `validateNoSSRF()` on register + `PATCH /webhooks`. |
| `events` | [String] | yes | — | Non-empty + no-duplicates validators. Multikey indexed for `find({events:type})`. |
| `signingKey` | String | yes | — | **AES-256-GCM encrypted** webhook secret, format `ivHex:authTagHex:ciphertextHex`. Plaintext never stored. Written only via `virtual('secret')` setter → `encrypt(val)`. |
| `apiSecret` | String | yes, unique | — | SHA-256 hex of management API key, shown once at registration. |
| `isActive` | Boolean | no | `true` | `false` excludes from `Subscriber.find({events, isActive:true})` and causes worker fail-fast. |
| `createdAt` / `updatedAt` | Date | auto | — | `timestamps:true`. |

**Indexes:** `_id_`, `subscriberUrl_1` unique, `apiSecret_1` unique, `events_1` multikey (`schema.index({events:1})`).
**Relationships:** `Event.deliveryTargets[].subscriberId → Subscriber._id` (snapshot, not populate); `DeliveryLog.subscriberId → Subscriber._id`.
**Created by:** `POST /webhooks/register` (`new Subscriber({subscriberUrl, events, apiSecret, secret})` → virtual encrypts → `save()`).
**Read by:** `authenticateSubscriber`; `POST /events` matching query; worker `findById(subscriberId).select('signingKey isActive')`; `GET /webhooks`, `GET /webhooks/logs`.
**Updated by:** `PATCH /webhooks` (url and/or events), `PATCH /webhooks/events` (events only), `DELETE /webhooks` (`isActive:false`). No hard delete; no secret-rotation endpoint (historical scope note — correctly absent).
**State fields:** `isActive`, `events`, `subscriberUrl`. **Append-only:** none.
**Consistency:** duplicate URL → `11000` → `409`. Secret <32 chars rejected at route (not schema).

### 1.3 Event — `src/models/Event.js`, collection `events`

**Purpose:** Ingested event + delivery-target snapshot + queue-handoff state + idempotency + replay tracking.

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | — | Embedded in BullMQ job IDs, delivery headers (`X-Webhook-Event-Id`), logs. |
| `producerId` | ObjectId ref `Producer` | no (`required:false`, `index:true`) | — | Backward-compat optional. Set on all new ingests. Used for `GET /events/:id` ownership + idempotency scope. |
| `idempotencyKey` | String trimmed | no | `null` | From `Idempotency-Key` header or `idempotencyKey` body field; blank → `null`. |
| `type` | String trimmed | yes | — | `noun.verb` enforced at route (`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`). |
| `payload` | Mixed | yes | — | Arbitrary JSON; must not be `null`/`undefined`. Compared with `JSON.stringify` for idempotency (key-order sensitive). |
| `deliveryTargets` | [{`subscriberId` ObjectId ref `Subscriber` req, `subscriberUrl` String req}] `_id:false` | no | `[]` | Snapshot of `Subscriber.find({events:type,isActive:true})` at ingest. Duplicate-`subscriberId` validator. Secret never snapshotted (code comment). |
| `queueStatus` | String enum | no | `'pending'` | `pending` (not yet queued / Redis failed) \| `queued` (addBulk OK) \| `no_subscribers` (zero targets). **State field.** |
| `queuedJobCount` | Number | no | `0` | N jobs handed to BullMQ; also returned as `jobsQueued`. |
| `queueEnqueuedAt` | Date | no | `null` | Stamped on successful `addBulk`. |
| `lastQueueError` | `{message:String null, code:String null, occurredAt:Date null}` | no | all null | Written when `addBulk` throws; cleared on success. |
| `replayCount` | Number | no | `0` | `$inc` on each DLQ replay. |
| `lastReplayedAt` | Date | no | `null` | Stamped on each replay. |
| `lastReplayJobId` | String | no | `null` | `replay-<dlqId>` of latest replay. |
| `requestId` | String | no | `null` | From `req.requestId` (middleware); propagated to jobs, worker logs, delivery header. |
| `createdAt` / `updatedAt` | Date | auto | — | `createdAt` drives recovery sort. |

**Indexes:** `_id_`; `producerId_1`; `{queueStatus:1,createdAt:1}` (recovery scan `find({queueStatus:'pending'}).sort({createdAt:1})`); `{producerId:1,idempotencyKey:1}` **unique + sparse + partialFilter `{idempotencyKey:{$ne:null}}`** (null keys excluded, unlimited keyless events).
**Created by:** `POST /events` (`Event.create` with producerId, idempotencyKey, type, payload, requestId, deliveryTargets). Duplicate-key `11000` race → resolved to `200` idempotent replay.
**Read by:** `GET /events/:id` (`findById`); idempotency pre-check (`findOne({producerId,idempotencyKey})`); recovery loop (`find({queueStatus:'pending'}).sort().limit()`).
**Updated by:** `queueEventDeliveries` (`findByIdAndUpdate` → queued/no_subscribers/pending + counts + error); `POST /dead-letters/:jobId/replay` (`findByIdAndUpdate` → `$inc replayCount`, stamps). Never deleted.
**State fields:** `queueStatus`, `queuedJobCount`, `queueEnqueuedAt`, `lastQueueError`. **Recovery fields:** above + `deliveryTargets` (re-queued verbatim). **Idempotency fields:** `producerId+idempotencyKey`. **Replay fields:** `replayCount/lastReplayedAt/lastReplayJobId`.
**Consistency:** `queueStatus` describes **handoff to BullMQ only**, not delivery outcome (`queued` ≠ delivered — check `DeliveryLog`).

### 1.4 DeliveryLog — `src/models/DeliveryLog.js`, collection `deliverylogs`

**Purpose:** Append-only audit record per delivery **attempt** (success, retryable failure, and pre-delivery failure).

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `eventId` | ObjectId ref `Event` | yes | — | Populated in `GET /webhooks/logs` (`type payload createdAt requestId`). |
| `subscriberId` | ObjectId ref `Subscriber` | yes | — | Query key for logs endpoint. |
| `subscriberUrl` | String | yes | — | Denormalized dialed URL. |
| `attemptNumber` | Number | yes | — | `job.attemptsMade+1` (1–5). |
| `statusCode` | Number | no | `null` | HTTP status; `null` on network error **and** on pre-delivery failures. |
| `responseBody` | String | no | `null` | `JSON.stringify(response.data)`, truncated to `MAX_DELIVERY_RESPONSE_BODY_CHARS` (8192) + `...[truncated]`; `null` on network/pre-delivery. Bound is audit-only. |
| `success` | Boolean | yes | — | `true` iff 2xx. |
| `errorMessage` | String | no | `null` | `err.message` on failure; `null` on success. |
| `durationMs` | Number | no | `null` | `Date.now()` around Axios call (success + failure); `null` on pre-delivery (no HTTP). |
| `requestId` | String | no | `null` | Propagated tracing ID. |
| `createdAt` | Date | auto | — | Only timestamp (`timestamps:{createdAt:true,updatedAt:false}`). |

**Indexes:** `_id_`; `{subscriberId:1,createdAt:-1}` (logs query newest-first).
**Created by:** worker `persistDeliveryLog` (`DeliveryLog.create`) on every attempt. `rethrowOnFailure:false` default — log-write failure is logged but does not fail delivery.
**Read by:** `GET /webhooks/logs` (`find({subscriberId}).sort({createdAt:-1}).skip().limit().populate('eventId',...)` + `countDocuments`).
**Updated/deleted:** never (append-only; no update or delete path in code).
**State vs audit:** pure audit; `queueStatus` lives on `Event`, outcome lives here.

**[DISCREPANCY — older docs]:** stale sections of `context.md` (pre-update) claimed `Event` had no `{queueStatus,createdAt}` index, `DeliveryLog` had no `{subscriberId,createdAt}` index and had `updatedAt`, and ingestion had no idempotency. All three contradict current schema/routes and are **false** for the current implementation.

---

## 2. Redis

Redis is **not a generic cache** here. It is (a) the BullMQ broker/state store and (b) the rate-limit counter store — on **two separate connections**.

### 2.1 BullMQ connection — `src/config/redis.js`

- Client: `new Redis({host:REDIS_HOST||'localhost', port:REDIS_PORT||6379, maxRetriesPerRequest:null})` — `null` is **required by BullMQ**.
- Shared by: `deliveryQueue`, `deadLetterQueue` (`src/queues/deliveryQueue.js`), worker (`new Worker('webhook-delivery',...)`), recovery/ingest `addBulk`, DLQ replay `add/getJob/getJobs`.
- Behavior: unbounded offline queue + indefinite retries **by design**. During an outage BullMQ halts polling; commands wait rather than fail. This is why readiness races `ping()` against 2s.
- Queues:
  - `webhook-delivery` (main): `attempts:5`, `backoff:{type:'exponential',delay:1000}` (1s→2s→4s→8s + jitter via worker `backoffStrategy`), `removeOnComplete:100`, `removeOnFail:200`.
  - `webhook-dead-letter` (DLQ): `removeOnComplete:500`, `removeOnFail:200`, no attempts/backoff (terminal store).
- Keys/data structures: BullMQ-owned keys (`bull:webhook-delivery:*`, `bull:webhook-dead-letter:*` — hashes, sorted sets for delayed/waiting, lists, streams for events). Not hand-managed; identifiable only as BullMQ internals.
- Queue state: `waiting` / `active` / `delayed` (backoff) / `completed` (kept 100) / `failed` (kept 200). DLQ inspection reads `getJobs(['waiting'])`.
- Deterministic job IDs (custom, colon-free): `event-<eventId>-subscriber-<subscriberId>`; DLQ `dead-letter-<jobId>`; replay `replay-<dlqJobId>`. Duplicate `add` with same ID while job retained → BullMQ dedupes; after eviction (`removeOnComplete:100`) the same ID is treated as new.

### 2.2 Rate-limit connection — `src/config/rateLimitRedis.js` (dedicated, bounded)

- Client: `new Redis({host, port, enableOfflineQueue:false, maxRetriesPerRequest:1})`. Opposite tuning from BullMQ **on purpose**.
- Used only by: `express-rate-limit` + `rate-limit-redis` `RedisStore({sendCommand, prefix:'rl:events:'|'rl:mgmt:'})` in `src/app.js`.
- `sendRateLimitCommand(...args)`: waits for `ready` (`whenUsable`), races against `RATE_LIMIT_REDIS_TIMEOUT_MS` (default 1000ms); **any** failure → throws generic `503 {error:'Service temporarily unavailable'}` (fail-closed, no internals leaked). `passOnStoreError:false` enforces this.
- `registerRateLimitStore` + `ready` listener: re-runs `store.init({windowMs})` on every reconnect so Lua scripts reload (covers boot-while-Redis-down without restart).
- Rate-limit state: Redis keys `rl:events:<ip>` / `rl:mgmt:<ip>` counters with window TTLs (100/min on `/events`, 50/15min on management). In `NODE_ENV==='test'` the store is `undefined` → in-memory fallback (avoids open handles in Jest).
- Reconnect: default ioredis strategy kept; resumes automatically when Redis returns.

### 2.3 What happens when Redis goes down

| Path | BullMQ conn | Rate-limit conn | User-visible |
|---|---|---|---|
| `POST /events` ingress | — | `sendRateLimitCommand` times out ≤1000ms → `503` fail-closed | Request **never reaches** persistence; no `Event` created. |
| `POST /events` after limiter passes, `addBulk` fails | throws → `queueStatus:'pending'` + `lastQueueError` | — | `202 recoveryScheduled:true`; recovery loop re-queues later. |
| Worker polling | stalls; active jobs may stall → reclaimed on reconnect | — | Deliveries pause, then resume; BullMQ retries. |
| `GET /ready` | `ping()` raced 2s → `redis:'disconnected'` | — | `503 {status:'unready'}`. |
| Recovery loop | `addBulk` fails → stays `pending` | — | Retried next tick. |

---

## 3. Cache / transient state — explicit determination

- **Application cache:** none. No response caching, no memoization of DB/Redis reads.
- **Redis as cache:** no. Redis holds **queue state + rate-limit counters**, both authoritative for their purpose, not a cache fronting MongoDB.
- **In-memory cache:** none (except `NODE_ENV==='test'` rate-limit memory store — test-only).
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
| Webhook signing secret | Plaintext supplied by subscriber at register (≥32 chars), transient in `req.body` + `new Subscriber({secret})` | **Stored AES-256-GCM encrypted** in `Subscriber.signingKey` as `ivHex:authTagHex:ciphertextHex` | Key = `WEBHOOK_ENCRYPTION_KEY` (64-hex env). Worker `decrypt()` per delivery; secret also used as HMAC key. Never in job data, never in `Event`, never returned. |
| `WEBHOOK_ENCRYPTION_KEY` | 64-hex env var | **Environment only** (`process.env`), read per encrypt/decrypt; startup-validated (fatal in production) | Example in `.env.example`; must generate fresh for real use. |
| Admin key | Plaintext env `ADMIN_API_KEY` | **Environment only**; compared as SHA-256 hashes with `timingSafeEqual` per request | Missing header → `401`; unconfigured server → `503`; wrong → `401`. Never persisted. |
| `X-Request-Id` | UUID v4 (or safe client value) | Transient header + `Event.requestId` + job data + `DeliveryLog.requestId` | Not a credential; tracing only. |

Distinctions: **hashed** = one-way SHA-256 (API keys, admin compare); **encrypted** = reversible AES-256-GCM (signing secrets); **plaintext transient** = registration responses, `req.body.secret`, decrypted secret inside worker delivery (freed after HMAC); **never plaintext at rest** = signing secrets and management keys.

---

## 6. Data lifecycle

### Producer: register → hash → auth
`POST /producers/register {producerUrl,allowedEvents}` → `validateNoSSRF` → `generateApiKey` → `hashKey` → `Producer.create({producerUrl,apiSecret:hashed,allowedEvents})` → `201 {producerId,apiKey:raw}` (once) → later calls send `x-api-key:raw` → `authenticateProducer` hashes → `findOne({apiSecret:hashed,isActive:true})` → `req.producer`.

### Subscriber: secret → encrypt → decrypt → sign
`POST /webhooks/register {subscriberUrl,events,secret}` → SSRF + validators → `generateApiKey/hashKey` + virtual `secret→encrypt(secret)` → `Subscriber.create` → `201 {subscriberId,apiKey:raw}` → ingest snapshots `{subscriberId,subscriberUrl}` → worker `findById.select('signingKey isActive')` → `decrypt(signingKey)` → `generateSignature(bodyBuffer,secret,timestamp)` → Axios POST with `X-Webhook-Signature`.

### Event → job → log → DLQ/replay
`POST /events {type,payload[,idempotencyKey]}` (+`Idempotency-Key` header) → auth + type/allowedEvents checks → idempotency lookup → `Subscriber.find({events:type,isActive:true})` → `Event.create({producerId,idempotencyKey,type,payload,requestId,deliveryTargets,queueStatus:'pending'})` → `queueEventDeliveries`: zero targets → `no_subscribers/202`; `addBulk` OK → `queued/202`; `addBulk` throws → `pending/202 recoveryScheduled:true` → worker `processDeliveryJob` per target → `DeliveryLog.create` per attempt → 2xx → done; retryable → BullMQ backoff; permanent/`attemptsMade>=5` → `failed` listener → `deadLetterQueue.add('failed-delivery',{...job.data,failureReason,originalJobId,failedAt},{jobId:'dead-letter-<id>'})` → admin `POST /dead-letters/:jobId/replay` → `deliveryQueue.add('deliver',{eventId,subscriberId,subscriberUrl,payload,requestId},{jobId:'replay-<dlqId>'})` + `Event $inc replayCount` (DLQ entry retained).

### Survival matrix

| Restart | MongoDB docs | BullMQ jobs/counters | Rate-limit counters | Logs | In-flight HTTP |
|---|---|---|---|---|---|
| API restart | survive | survive (Redis) | survive (Redis) | survive (file) | dropped (client retries) |
| Worker restart | survive | survive; stalled `active` reclaimed by BullMQ | n/a | survive | dropped; job retried |
| Redis restart | survive | **waiting/delayed jobs may be lost** unless Redis persisted (volume `redis_data` helps; AOF/RDB config not in repo) | counters reset if unpersisted | survive | in-flight dropped |
| MongoDB restart | survive (volume `mongo_data`) | survive | survive | survive | jobs needing `Subscriber` retry |
| Container recreate | survive via volumes/bind mount | survive via `redis_data` (subject to Redis persistence) | same | survive via `./logs` mount | dropped |

Not determinable from the current implementation: exact Redis persistence mode (no `redis.conf`/command in `docker-compose.yml`; default image settings apply).
