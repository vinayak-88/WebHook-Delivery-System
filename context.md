# Project Context: Webhook Delivery System

> **Scope simplification note:** six advanced features were deliberately removed to keep
> the project interview-ready for a 1–2 year backend developer: the EventType registry,
> DLQ monitoring/alerting, per-subscriber timeout config (replaced by a single global
> `WEBHOOK_TIMEOUT_MS`), the secret rotation endpoint, plaintext-secret migration
> compatibility (secrets are now always encrypted), the Redis circuit breaker, and the
> bulk `POST /dead-letters/replay-all` endpoint. Single-job DLQ replay
> (`POST /dead-letters/:jobId/replay`) and its `Event` replay-tracking fields remain.
> A later quality pass added failure classification (permanent `4xx` and deterministic
> pre-delivery failures fail fast via BullMQ `UnrecoverableError`; transient
> DB/network errors retry), `durationMs` delivery timing, and consistent
> `{ "error": ... }` API responses.
> A few older sections below still describe the pre-simplification system; where a
> section conflicts with this note, this note wins.

## 1. Project Overview

The **Webhook Delivery System** is a production-style, asynchronous event fan-out and webhook delivery engine built in Node.js. It accepts event notifications from authenticated producers, matches them against active subscribers subscribed to specific event types, persists the events, and asynchronously delivers payloads to subscriber HTTP endpoints.

### Core Guarantees & Operational Model
- **Delivery Semantic: At-Least-Once Delivery.** The system guarantees that every active subscriber registered for an event type will receive at least one delivery attempt, with automatic retries on failure. It does **not** guarantee exactly-once delivery; duplicate deliveries can occur if subscriber endpoints process a payload but experience a network timeout before returning a response, if retries are triggered, or if duplicate events are ingested.
- **Asynchronous Decoupling:** Event ingestion is completely decoupled from HTTP delivery. The API acknowledges event ingestion immediately (`202 Accepted`), offloading delivery execution to background workers via a Redis-backed queue.
- **Payload Integrity & Authenticity:** Deliveries are signed using HMAC-SHA256 with a timestamp to prevent tampering and replay attacks.
- **Resilience & Auditability:** Transient failures undergo exponential backoff retries. Exhausted jobs escalate to a Dead Letter Queue (DLQ) for inspection and manual replay. Every delivery attempt is recorded in an audit log collection.

---

## 2. Architecture

The system is partitioned into two independent runtime processes: the **API Server** (`src/app.js`) and the **Delivery Worker** (`src/workers/deliveryWorker.js`). They communicate asynchronously via Redis queues managed by BullMQ, sharing MongoDB for state and audit persistence.

```
[ Authenticated Producer ]
            │
            │ POST /events (x-api-key)
            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Express API Server                     │
│  - In-memory rate limiting (100 req/min)                    │
│  - Producer authentication (SHA-256 API key) & event authz  │
│  - Active subscriber matching (Subscriber.events)           │
│  - Persist Event (deliveryTargets snapshot, status: pending)│
│  - Enqueue delivery jobs to BullMQ (deterministic job IDs)  │
│  - Background recovery loop (scans pending events)          │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
       saves Event                     enqueues jobs
               ▼                               ▼
      ┌─────────────────┐             ┌─────────────────┐
      │  MongoDB Store  │             │   Redis Server  │
      │  - Producers    │             │  (BullMQ Queue) │
      │  - Subscribers  │             │ webhook-delivery│
      │  - Events       │             └────────┬────────┘
      │  - DeliveryLogs │                      │
      └────────▲────────┘                      │ pops job
               │                               ▼
┌──────────────┴──────────────────────────────────────────────┐
│                    Delivery Worker Process                  │
│  - Concurrency: configurable (default 5 concurrent jobs)    │
│  - Fetches subscriber signingKey & isActive fresh from DB   │
│  - Signs bodyBuffer + timestamp using HMAC-SHA256           │
│  - HTTP POST to subscriberUrl (5000ms timeout)              │
│  - Persist DeliveryLog (status, body, attempt, latency)     │
│  - BullMQ retry on failure (exponential backoff, 5 attempts)│
└──────────────────────────────┬──────────────────────────────┘
                               │
               [All 5 attempts exhausted]
                               │
                               ▼
                      ┌─────────────────┐
                      │ Dead Letter Q   │
                      │  (BullMQ Queue) │
                      │webhook-dead-lttr│
                      └─────────────────┘
                               │
                      Replay via API:
                      POST /dead-letters/:jobId/replay
```

---

## 3. End-to-End Request/Delivery Flow

### Step 1: Producer Registration
1. A producer registers via `POST /producers/register` providing `producerUrl` and `allowedEvents`.
2. The server generates a random 32-byte hex string (`rawSecret`), computes its SHA-256 hash (`hashedSecret`), and stores the producer record with `apiSecret: hashedSecret`.
3. The server returns `201 Created` with the plaintext `apiKey: rawSecret` (shown once).

### Step 2: Subscriber Registration
1. A subscriber registers via `POST /webhooks/register` with `subscriberUrl`, `events` (array of `noun.verb` strings), and a `secret` (minimum 32 characters).
2. The system validates the URL (HTTPS required in production) and generates a random 32-byte hex API key.
3. The server saves the record: `Subscriber.signingKey` stores the AES-256-GCM encrypted webhook `secret`, and `Subscriber.apiSecret` stores the SHA-256 hash of the generated API key.
4. The server returns `201 Created` with `apiKey` for subscriber management authentication.

### Step 3: Event Ingestion (`POST /events`)
1. An incoming request includes header `x-api-key: <producerApiKey>` and body `{ type, payload }`.
2. Middleware `authenticateProducer` computes SHA-256 of `x-api-key` and checks for an active producer record in MongoDB (`Producer.findOne({ apiSecret: hashed, isActive: true })`).
3. Validation ensures `type` conforms to `noun.verb` regex (`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`) and verifies the producer is authorized to emit that event (`producer.allowedEvents.includes(type)`).
4. The API queries MongoDB for matching active subscribers: `Subscriber.find({ events: type, isActive: true })`.
5. The API creates an `Event` document in MongoDB with `deliveryTargets: [{ subscriberId, subscriberUrl }]` and default `queueStatus: 'pending'`.
6. Delivery job creation:
   - If `deliveryTargets` is empty, `queueStatus` is updated to `'no_subscribers'`, and the API returns `202 Accepted` (`jobsQueued: 0`).
   - If subscribers exist, `deliveryQueue.addBulk(jobs)` enqueues one job per target with deterministic BullMQ job IDs: `event-<eventId>-subscriber-<subscriberId>` (`:` is forbidden in BullMQ custom IDs).
   - On successful queueing: `Event.queueStatus` is updated to `'queued'`, `queuedJobCount` is recorded, `queueEnqueuedAt` is stamped, and the API returns `202 Accepted` (`jobsQueued: N`).
   - If Redis is unreachable during `addBulk`: the catch block updates `Event.queueStatus = 'pending'` and writes `Event.lastQueueError`. The API still returns `202 Accepted` with `recoveryScheduled: true`, deferring enqueueing to the background recovery loop.

### Step 4: Worker Job Processing
1. The delivery worker pops a job from the `webhook-delivery` queue.
2. It extracts `{ eventId, subscriberId, subscriberUrl, payload }` from `job.data`.
3. It performs a fresh database lookup: `Subscriber.findById(subscriberId).select('signingKey isActive')`.
   - If the subscriber no longer exists or `isActive === false`, the worker throws an error, causing BullMQ to fail the attempt.
4. It prepares the delivery payload:
   - Serializes payload: `bodyBuffer = Buffer.from(JSON.stringify(payload))`.
   - Generates millisecond timestamp: `timestamp = Date.now()`.
   - Computes HMAC-SHA256 signature over `${timestamp}.` + `bodyBuffer` using `subscriber.signingKey`.
5. Outgoing HTTP POST:
   - Uses Axios to POST `bodyBuffer` to `subscriberUrl` with a 5000ms timeout.
   - Headers sent:
     - `Content-Type: application/json`
     - `X-Webhook-Signature: <hexSignature>`
     - `X-Webhook-Event-Id: <eventId>`
     - `X-Webhook-Attempt: <attemptNumber>`
     - `X-timestamp: <timestampString>`
6. Logging & Completion:
   - On HTTP 2xx: Persists a `DeliveryLog` record (`success: true`, `statusCode`, `responseBody`), logs success, and BullMQ marks the job completed.
   - On HTTP 4xx/5xx or network timeout/error: Persists a `DeliveryLog` record (`success: false`, `statusCode` or `null`, `errorMessage`), logs a warning, and rethrows the error.

### Step 5: Retry & Dead Letter Queue (DLQ)
1. BullMQ catches the rethrown error and checks `job.attemptsMade`.
2. If `job.attemptsMade < 5`, BullMQ reschedules the job using exponential backoff (`delay = 1000 * 2^(attempt - 1)`).
3. If `job.attemptsMade >= 5` (all 5 attempts exhausted), the worker's `deliveryWorker.on('failed')` listener intercepts the final failure:
   - Adds the job to `deadLetterQueue` (`webhook-dead-letter`) with job name `'failed-delivery'` and deterministic job ID `'dead-letter-' + job.id`.
   - Dead letter job data includes original payload, failure reason, and `failedAt` ISO timestamp.

---

## 4. Tech Stack

| Layer | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **Runtime** | Node.js | v20+ (Alpine in Docker) | Asynchronous JavaScript runtime |
| **Web Framework** | Express.js | ^5.1.0 | REST API routing and middleware |
| **Job Queue** | BullMQ | ^5.61.0 | Distributed job queuing, retries, and backoff |
| **Queue Storage** | Redis / IORedis | ^5.8.2 (Redis 7) | In-memory message broker backing BullMQ |
| **Database** | MongoDB / Mongoose | ^9.3.2 (Mongo 7) | Document persistence for entities and logs |
| **Security/Crypto** | Node.js `crypto` | Built-in | SHA-256 API key hashing, HMAC-SHA256 signing, `timingSafeEqual` |
| **HTTP Client** | Axios | ^1.13.0 | Outbound HTTP delivery to subscriber endpoints |
| **Rate Limiting** | express-rate-limit | ^8.1.0 | Redis-backed rate limiting on a dedicated bounded connection |
| **Logging** | Winston | ^3.18.3 | File and console structured logging |
| **Testing** | Jest | ^30.2.0 | Unit test runner |
| **Containerization**| Docker / Compose | Compose v3.8 | Local multi-service orchestration |
| **CI** | GitHub Actions | Ubuntu Node 20 | Automated CI pipeline on push/PR to main |

---

## 5. Project Structure

```
webhook-delivery-system/
├── .github/
│   └── workflows/
│       └── ci.yml                 # GitHub Actions CI workflow
├── logs/                          # Runtime logs directory (error.log, combined.log)
├── src/
│   ├── app.js                     # Express setup, middleware, routes, graceful shutdown
│   ├── config/
│   │   ├── db.js                  # Mongoose MongoDB connection
│   │   ├── logger.js              # Winston logger configuration
│   │   ├── redis.js               # IORedis client for BullMQ (unbounded retries)
│   │   └── rateLimitRedis.js      # Dedicated bounded IORedis client for rate limiting
│   ├── middlewares/
│   │   ├── authenticateProducer.js   # API key auth for producers
│   │   ├── authenticateSubscriber.js # API key auth for subscriber management
│   │   ├── authenticateAdmin.js      # Admin key auth for DLQ operations
│   │   └── requestId.js              # X-Request-Id propagation
│   ├── mock/
│   │   ├── producer.js            # Mock producer execution script
│   │   └── subscriber.js          # Mock subscriber receiver on port 4000
│   ├── models/
│   │   ├── DeliveryLog.js         # Audit log schema for each delivery attempt
│   │   ├── Event.js               # Event ingestion document schema
│   │   ├── Producer.js            # Producer credentials and permissions schema
│   │   └── Subscriber.js          # Subscriber registry and webhook secrets schema
│   ├── queues/
│   │   └── deliveryQueue.js       # BullMQ deliveryQueue and deadLetterQueue instances
│   ├── routes/
│   │   ├── deadLetters.js         # DLQ inspection and replay endpoints
│   │   ├── events.js              # Event ingestion (POST /events) + status lookup (GET /events/:id)
│   │   ├── producer.js            # Producer registration, event updates, deactivation
│   │   └── webhooks.js            # Subscriber registration, event updates, deactivation, logs
│   ├── tests/
│   │   ├── 16 Jest suites covering auth, HMAC/encryption, SSRF, job schema,
│   │   │   queueing/recovery, delivery classification, idempotency, DLQ replay,
│   │   │   rate-limit Redis behavior, and route health/readiness
│   │   └── (see `src/tests/`; run via `npm test`)
│   ├── utils/
│   │   ├── apiKey.js              # 32-byte key generation and SHA-256 hashing
│   │   ├── encryption.js          # AES-256-GCM secret encryption at rest
│   │   ├── eventQueue.js          # Job building, queueing, and recovery scheduler
│   │   ├── hmac.js                # HMAC signature generation and verification
│   │   ├── jobSchema.js           # Delivery job data validation
│   │   ├── retryPolicy.js         # Transient vs permanent failure rules
│   │   └── ssrf.js                # DNS-based SSRF protection
│   └── workers/
│       └── deliveryWorker.js      # BullMQ worker process, HTTP delivery, DLQ escalation
├── .env                           # Local environment variables (gitignored)
├── .env.example                   # Environment variable template
├── .gitignore
├── Dockerfile                     # Multi-stage production container build
├── docker-compose.yml             # Docker service definitions (app, worker, mongo, redis)
├── gaps.md                        # Architectural gaps and design notes
├── LEFT.md                        # Unimplemented features list
├── package.json                   # Dependencies and npm scripts
└── README.md                      # Project documentation
```

---

## 6. Core Components

### 1. Express API (`src/app.js`)
Serves HTTP endpoints, enforces JSON parsing limits (`BODY_LIMIT`, default `16kb`), captures `req.rawBody`, runs Redis-backed rate limiters on a dedicated bounded connection, mounts route controllers, and registers graceful shutdown handlers (`SIGTERM`, `SIGINT`).

### 2. Delivery Worker (`src/workers/deliveryWorker.js`)
Independent daemon process running a BullMQ `Worker` instance for the `webhook-delivery` queue. Executes HTTP requests, records delivery attempts to MongoDB, handles transient errors, and pushes permanently failing jobs to the DLQ.

### 3. Redis Queue Manager (`src/queues/deliveryQueue.js`)
Initializes the main `deliveryQueue` (`webhook-delivery`) and the `deadLetterQueue` (`webhook-dead-letter`). Defines default retry limits, exponential backoff settings, and job retention policies.

### 4. Event Queue & Recovery Engine (`src/utils/eventQueue.js`)
Constructs deterministic job descriptors, submits bulk queue operations (`addBulk`), marks event queue statuses in MongoDB, and runs the periodic pending event recovery loop.

### 5. Security & HMAC Subsystem (`src/utils/hmac.js`, `src/utils/apiKey.js`)
Handles cryptographic operations: random API key generation, SHA-256 key hashing for database storage, timestamped HMAC-SHA256 signature generation, and constant-time signature verification.

---

## 7. Database Models and Indexes

### `Producer` (`src/models/Producer.js`)
Tracks authorized event emitting clients.
- `producerUrl` (String, required, trimmed, unique, regex validated): URL identifying the producer.
- `apiSecret` (String, required, unique): SHA-256 hash of the generated API key.
- `allowedEvents` ([String], required): Array of event type strings permitted to be fired by this producer. Must be non-empty with no duplicates.
- `isActive` (Boolean, default `true`): Deactivation flag.
- `timestamps`: `createdAt`, `updatedAt`.
- **Indexes:**
  - `_id_` (default primary key)
  - `producerUrl_1` (unique index)
  - `apiSecret_1` (unique index)

### `Subscriber` (`src/models/Subscriber.js`)
Tracks receiving webhook endpoints.
- `subscriberUrl` (String, required, trimmed, unique): Target HTTP/S endpoint.
- `events` ([String], required): Array of event types the subscriber listens to. Must be non-empty with no duplicates.
- `signingKey` (String, required): Webhook secret stored AES-256-GCM encrypted at rest, decrypted by the worker at delivery time to compute HMAC signatures.
- `apiSecret` (String, required, unique): SHA-256 hash of the management API key.
- `isActive` (Boolean, default `true`): Deactivation flag. Deactivated subscribers are excluded from new event deliveries.
- `virtual('secret')`: Virtual setter mapping `secret` directly to `signingKey`.
- `timestamps`: `createdAt`, `updatedAt`.
- **Indexes:**
  - `_id_` (default primary key)
  - `subscriberUrl_1` (unique index)
  - `apiSecret_1` (unique index)
  - `events_1` (multikey index for matching subscribers by event type)

### `Event` (`src/models/Event.js`)
Stores incoming webhook events and delivery target snapshots.
- `type` (String, required, trimmed): Event name in `noun.verb` notation.
- `payload` (Mongoose.Schema.Types.Mixed, required): Arbitrary JSON payload.
- `deliveryTargets` (Array of Subdocuments, `_id: false`, default `[]`): Snapshot of matching subscribers at ingestion time:
  - `subscriberId` (ObjectId, ref `'Subscriber'`, required)
  - `subscriberUrl` (String, required)
  - Custom validator ensures no duplicate `subscriberId` entries.
- `queueStatus` (String, enum `['pending', 'queued', 'no_subscribers']`, default `'pending'`): State of the event handoff to BullMQ.
- `queuedJobCount` (Number, default `0`): Number of BullMQ jobs queued.
- `queueEnqueuedAt` (Date, default `null`): Timestamp when jobs were enqueued to Redis.
- `lastQueueError` (Object):
  - `message` (String, default `null`)
  - `code` (String, default `null`, e.g., `ECONNREFUSED`)
  - `occurredAt` (Date, default `null`)
- `timestamps`: `createdAt`, `updatedAt`.
- **Indexes:**
  - `_id_` (default primary key).
  - *Note:* There is currently **no index** on `queueStatus` or `createdAt` in the schema.

### `DeliveryLog` (`src/models/DeliveryLog.js`)
Immutable audit log for each individual delivery attempt.
- `eventId` (ObjectId, ref `'Event'`, required): Target event reference.
- `subscriberId` (ObjectId, ref `'Subscriber'`, required): Target subscriber reference.
- `subscriberUrl` (String, required): Delivery URL.
- `attemptNumber` (Number, required): Attempt sequence (1 through 5).
- `statusCode` (Number, default `null`): HTTP response code returned by subscriber (`null` on network errors).
- `responseBody` (String, default `null`): Stringified subscriber response body.
- `success` (Boolean, required): `true` if HTTP status is 2xx, `false` otherwise.
- `errorMessage` (String, default `null`): Error message on network failures or Axios exceptions.
- `timestamps`: `createdAt`, `updatedAt`.
- **Indexes:**
  - `_id_` (default primary key).
  - *Note:* There is **no compound index** on `{ subscriberId: 1, createdAt: -1 }`.

---

## 8. Event Ingestion

- **Endpoint:** `POST /events`
- **Authentication:** Requires `x-api-key` header matching an active `Producer` record.
- **Payload Validation:**
  - `type` and `payload` are mandatory.
  - `type` must match `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/` (e.g., `payment.success`, `order.item.created`).
  - The authenticated producer must have `type` listed in its `allowedEvents`. If not, returns `403 Forbidden`.
- **Subscriber Matching:**
  - Performs an array-contains query: `Subscriber.find({ events: type, isActive: true })`.
- **Persistence & Delivery Targets:**
  - Creates the `Event` record immediately in MongoDB with a snapshot of matched subscribers in `deliveryTargets`.
  - Storing the snapshot guarantees that even if a subscriber updates its event subscriptions or is deleted later, this specific event delivery is bound to the subscribers active at the exact time the event was produced.
- **Queue Handoff:**
  - Calls `queueEventDeliveries(event)`:
    - If targets list is empty: sets `Event.queueStatus = 'no_subscribers'`, returns `202 Accepted` (`jobsQueued: 0`).
    - If targets exist: calls `deliveryQueue.addBulk(jobs)` with deterministic job IDs. On success, sets `Event.queueStatus = 'queued'` and returns `202 Accepted` (`jobsQueued: N`).
    - If Redis fails: catches error, updates `Event.queueStatus = 'pending'` with error details, and returns `202 Accepted` with `recoveryScheduled: true`.

---

## 9. Subscriber Registration and Management

- **Endpoint:** `POST /webhooks/register`
  - Body: `{ subscriberUrl, events, secret }`
  - Validation: `secret` must be a string of at least 32 characters; `events` must be a non-empty array of valid `noun.verb` strings; `subscriberUrl` must be a valid URL (enforces `https:` in `NODE_ENV === 'production'`).
  - Key Generation: Generates a 32-byte hex API key (`apiKey`), hashes it with SHA-256 (`apiSecret`).
  - Secret Storage: Encrypts `secret` with AES-256-GCM before storing in `signingKey` in MongoDB via virtual setter.
  - Response (`201 Created`): Returns `subscriberId`, `subscriberUrl`, `events`, and the plaintext `apiKey`.
- **Endpoint:** `PATCH /webhooks/events`
  - Authentication: `authenticateSubscriber` via `x-api-key`.
  - Body: `{ events }` (validated non-empty array of `noun.verb` strings).
  - Updates `subscriber.events` in MongoDB.
- **Endpoint:** `DELETE /webhooks`
  - Authentication: `authenticateSubscriber` via `x-api-key`.
  - Soft-deactivates the subscriber by setting `isActive: false`. No further events will match this subscriber.
- **Endpoint:** `GET /webhooks/logs`
  - Authentication: `authenticateSubscriber` via `x-api-key`.
  - Query parameters: `page` (default 1), `limit` (default 50, max 100).
  - Queries `DeliveryLog.find({ subscriberId: req.subscriber._id })`, sorted `{ createdAt: -1 }`, populating `eventId` fields (`type`, `payload`, `createdAt`).

---

## 10. Queue and Worker Architecture

### BullMQ Queue Configuration (`src/queues/deliveryQueue.js`)
- **Main Queue:** `webhook-delivery`
  - `attempts: 5` (`MAX_DELIVERY_ATTEMPTS`)
  - `backoff.type: 'exponential'`
  - `backoff.delay: 1000` (base delay 1000ms)
  - `removeOnComplete: 100` (retains last 100 completed jobs in Redis)
  - `removeOnFail: 200` (retains last 200 failed jobs in Redis)
- **Dead Letter Queue:** `webhook-dead-letter`
  - `removeOnComplete: 500`
  - `removeOnFail: 200`

### Worker Concurrency & Threading Model
- **Worker Process:** Runs via `node src/workers/deliveryWorker.js`.
- **Concurrency Setting:** `Number(process.env.WORKER_CONCURRENCY) || 5`.
- **Execution Mechanism:** Concurrency in BullMQ is **Node.js event loop concurrency**, not OS-level multithreading or worker threads. The worker executes up to N asynchronous job promises concurrently on the single-threaded Node.js event loop.
- **Graceful Shutdown:** The worker listens for `SIGTERM` and `SIGINT`, invoking `await deliveryWorker.close()` so in-flight HTTP deliveries finish before the process terminates.

---

## 11. Delivery Process

1. **Job Data Ingestion:** The worker extracts `{ eventId, subscriberId, subscriberUrl, payload }` from `job.data`. Note: Webhook signing secrets are **never** stored in job data.
2. **Fresh Subscriber Lookup:** The worker queries MongoDB: `Subscriber.findById(subscriberId).select("signingKey isActive")`.
   - If the subscriber record is missing or `isActive === false`, the worker throws an error: `Subscriber <subscriberId> is inactive or not found`.
3. **Payload Serialization:**
   - `bodyBuffer = Buffer.from(JSON.stringify(payload))`
   - `timestamp = Date.now()`
4. **Signature Calculation:**
   - Decrypts the AES-256-GCM encrypted `subscriber.signingKey`, then computes the HMAC-SHA256 signature over `${timestamp}.` concatenated with `bodyBuffer`.
5. **HTTP POST Request:**
   - Client: Axios
   - URL: `subscriberUrl`
   - Body: Raw `bodyBuffer`
   - Timeout: Global `WEBHOOK_TIMEOUT_MS` (default `5000ms`)
   - Headers:
     - `Content-Type: application/json`
     - `X-Webhook-Signature: <hex>`
     - `X-Webhook-Event-Id: <eventId>`
     - `X-Webhook-Attempt: <attemptNumber>` (derived from `job.attemptsMade + 1`)
     - `X-timestamp: <timestampString>`
6. **Result Persistence:**
   - Success (`2xx`): Creates `DeliveryLog` with `success: true`, `statusCode: response.status`, `responseBody: JSON.stringify(response.data)`. Returns a small serializable summary (`{ statusCode, eventId, subscriberId, attemptNumber }`) — never the raw Axios response, whose circular references would break BullMQ completion bookkeeping and wrongly fail the job.
   - Failure (`4xx`, `5xx`, network error): Creates `DeliveryLog` with `success: false`, `statusCode: err.response?.status || null`, `responseBody: err.response ? JSON.stringify(err.response.data) : null`, `errorMessage: err.message`.
   - The worker rethrows `err` to ensure BullMQ marks the attempt failed and schedules a retry.

---

## 12. HMAC and Security

### Secret Storage & Key Management
- **Webhook Secrets (`signingKey`):** Stored **AES-256-GCM encrypted at rest** in MongoDB (`Subscriber.signingKey`) using the server-side `WEBHOOK_ENCRYPTION_KEY`. The worker decrypts the secret at delivery time to compute HMAC signatures.
- **Management API Keys (`apiSecret`):**
  - Generated using `crypto.randomBytes(32).toString('hex')` (64 hex characters).
  - Hashed using SHA-256: `crypto.createHash('sha256').update(key).digest('hex')`.
  - The plaintext key is returned to the user once on registration; the SHA-256 hash is persisted in `Producer.apiSecret` or `Subscriber.apiSecret`.
- **Enforced Secret Entropy:** Subscriber secrets must be at least 32 characters long, preventing brute-force dictionary attacks.

### Signature Algorithm & Wire Format
- **Algorithm:** HMAC-SHA256.
- **Signed Bytes:**
  `Buffer.concat([ Buffer.from(String(timestamp) + "."), bodyBuffer ])`
- **Output:** 64-character lowercase hex string sent in the `X-Webhook-Signature` header.
- **Verification Function (`src/utils/hmac.js`):**
  ```javascript
  verifySignature(payload, secret, timestamp, receivedSignature)
  ```
- **Replay Protection:** Rejects signatures if `Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000` (5-minute tolerance window) or if timestamp is `NaN`.
- **Timing Attack Mitigation:** Uses `crypto.timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(receivedSignature, 'hex'))` inside a `try...catch` block (catching mismatched buffer lengths) to prevent side-channel timing attacks.

### Request Body Handling
The API configures Express JSON parser with a verification function:
```javascript
express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
  limit: "16kb"
})
```
This preserves the raw wire buffer `req.rawBody` for verification, avoiding property re-ordering issues common in JSON re-serialization.

### SSRF Protection Status
- **Current Protection:** URL syntax validation via `new URL()` plus DNS-based checks in `src/utils/ssrf.js`: hostnames are resolved and every IP is matched against blocked ranges (loopback, RFC 1918 private, link-local/`169.254.x.x` metadata, IPv6 equivalents). Enforces `https:` when `NODE_ENV === 'production'`; Axios uses `maxRedirects: 0`.
- **Bypass (dev/test only):** `DISABLE_SSRF_CHECK=true` skips the check for the localhost mock subscriber. Never enable in production.

---

## 13. Retry and Exponential Backoff

### Retry Schedule
BullMQ calculates retry delays using standard exponential backoff:
$$\text{delay} = \text{baseDelay} \times 2^{\text{attempt} - 1}$$

With `baseDelay = 1000ms` and `MAX_DELIVERY_ATTEMPTS = 5`:

| Attempt | Nature | Delay Before Attempt | Cumulative Elapsed Time |
| :--- | :--- | :--- | :--- |
| **Attempt 1** | Initial execution | Immediate (0s) | 0s |
| **Attempt 2** | Retry 1 | $1000 \times 2^0 = 1000\text{ ms}$ (1s) | ~1s |
| **Attempt 3** | Retry 2 | $1000 \times 2^1 = 2000\text{ ms}$ (2s) | ~3s |
| **Attempt 4** | Retry 3 | $1000 \times 2^2 = 4000\text{ ms}$ (4s) | ~7s |
| **Attempt 5** | Retry 4 (Final) | $1000 \times 2^3 = 8000\text{ ms}$ (8s) | ~15s |

### Failure Behavior
- **Thundering Herd Mitigation:** Exponential backoff spaces out subsequent delivery attempts to allow recovering downstream services time to stabilize.
- **Retry Classification (current):** Only transient failures are retried (network errors, timeouts, `408`, `429`, `5xx`). Permanent client errors (other `4xx`) throw BullMQ's `UnrecoverableError` and escalate to the DLQ immediately without consuming all 5 attempts. See `src/utils/retryPolicy.js`.

---

## 14. Dead Letter Queue

### Escalation Mechanism
A job escalates to the DLQ in either of two cases:
1. Permanent failure: the worker throws BullMQ's `UnrecoverableError` (non-retryable `4xx`), escalated on the first failure.
2. Exhausted retries: `job.attemptsMade >= MAX_DELIVERY_ATTEMPTS` (5) for transient failures.

In both cases BullMQ triggers the `deliveryWorker.on('failed')` event handler, which enqueues the job into `deadLetterQueue` (`webhook-dead-letter`):
   - Job Name: `'failed-delivery'`
   - Job Data:
     ```javascript
     {
       ...job.data,
       failureReason: err.message,
       originalJobId: job.id,
       failedAt: new Date().toISOString()
     }
     ```
   - Job Options: `{ jobId: 'dead-letter-' + job.id }` (deterministic DLQ job ID).

### DLQ Inspection (`GET /dead-letters`)
- Query parameter: `limit` (default 50, range 1 to 100).
- Retrieves jobs in `'waiting'` state from `deadLetterQueue`.
- Formats jobs with: `jobId`, `name`, `state`, `eventId`, `subscriberId`, `subscriberUrl`, `failureReason`, `failedAt`, `originalJobId`, `timestamp`.
- *Security Note:* Protected by `authenticateAdmin` (`X-Admin-Api-Key`); unauthenticated callers receive `401`.

### DLQ Replay (`POST /dead-letters/:jobId/replay`)
- Retrieves the failed job by ID from `deadLetterQueue`.
- Replay Job ID: Constructs deterministic ID `replay-<deadLetterJobId>`.
- In-Flight Replay Guard: Checks `deliveryQueue.getJob(replayJobId)`. If a job exists and its state is neither `'failed'` nor `'completed'`, returns `409 Conflict`.
- Enqueues to main `deliveryQueue`: Adds job `'deliver'` with original data and `{ jobId: replayJobId }`.
- Returns `202 Accepted` with `replayJobId`.
- *Operational Caveats:*
  - Replaying does **not** delete the job from `deadLetterQueue`.
  - Replaying does **not** update the parent `Event.queueStatus` or delivery targets in MongoDB.
  - If a replayed job has already completed or failed previously, re-calling replay will enqueue it again.

---

## 15. Delivery Logging

Every HTTP delivery attempt creates a dedicated `DeliveryLog` record in MongoDB via `persistDeliveryLog`.

### Logged Fields
DeliveryLog records are append-only (`createdAt` only, no `updatedAt`).
- `eventId`: Reference to the `Event`.
- `subscriberId`: Reference to the `Subscriber`.
- `subscriberUrl`: Endpoint URL.
- `attemptNumber`: Attempt sequence (1 through 5).
- `statusCode`: HTTP status code from the subscriber response (`null` if request failed due to DNS, timeout, or TCP reset).
- `responseBody`: JSON-stringified response data (`null` on network errors), truncated to `MAX_DELIVERY_RESPONSE_BODY_CHARS` (default 8192) with a `...[truncated]` marker when longer. The bound applies only to the persisted audit copy, never to delivery behavior.
- `success`: Boolean (`true` for HTTP 2xx, `false` otherwise).
- `errorMessage`: Error string (`err.message`) on failure, `null` on success.
- `durationMs`: Elapsed time of the outbound HTTP attempt in milliseconds (success and failure).
- `createdAt`: Automatic Mongoose timestamp.

### Auditability
Subscribers can inspect their complete delivery log history via `GET /webhooks/logs`. Results are sorted in descending order (`createdAt: -1`) and populated with event details (`type`, `payload`, `createdAt`).

---

## 16. Pending Event Recovery

When Redis is down during event ingestion, the API records the event in MongoDB with `queueStatus: 'pending'` and returns `202 Accepted` (`recoveryScheduled: true`).

### Recovery Engine (`startPendingEventRecovery`)
- **Initialization:** Starts inside `app.listen()` callback in `src/app.js`, ensuring database connection pools are initialized.
- **Interval & Batch Size:**
  - `RECOVERY_INTERVAL_MS`: Defaults to `5000ms`.
  - `RECOVERY_BATCH_SIZE`: Defaults to `25` events.
- **Execution Flow:**
  1. Queries pending events: `Event.find({ queueStatus: 'pending' }).sort({ createdAt: 1 }).limit(batchSize)`.
  2. For each pending event, invokes `queueEventDeliveries(event)`.
  3. On successful `addBulk`, updates `Event.queueStatus = 'queued'` and records `queueEnqueuedAt`.
  4. If queueing fails, logs a warning and leaves `queueStatus: 'pending'` for the next tick.
- **Outage ingress behavior:** rate limiting uses a dedicated connection bounded by `RATE_LIMIT_REDIS_TIMEOUT_MS` (default `1000ms`). If Redis is down when a request arrives, the limiter fails closed with a generic `503` instead of hanging, so the request never reaches event persistence. The `202` + `pending` recovery path therefore covers queue failures after the limiter (e.g. `addBulk` failing while the limiter call succeeded), not a full Redis outage at ingress.

### Multi-Instance Caveat
- The recovery loop is guarded by a process-local variable: `let isRunning = false`.
- **Hazard:** `isRunning` is local to a single Node.js process. In a horizontally scaled deployment with multiple API containers, all instances will independently scan and attempt to recover the same pending events simultaneously.
- **Workaround in Code:** `DISABLE_RECOVERY=true`. Set this environment variable on all API instances except one.
- **Production Solution:** Implement distributed locking (e.g., Redis Redlock or MongoDB leader election) before scaling out API replicas.

---

## 17. Idempotency and Deduplication

### Deduplication Points in Implementation
1. **Initial Queueing:** BullMQ job IDs are deterministic:
   `event-<eventId>-subscriber-<subscriberId>`
   If `queueEventDeliveries` is executed multiple times for the same event (e.g., during recovery retries), BullMQ will ignore duplicate job additions as long as the existing job is still stored in Redis.
2. **Replay Deduplication:** Replay job IDs are deterministic:
   `replay-<deadLetterJobId>`
   Replaying an active or waiting job returns `409 Conflict`.

### Deduplication Limitations & Edge Cases
- **No Ingestion Idempotency:** `POST /events` does not accept an `Idempotency-Key` header and does not enforce a unique constraint on producer payloads. If a producer sends duplicate events, the system creates distinct `Event` documents, generating duplicate delivery jobs.
- **Job Eviction Window:** The delivery queue sets `removeOnComplete: 100`. Once 100 subsequent jobs complete, older completed jobs are purged from Redis. After eviction, re-adding a job with the same ID will treat it as a new job, bypassing Redis deduplication.
- **Subscriber Processing Semantics:** If a subscriber receives a webhook, processes the side effect, but times out or crashes before sending an HTTP response, the worker retries the job. Subscribers must implement idempotency using `X-Webhook-Event-Id`.

---

## 18. Rate Limiting and Validation

### Redis-Backed Rate Limiting (`express-rate-limit` + `rate-limit-redis`)
- **Ingestion Route (`/events`):**
  - Window: 1 minute (`60 * 1000 ms`).
  - Max requests: 100 per IP.
  - Response on limit: `429 { "error": "Too many requests, slow down" }`.
- **Dedicated connection:** rate limiting uses `src/config/rateLimitRedis.js`, separate from the BullMQ connection. Request-time commands are bounded by `RATE_LIMIT_REDIS_TIMEOUT_MS` (default `1000ms`): if Redis is unavailable, the limiter fails closed with a generic `503 { "error": "Service temporarily unavailable" }` instead of hanging the request. The client keeps reconnecting in the background, so normal limiting resumes on its own once Redis returns. BullMQ's connection (`maxRetriesPerRequest: null`) is untouched.
- **Management Routes (`/webhooks`, `/dead-letters`, `/producers`):**
  - Window: 15 minutes (`15 * 60 * 1000 ms`).
  - Max requests: 50 per IP.
- *Limitation:* Counters are stored in process memory. Across $N$ load-balanced instances, the effective limit is $N \times \text{limit}$.

### Payload & Parameter Validation
- Express body parser enforces a strict `16kb` limit (`express.json({ limit: '16kb' })`).
- Event types must follow `noun.verb` lowercase notation: `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`.
- Event arrays (`events` and `allowedEvents`) must be non-empty and contain no duplicate strings.
- Secret lengths must be at least 32 characters.
- URLs must parse via Node's `new URL()` and must use HTTPS in production.

---

## 19. Mock Producer and Subscriber

### Mock Subscriber (`src/mock/subscriber.js`)
- Runs an Express server on port `4000`.
- Listens on `POST /receive`.
- Verifies HMAC signatures with the shared secret (`WEBHOOK_SECRET` env or the built-in dev default, matching the mock producer) using all four `verifySignature` arguments (`payload, secret, timestamp, receivedSignature`).
- Simulates network/server unreliability with a 30% random failure rate (`503 Service Unavailable`) so retry behavior can be demonstrated.

### Mock Producer (`src/mock/producer.js`)
- Script simulating a complete client workflow: registers a producer, registers a subscriber, emits 3 events (`payment.success`, `order.created`, `payment.failed`), sleeps for `DELIVERY_WAIT_MS` (default 20s), and queries delivery logs.
- Uses the current authenticated endpoints throughout: producer registration returns a key passed as `x-api-key` on `POST /events`, and logs are read via authenticated `GET /webhooks/logs`.
- `SUBSCRIBER_URL` env controls the registered subscriber URL (defaults to `http://localhost:4000/receive`; use `http://host.docker.internal:4000/receive` when the API/worker run in Docker with mocks on the host).
- *Note:* the script aborts with the registration error if run twice against the same database (duplicate producer/subscriber URLs return `409`).

---

## 20. API Reference

### Producer Management

#### `POST /producers/register`
Register a new producer client.
- **Auth:** Public / Unauthenticated.
- **Request Body:**
  ```json
  {
    "producerUrl": "https://producer-service.internal",
    "allowedEvents": ["payment.success", "payment.failed", "order.created"]
  }
  ```
- **Validation:** `producerUrl` must be valid URL (HTTPS in production); `allowedEvents` non-empty array of `noun.verb` strings with no duplicates.
- **Response `201 Created`:**
  ```json
  {
    "message": "Producer registered successfully",
    "producerId": "65f1a2b3c4d5e6f7a8b9c001",
    "producerUrl": "https://producer-service.internal",
    "events": ["payment.success", "payment.failed", "order.created"],
    "apiKey": "1a2b3c4d...64_hex_chars"
  }
  ```
- **Error Responses:** `400 Bad Request`, `409 Conflict` (URL already registered), `500 Internal Server Error`.

#### `PATCH /producers/events`
Update allowed event types for an existing producer.
- **Auth:** `x-api-key: <producerApiKey>`
- **Request Body:**
  ```json
  {
    "allowedEvents": ["payment.success", "order.completed"]
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "message": "Events updated successfully",
    "allowedEvents": ["payment.success", "order.completed"]
  }
  ```

#### `DELETE /producers`
Deactivate the authenticated producer.
- **Auth:** `x-api-key: <producerApiKey>`
- **Response `200 OK`:**
  ```json
  {
    "message": "Producer deactivated successfully"
  }
  ```

---

### Subscriber Management

#### `POST /webhooks/register`
Register a new webhook subscriber.
- **Auth:** Public / Unauthenticated.
- **Request Body:**
  ```json
  {
    "subscriberUrl": "https://subscriber.example.com/webhook",
    "events": ["payment.success", "payment.failed"],
    "secret": "my-secure-webhook-secret-at-least-32-chars-long"
  }
  ```
- **Validation:** `secret` minimum 32 characters; `events` array of `noun.verb` strings; `subscriberUrl` HTTPS in production.
- **Response `201 Created`:**
  ```json
  {
    "message": "Subscriber registered successfully",
    "subscriberId": "65f1a2b3c4d5e6f7a8b9c010",
    "subscriberUrl": "https://subscriber.example.com/webhook",
    "events": ["payment.success", "payment.failed"],
    "apiKey": "5e6f7a8b...64_hex_chars"
  }
  ```

#### `PATCH /webhooks/events`
Update subscribed event types.
- **Auth:** `x-api-key: <subscriberApiKey>`
- **Request Body:**
  ```json
  {
    "events": ["payment.success", "invoice.paid"]
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "message": "Events updated successfully",
    "events": ["payment.success", "invoice.paid"]
  }
  ```

#### `DELETE /webhooks`
Deactivate the authenticated subscriber.
- **Auth:** `x-api-key: <subscriberApiKey>`
- **Response `200 OK`:**
  ```json
  {
    "message": "Subscriber deactivated successfully"
  }
  ```

#### `GET /webhooks/logs`
View delivery attempt history for the authenticated subscriber.
- **Auth:** `x-api-key: <subscriberApiKey>`
- **Query Parameters:** `page` (default 1), `limit` (default 50, max 100).
- **Response `200 OK`:**
  ```json
  {
    "subscriberId": "65f1a2b3c4d5e6f7a8b9c010",
    "total": 2,
    "page": 1,
    "limit": 50,
    "pages": 1,
    "logs": [
      {
        "_id": "65f1a2b3c4d5e6f7a8b9c099",
        "eventId": {
          "_id": "65f1a2b3c4d5e6f7a8b9c050",
          "type": "payment.success",
          "payload": { "orderId": "ORD-123", "amount": 4999 },
          "createdAt": "2026-03-20T10:00:00.000Z"
        },
        "subscriberId": "65f1a2b3c4d5e6f7a8b9c010",
        "subscriberUrl": "https://subscriber.example.com/webhook",
        "attemptNumber": 1,
        "statusCode": 200,
        "responseBody": "{\"received\":true}",
        "success": true,
        "errorMessage": null,
        "createdAt": "2026-03-20T10:00:01.200Z"
      }
    ]
  }
  ```

---

### Event Ingestion

#### `POST /events`
Ingest an event and enqueue deliveries.
- **Auth:** `x-api-key: <producerApiKey>`
- **Request Body:**
  ```json
  {
    "type": "payment.success",
    "payload": {
      "orderId": "ORD-9999",
      "amount": 2500,
      "currency": "USD"
    }
  }
  ```
- **Responses:**
  - `202 Accepted` (Jobs queued):
    ```json
    {
      "message": "Event accepted and queued for delivery",
      "eventId": "65f1a2b3c4d5e6f7a8b9c050",
      "jobsQueued": 2
    }
    ```
  - `202 Accepted` (No subscribers matched):
    ```json
    {
      "message": "Event accepted — no active subscribers for this event type",
      "eventId": "65f1a2b3c4d5e6f7a8b9c051",
      "jobsQueued": 0
    }
    ```
  - `202 Accepted` (Redis down, deferred to recovery):
    ```json
    {
      "message": "Event accepted; delivery queue is temporarily unavailable and recovery will retry automatically",
      "eventId": "65f1a2b3c4d5e6f7a8b9c052",
      "jobsQueued": 0,
      "recoveryScheduled": true
    }
    ```
  - `400 Bad Request`: Missing fields or invalid event type format.
  - `401 Unauthorized`: Missing or invalid producer API key.
  - `403 Forbidden`: Producer is not authorized for this event type.

---

### Dead Letter Queue

#### `GET /dead-letters`
List permanently failed delivery jobs waiting in DLQ.
- **Auth:** Public / None.
- **Query Parameters:** `limit` (default 50, max 100).
- **Response `200 OK`:**
  ```json
  {
    "count": 1,
    "jobs": [
      {
        "jobId": "dead-letter-event-65f1a2b3c4d5e6f7a8b9c050-subscriber-65f1a2b3c4d5e6f7a8b9c010",
        "name": "failed-delivery",
        "state": "waiting",
        "eventId": "65f1a2b3c4d5e6f7a8b9c050",
        "subscriberId": "65f1a2b3c4d5e6f7a8b9c010",
        "subscriberUrl": "https://subscriber.example.com/webhook",
        "failureReason": "connect ECONNREFUSED 192.0.2.1:443",
        "failedAt": "2026-03-20T10:15:30.000Z",
        "originalJobId": "event-65f1a2b3c4d5e6f7a8b9c050-subscriber-65f1a2b3c4d5e6f7a8b9c010",
        "timestamp": "2026-03-20T10:15:30.120Z"
      }
    ]
  }
  ```

#### `POST /dead-letters/:jobId/replay`
Re-enqueue a DLQ job into the delivery queue.
- **Auth:** Public / None.
- **Path Parameter:** `jobId` (the DLQ job identifier).
- **Responses:**
  - `202 Accepted`:
    ```json
    {
      "message": "Dead-letter job replayed",
      "deadLetterJobId": "dead-letter-event:...",
      "replayJobId": "replay-dead-letter-event:..."
    }
    ```
  - `404 Not Found`: Dead letter job does not exist in DLQ.
  - `409 Conflict`: Replay job is already active or waiting in `webhook-delivery`.

---

### System Health

#### `GET /health`
Liveness check.
- **Auth:** None.
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "timestamp": "2026-03-20T10:20:00.000Z"
  }
  ```
- *Limitation:* Shallow check; does not verify MongoDB connection state or Redis reachability.

---

## 21. Delivery Request Format

When delivering a webhook payload to a subscriber endpoint, the worker transmits an HTTP POST with the following specification:

```http
POST /receive HTTP/1.1
Host: subscriber.example.com
Content-Type: application/json
X-Webhook-Signature: a3f87b8d80f08960fa291b8d2345e8d895b6c039d91f24d1e2a3b4c5d6e7f8a9
X-Webhook-Event-Id: 65f1a2b3c4d5e6f7a8b9c050
X-Webhook-Attempt: 1
X-timestamp: 1710928800000
Content-Length: 53

{"orderId":"ORD-9999","amount":2500,"currency":"USD"}
```

### Verification Implementation Example (Subscriber Side)
```javascript
const crypto = require('crypto');
const express = require('express');
const app = express();

// Capture exact wire bytes before JSON parsing
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const WEBHOOK_SECRET = 'your-shared-secret-at-least-32-chars';

app.post('/receive', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-timestamp'];

  // 1. Replay attack prevention: verify timestamp freshness (< 5 minutes)
  const TOLERANCE_MS = 5 * 60 * 1000;
  const now = Date.now();
  const ts = Number(timestamp);

  if (isNaN(ts) || Math.abs(now - ts) > TOLERANCE_MS) {
    return res.status(401).json({ error: 'Timestamp out of tolerance window' });
  }

  // 2. Compute expected HMAC-SHA256: timestamp + '.' + rawBody
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${String(timestamp)}.`)
    .update(req.rawBody)
    .digest('hex');

  // 3. Constant-time comparison to prevent timing side-channel attacks
  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    isValid = false;
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  // Process event payload...
  return res.status(200).json({ received: true });
});
```

---

## 22. Important Design Decisions and Tradeoffs

| Decision | Implementation Rationale | Tradeoff / Operational Cost |
| :--- | :--- | :--- |
| **Decoupled Worker Process** | Worker runs in separate Node.js process; API returns `202 Accepted` immediately. Slow subscriber endpoints cannot saturate API event loops or HTTP sockets. | Operational overhead: requires deploying, monitoring, and scaling two distinct application processes. |
| **Redis/BullMQ for Queueing** | Built-in exponential backoff, job state transitions, concurrency limits, and persistence. | Redis becomes a single point of failure for real-time delivery unless deployed with Redis Sentinel or Redis Cluster. |
| **Encrypted Signing Key Storage** | `Subscriber.signingKey` is AES-256-GCM encrypted at rest; the worker decrypts it per delivery. Avoids a total secret leak on MongoDB read compromise. | Per-delivery decryption cost and a server-side `WEBHOOK_ENCRYPTION_KEY` that must be managed/rotated out of band. |
| **Timestamp Prepended to HMAC** | Signs `${timestamp}.${bodyBuffer}` and enforces a 5-minute replay window. | Subscriber verification logic is strictly coupled to the timestamp header format and clock synchronization. |
| **Delivery Target Snapshotting** | Subscribed endpoints are snapshotted into `Event.deliveryTargets` at ingestion time. | Prevents retroactively adding subscribers to past events; adds document size overhead to the `events` collection. |
| **Deterministic BullMQ Job IDs** | Job ID formatted as `event-<id>-subscriber-<id>` (`:` is illegal in BullMQ custom IDs). Prevents duplicate jobs in Redis during recovery ticks. | Does not prevent re-queueing once completed jobs are evicted past `removeOnComplete: 100`. |
| **Redis-Backed Rate Limiting** | Uses `express-rate-limit` with `rate-limit-redis` on a dedicated connection, so limits hold across API replicas. | The dedicated connection must stay reachable; if Redis is down the limiter fails closed with a bounded `503` instead of accepting un-limited traffic. |

---

## 23. Failure Scenarios

### 1. MongoDB Outage
- **During Event Ingestion:** `Producer.findOne`, `Subscriber.find`, or `Event.create` will throw. The API returns `500 Internal Server Error`. The event is not accepted or queued.
- **During Worker Delivery:** The worker cannot fetch `Subscriber` details. The job attempt throws and will be retried by BullMQ. If Mongo is down when writing `DeliveryLog`, the worker catches and logs the failure (`rethrowOnFailure: false`), allowing HTTP delivery to proceed if already sent.
- **During Recovery Loop:** The recovery query throws and logs an error; the timer continues to attempt scans on subsequent intervals.

### 2. Redis Outage
- **During Event Ingestion:** `Event.create` persists the event to MongoDB with `queueStatus: 'pending'`. The `deliveryQueue.addBulk` call fails. The catch block marks `Event.lastQueueError` with the failure details and returns `202 Accepted` with `recoveryScheduled: true`. Once Redis recovers, the background recovery loop automatically queues the pending events.
- **During Worker Execution:** IORedis emits reconnection errors. BullMQ halts job polling until the Redis connection is re-established. Active jobs may stall and be reclaimed upon reconnection.

### 3. Downstream Subscriber Errors (4xx vs 5xx)
- **HTTP 4xx (Client Errors, e.g., 400, 401, 404):** Other `4xx` responses are permanent failures. The worker persists a failed `DeliveryLog` and throws BullMQ's `UnrecoverableError`, escalating to the DLQ on the first failure without consuming all 5 attempts.
- **Retryable statuses (`408`, `429`):** Treated as transient and retried like `5xx`.
- **HTTP 5xx (Server Errors, e.g., 500, 502, 503):** Handled as transient failures. Retried across 5 attempts with exponential backoff.
- **Network Timeouts / Connection Refusal:** Axios times out at the global `WEBHOOK_TIMEOUT_MS` or fails immediately on `ECONNREFUSED`. Persists `DeliveryLog` with `statusCode: null` and `errorMessage: err.message`. Retried by BullMQ.
- **Pre-delivery failures:** Missing/inactive subscribers and deterministic signing failures (undecryptable secret, HMAC preparation) fail fast via `UnrecoverableError` with `statusCode: null` audit logs. Transient `Subscriber.findById` database errors propagate so BullMQ retries them.

### 4. Retry Exhaustion & DLQ Movement
- When all 5 delivery attempts fail, BullMQ emits `failed` on `deliveryWorker`.
- The worker verifies `job.attemptsMade >= 5` and pushes the job to `webhook-dead-letter` with `jobId: dead-letter-<id>`.
- The job is permanently preserved in the DLQ until manually replayed or evicted via DLQ retention limits (`removeOnComplete: 500`, `removeOnFail: 200`).

### 5. API or Worker Crashes & Restarts
- **API Server Crash:**
  - On `SIGTERM`/`SIGINT`, graceful shutdown stops accepting new requests, stops the recovery timer, closes BullMQ queues, and closes Mongoose connections.
  - On abrupt crash (`SIGKILL`), un-queued events remain in MongoDB with `queueStatus: 'pending'` and are queued by the recovery loop when an API instance restarts.
- **Worker Process Crash:**
  - On `SIGTERM`/`SIGINT`, `deliveryWorker.close()` waits for active jobs to complete.
  - On abrupt crash (`SIGKILL`), jobs actively being processed in Redis become stalled. When a worker restarts, BullMQ's stalled job detection mechanism re-assigns the job for delivery.

---

## 24. Testing

### Test Suite Overview
Unit tests are located in `src/tests/` and run via `jest --runInBand src/tests`
(16 suites, 122 tests, all passing; no full end-to-end coverage — routes and
workers are tested with mocked dependencies).

- **Crypto/auth:** `hmac.test.js` (signing, tampering, replay window), `encryption.test.js` (AES-GCM round-trip, wrong-key/tamper rejection), `auth.test.js` + `admin.test.js` (missing/invalid/inactive keys).
- **Delivery core:** `retry.test.js` (worker execution, 200/503/network paths), `delivery.test.js` (retry classification, pre-delivery failures, DLQ escalation, timeout/no-redirect safeguards, `durationMs`, response-body bound), `retryPolicy.test.js` (transient vs permanent rule matrix), `deliveryLog.test.js` (append-only schema: `createdAt` present, `updatedAt` absent).
- **Queueing/recovery:** `eventQueue.test.js` (deterministic job IDs, bulk queueing, `no_subscribers`), `recovery.test.js` (pending stays pending on Redis failure, queues when back), `jobSchema.test.js` (job data validation).
- **Routes/security/ops:** `idempotency.test.js` (create → duplicate → 409, header + body keys), `deadLetters.test.js` (admin auth, single replay 202/409/404), `ssrf.test.js` (blocked ranges, bypass flag), `routes.test.js` (health/readiness, request IDs, body limit), `rateLimitRedis.test.js` (dedicated connection, timeout bound, fail-closed 503, BullMQ isolation).

### Historical test notes (resolved; kept for context)
Earlier versions of this file recorded test/implementation mismatches that have
since been fixed: outdated HMAC timestamp arguments, model mock casing,
missing `isActive` in mocks, IORedis open handles in Jest, and stale mock
scripts. If a section below still describes one of these as current, the
passing suite above takes precedence.

---

## 25. Running Locally

### Prerequisites
- Node.js v20+
- MongoDB v7+ (running on `localhost:27017`)
- Redis v7+ (running on `localhost:6379`)

### Setup Instructions

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Ensure `WEBHOOK_ENCRYPTION_KEY` is a valid 64-char hex string (an example value ships in `.env.example`; generate a fresh one for anything real). Set `ADMIN_API_KEY` for DLQ access. Mocks read `WEBHOOK_SECRET` (shared HMAC secret, min 32 chars) from the environment, defaulting to a built-in dev value.

3. **Start the API Server (Terminal 1):**
   ```bash
   npm start
   # or with hot-reloading:
   npm run dev
   ```

4. **Start the Delivery Worker (Terminal 2):**
   ```bash
   npm run worker
   ```

5. **Run Mock Subscriber (Terminal 3, optional):**
   ```bash
   npm run mock:subscriber
   ```

6. **Run Tests:**
   ```bash
   npm test
   ```

---

## 26. Environment Variables

| Variable | Description | Default / Required |
| :--- | :--- | :--- |
| `PORT` | HTTP port for the Express API server | `3000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017/webhook-delivery` |
| `REDIS_HOST` | Redis host address | `localhost` |
| `REDIS_PORT` | Redis port number | `6379` |
| `NODE_ENV` | Environment mode (`development`, `production`, `test`) | `development` |
| `BODY_LIMIT` | Max JSON body size for incoming requests | `16kb` |
| `WEBHOOK_ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM secret encryption at rest | Required in production |
| `ADMIN_API_KEY` | Admin key for DLQ inspection & replay (`X-Admin-Api-Key`) | Required for DLQ routes |
| `WEBHOOK_TIMEOUT_MS` | Global timeout for outbound webhook delivery requests | `5000` |
| `WORKER_CONCURRENCY` | Number of concurrent jobs processed by the delivery worker | `5` |
| `RETRY_JITTER_MS` | Max random jitter added to exponential backoff delays | `500` |
| `RATE_LIMIT_REDIS_TIMEOUT_MS` | Upper bound per rate-limit Redis round-trip (fail-closed 503 past it) | `1000` |
| `MAX_DELIVERY_RESPONSE_BODY_CHARS` | Max subscriber response text kept per DeliveryLog | `8192` |
| `SHUTDOWN_TIMEOUT_MS` | Max wait before forced exit during graceful shutdown | `10000` |
| `RECOVERY_INTERVAL_MS` | Milliseconds between pending event recovery scans | `5000` |
| `RECOVERY_BATCH_SIZE` | Maximum number of pending events scanned per tick | `25` |
| `DISABLE_RECOVERY` | If `'true'`, disables the background pending recovery loop | `false` |
| `DISABLE_SSRF_CHECK` | If `'true'`, allows deliveries to localhost/private IPs (dev/test only) | `false` |
| `WEBHOOK_SECRET` / `BASE_URL` / `SUBSCRIBER_URL` / `DELIVERY_WAIT_MS` | Mock producer/subscriber demo config only | dev defaults (see `.env.example`) |

---

## 27. Docker and CI

### Dockerfile
- Base image: `node:20-alpine`.
- Workdir: `/app`.
- Production install: `npm install --production`.
- Creates `logs/` directory.
- Exposes port `3000`.
- Default command: `CMD ["node", "src/app.js"]`.

### Docker Compose (`docker-compose.yml`)
Orchestrates four services:
1. `app`: Builds local Dockerfile, runs API server, mounts `./logs:/app/logs`, exposes port `3000`. Depends on `mongo` and `redis` healthchecks.
2. `worker`: Builds local Dockerfile with override `command: node src/workers/deliveryWorker.js`, mounts `./logs:/app/logs`. Depends on `mongo` and `redis` healthchecks.
3. `mongo`: Official `mongo:7`, healthchecked via `mongosh --eval "db.adminCommand('ping')"`, persists data to volume `mongo_data`.
4. `redis`: Official `redis:7-alpine`, healthchecked via `redis-cli ping`, persists data to volume `redis_data`.

To start all services:
```bash
docker-compose up --build
```

### Continuous Integration (`.github/workflows/ci.yml`)
- Triggered on push and pull requests to branch `main`.
- Runner: `ubuntu-latest`.
- Steps: Checks out repository, sets up Node.js 20 with npm cache, runs `npm install`, and executes `npm test`.

---

## 28. Known Limitations and Production Gaps

> **Note:** items 1–4, 6, 7 and 10–12 below were addressed in later implementation
> rounds (encrypted secrets at rest, DNS-based SSRF checks, ingestion idempotency,
> MongoDB indexes, Redis-backed rate limiting, DLQ admin auth, global
> `WEBHOOK_TIMEOUT_MS`, `GET /ready` readiness check, fixed tests and mocks,
> failure classification (permanent `4xx` and deterministic pre-delivery
> failures fail fast via `UnrecoverableError`; transient DB/network errors retry).
> Items 5 and 9 remain open.

1. **Plaintext Secret Storage:** `Subscriber.signingKey` is stored in plaintext in MongoDB. An attacker with read access to the database can forge deliveries to all subscribers.
2. **Lack of SSRF Mitigation:** `subscriberUrl` and `producerUrl` validation only checks URL format and HTTPS protocol in production. Private IP ranges (e.g., `127.0.0.1`, `10.0.0.0/8`, AWS metadata endpoint `169.254.169.254`) are not resolved or blocked.
3. **No Ingestion Idempotency (`POST /events`):** No `Idempotency-Key` header or deduplication index exists. Producer retries result in duplicate events and multiple deliveries to subscribers.
4. **Missing Database Indexes:**
   - `Event.queueStatus` is unindexed; the recovery loop performs a full collection scan every 5 seconds.
   - `DeliveryLog` lacks a compound index on `{ subscriberId: 1, createdAt: -1 }`, requiring in-memory sorting when querying subscriber logs.
5. **No Distributed Locking on Event Recovery:** The recovery loop uses an in-process boolean flag (`isRunning`). Running multiple API replicas without `DISABLE_RECOVERY=true` causes overlapping recovery queries and duplicate queue additions.
6. **In-Memory Rate Limiting:** `express-rate-limit` maintains counters in process memory instead of Redis. The effective rate limit scales linearly with the number of API instances.
7. **Unauthenticated DLQ Endpoints:** `GET /dead-letters` and `POST /dead-letters/:jobId/replay` lack authentication middleware, allowing unauthorized inspection and replay of failed jobs.
8. **Blind Retrying on 4xx Client Errors:** (Fixed — kept as historical note.) The worker now distinguishes permanent `4xx` failures (fail fast via `UnrecoverableError`) from transient `408`/`429`/`5xx`/network errors (retried). See `src/utils/retryPolicy.js` and §13.
9. **Incomplete DLQ Replay State:** Replaying a job from the DLQ does not remove it from the DLQ queue, nor does it update `Event.queueStatus` in MongoDB.
10. **Hardcoded Delivery Timeout:** Outgoing Axios requests have a fixed 5000ms timeout with no per-subscriber timeout configurability.
11. **Shallow Health Check:** `GET /health` returns `{ status: "ok" }` unconditionally without checking MongoDB or Redis connectivity.
12. **Outdated Tests and Mock Scripts:** Test files and mock scripts in the repository have syntax and interface mismatches with current function signatures (such as timestamp handling in HMAC verification and API key headers in mock scripts).