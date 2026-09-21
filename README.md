# Webhook Delivery System

An asynchronous webhook delivery system built with Node.js, Express, MongoDB, Redis, and BullMQ. Producers submit events through an authenticated API; the system persists them, fans them out to matching subscribers, and delivers each payload over HTTP with HMAC signing — retrying transient failures, supporting idempotent ingestion, parking permanently failed jobs in a dead letter queue, and recording every attempt in an audit log.

It follows the same patterns most webhook systems rely on: asynchronous delivery, retries with backoff, request signing, idempotency, DLQ handling, and delivery auditing — kept small enough to run locally and explain end to end.

---

## Architecture

```
[Event Producer]
      │
      ▼
POST /events ──► [Express API] ──► [MongoDB: Event (pending)]
                                      │
                     ┌────────────────┴───────────────┐
                     │ enqueue OK                     │ enqueue failed (Redis down)
                     ▼                                ▼
              [BullMQ Queue] ──► [Delivery Worker]   [stays pending]
                       │                              ──► recovery loop re-enqueues
                       │                                    deterministic jobs later
                       │                           ┌───────────┴───────────┐
                       │                           │                       │
                       ▼                           ▼                       ▼
                [MongoDB]                    [Success]               [Failure]
                - Events                          │                       │
                - Subscribers                     ▼                       ▼
                - DeliveryLogs           [DeliveryLog]         [Retry w/ backoff]
                                         (persisted)                      │
                                                                [Retries exhausted
                                                                 or permanent 4xx]
                                                                          │
                                                                          ▼
                                                                [Dead Letter Queue]
                                                      (inspect + single-job replay)
```

---

## Key Design Decisions

### Why 202 Accepted instead of 200 OK on POST /events?
Delivery is asynchronous — the API queues the job and returns immediately without waiting for the subscriber to respond. Returning 200 would imply the delivery already succeeded, which is false. 202 accurately signals "received and queued, not yet delivered."

### Why exponential backoff instead of fixed-interval retry?
Fixed-interval retry (every 5 seconds regardless) causes a thundering herd problem — if a subscriber goes down and 10,000 events are queued, all 10,000 hammer the subscriber the moment it comes back up, likely taking it down again. Exponential backoff (1s → 2s → 4s → 8s) spreads the load and gives the subscriber time to recover.

### Why HMAC-SHA256 for payload signing?
When the worker delivers to a subscriber URL, the subscriber has no way to know if the request genuinely came from this server or from an attacker who discovered their endpoint. HMAC solves this: both parties share a secret at registration time, and every delivery is signed with it. The subscriber recomputes the hash and compares — if they match, the request is authentic.

### Why timingSafeEqual instead of === for signature comparison?
String comparison with === short-circuits — it stops at the first non-matching character. An attacker can measure tiny differences in response time to guess the correct signature one character at a time (timing attack). `crypto.timingSafeEqual` always takes the same amount of time regardless of where the mismatch is, reducing exposure to timing side-channel attacks.

### Why a dead letter queue?
Jobs that fail permanently — a non-retryable subscriber response, or all retry attempts exhausted — don't silently disappear. They land in a dead letter queue where they can be inspected and manually replayed. Without this, permanently failed deliveries are invisible — you'd have no way to know a subscriber missed critical events.

### Why separate worker process instead of inline delivery?
If delivery happened synchronously inside the POST /events handler, a slow or unresponsive subscriber would block the API. Separating the worker means the API stays fast and available regardless of subscriber behavior.

---

## API Reference

### Register a Subscriber
```
POST /webhooks/register
Content-Type: application/json

{
  "subscriberUrl": "https://your-service.com/webhook",
  "events": ["payment.success", "payment.failed"],
  "secret": "a-shared-secret-at-least-32-characters-long"
}

Response 201:
{
  "message": "Subscriber registered successfully",
  "subscriberId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "subscriberUrl": "https://your-service.com/webhook",
  "events": ["payment.success", "payment.failed"],
  "apiKey": "64-hex-char-management-key-shown-once"
}
```

> The `secret` (min 32 chars) is AES-256-GCM encrypted before storage and never returned. The `apiKey` is shown once — pass it as the `x-api-key` header for subscriber management calls (`PATCH /webhooks`, `DELETE /webhooks`, `GET /webhooks/logs`).

### Register a Producer
Producers authenticate with `x-api-key` when ingesting events. Registration returns the key once:
```
POST /producers/register
Content-Type: application/json

{
  "producerUrl": "https://your-service.com",
  "allowedEvents": ["payment.success"]
}

Response 201:
{
  "message": "Producer registered successfully",
  "producerId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "apiKey": "64-hex-char-management-key-shown-once"
}
```
Producers can only fire event types in their `allowedEvents` (otherwise `403`).

### Update a subscription
```
PATCH /webhooks/events
x-api-key: <subscriber-key>
Content-Type: application/json

{ "events": ["payment.success", "invoice.paid"] }
```
`PATCH /webhooks` similarly updates the subscriber URL and/or event list.

### Deactivate a Subscriber
```
DELETE /webhooks

Response 200:
{
  "message": "Subscriber deactivated successfully"
}
```

### View Delivery Logs
```
GET /webhooks/logs

Response 200:
{
  "subscriberId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "logs": [
    {
      "attemptNumber": 2,
      "statusCode": 200,
      "responseBody": "{\"received\":true}",
      "success": true,
      "errorMessage": null,
      "durationMs": 87,
      "createdAt": "2024-01-15T10:23:03.000Z"
    }
  ]
}
```

> Delivery logs are append-only (records carry `createdAt`, no `updatedAt`). Subscriber response text is kept up to `MAX_DELIVERY_RESPONSE_BODY_CHARS` (default 8192) per record — longer bodies are truncated with a `...[truncated]` marker. Truncation applies only to the persisted audit copy, never to delivery behavior.

### Ingest an Event
```
POST /events
x-api-key: <producer-key>
Content-Type: application/json

{
  "type": "payment.success",
  "payload": {
    "orderId": "ORD-123",
    "amount": 4999,
    "currency": "INR"
  }
}

Response 202:
{
  "message": "Event accepted and queued for delivery",
  "eventId": "64f1a2b3c4d5e6f7a8b9c0d2",
  "jobsQueued": 2
}
```

### Ingest an Event idempotently
Send an `Idempotency-Key` header (or `idempotencyKey` body field). The key is scoped to your producer:
- first request → `202`, event created and queued
- same key + same type/payload → `200` with `isDuplicate: true`, no duplicate event or jobs
- same key + different type/payload → `409 Conflict`
```
POST /events
x-api-key: <producer-key>
Idempotency-Key: abc123
```

### Check an Event's status
```
GET /events/:id
x-api-key: <producer-key>

Response 200:
{
  "eventId": "64f1a2b3c4d5e6f7a8b9c0d2",
  "type": "payment.success",
  "queueStatus": "queued",
  "queuedJobCount": 2,
  "queueEnqueuedAt": "2024-01-15T10:23:01.000Z",
  "replayCount": 0,
  "createdAt": "2024-01-15T10:23:00.000Z"
}
```
Only the producer that created the event can read it (otherwise `403`); unknown IDs return `404`. Note that `queueStatus` describes the event's handoff state (`pending`, `queued`, or `no_subscribers`), not the downstream delivery result — `queued` means jobs were handed to BullMQ, not that the subscriber received them. Use `GET /webhooks/logs` for per-attempt delivery outcomes.

---

## How Delivery Works

Every outgoing request includes:
```
POST https://your-service.com/webhook
Content-Type: application/json
X-Webhook-Signature: <hmac-sha256-hex>
X-Webhook-Event-Id: <eventId>
X-Webhook-Attempt: <attemptNumber>
X-timestamp: <unix-ms>
X-Request-Id: <request-id>

{ ...your event payload }
```
Deliveries use a single global timeout (`WEBHOOK_TIMEOUT_MS`, default 5000ms) and never follow redirects (`maxRedirects: 0`).

### Verifying the signature on your end (Node.js example)
```javascript
const crypto = require('crypto')
const express = require('express')
const app = express()

// Capture raw body bytes before JSON parsing.
// Verification must run against the exact bytes received over the wire —
// not a re-serialised object, which can differ in property order.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}))

// The server signs timestamp + '.' + raw body bytes with your plaintext
// secret as the HMAC key (the secret itself is AES-256-GCM encrypted at rest
// server-side — it is never transmitted). Mirror that exactly:
const timestamp = req.headers['x-timestamp']

// 1. Reject stale timestamps first (5-minute replay window, like the server)
if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
  return res.status(401).json({ error: 'Timestamp out of tolerance window' })
}

app.post('/webhook', (req, res) => {
  const received = req.headers['x-webhook-signature']
  const expected = crypto
    .createHmac('sha256', YOUR_PLAINTEXT_SECRET)
    .update(`${String(timestamp)}.`)
    .update(req.rawBody)             // raw wire bytes — not JSON.stringify(req.body)
    .digest('hex')

  const isValid = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex')
  )

  if (!isValid) return res.status(401).json({ error: 'Invalid signature' })

  // Process event...
  res.status(200).json({ received: true })
})
```

### Retry schedule
| Attempt | Base delay |
|---------|------------|
| 1       | Immediate  |
| 2       | 1 second   |
| 3       | 2 seconds  |
| 4       | 4 seconds  |
| 5       | 8 seconds  |
| Failed  | → Dead letter queue |

A small random jitter is added to the base exponential delay. Only transient failures are retried (network errors, timeouts, `408`, `429`, `5xx`). Permanent client errors (other `4xx`, e.g. `400`/`401`/`404`) fail fast to the dead letter queue via BullMQ's `UnrecoverableError` instead of burning all 5 attempts.

### Dead letters (admin only)
DLQ inspection and replay require the `X-Admin-Api-Key` header (`ADMIN_API_KEY` env var):
```
GET /dead-letters?limit=50
POST /dead-letters/:jobId/replay   → 202, or 409 if a replay is already active
```
Replaying updates the parent event's `replayCount`, `lastReplayedAt`, and `lastReplayJobId`.

### Health and readiness
- `GET /health` — lightweight liveness probe, no dependency checks: `{ "status": "ok", "timestamp": "..." }`
- `GET /ready` — checks MongoDB and Redis; returns `200 { "status": "ready", ... }` or `503 { "status": "unready", ... }`

### Security and limits
- Producer/subscriber API keys are SHA-256 hashed at rest; signing secrets are AES-256-GCM encrypted at rest.
- Subscriber URLs pass DNS-based SSRF checks (loopback, private, link-local/metadata, and IPv6 ranges blocked; `DISABLE_SSRF_CHECK=true` only for local dev).
- JSON bodies limited by `BODY_LIMIT` (`413` when exceeded); Redis-backed rate limiting on a dedicated connection (100 req/min on `/events`, 50 per 15 min on management routes, fail-closed); rate-limit Redis operations time out after `RATE_LIMIT_REDIS_TIMEOUT_MS` (default 1000ms), so a Redis outage returns a bounded `503` instead of hanging — BullMQ keeps its own separate connection with its required unbounded semantics; all error responses are `{ "error": "..." }` with no stack traces in production.

### Environment variables
| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP port for the Express API server | `3000` |
| `MONGODB_URI` / `REDIS_HOST` / `REDIS_PORT` | Dependency connections | localhost defaults |
| `WEBHOOK_ENCRYPTION_KEY` | 64-char hex key for secret encryption at rest | required in production |
| `ADMIN_API_KEY` | DLQ admin access (`X-Admin-Api-Key`) | required for DLQ routes |
| `WEBHOOK_TIMEOUT_MS` | Global outbound delivery timeout | `5000` |
| `MAX_DELIVERY_RESPONSE_BODY_CHARS` | Max subscriber response text kept per DeliveryLog | `8192` |
| `WORKER_CONCURRENCY` / `RETRY_JITTER_MS` | Worker concurrency / backoff jitter | `5` / `500` |
| `RATE_LIMIT_REDIS_TIMEOUT_MS` | Upper bound per rate-limit Redis round-trip (fail-closed 503 past it) | `1000` |
| `BODY_LIMIT` | Max JSON body size | `16kb` |
| `RECOVERY_INTERVAL_MS` / `RECOVERY_BATCH_SIZE` | Pending-event recovery loop | `5000` / `25` |

---

## Running Locally

### Option 1 — Docker (recommended)
```bash
# Configure from the template (Compose reads WEBHOOK_ENCRYPTION_KEY and
# ADMIN_API_KEY from this file — no real secrets are committed)
cp .env.example .env

# Local demo only: mocks run on the host, which SSRF protection blocks by
# default — allow it for the demo (never in production)
# In .env, set: DISABLE_SSRF_CHECK=true

# Start everything: API + Worker + MongoDB + Redis
docker-compose up --build

# In a separate terminal: mock subscriber on the host, then fire events.
# SUBSCRIBER_URL uses host.docker.internal because `localhost` inside the
# worker container means the container itself, not your machine.
npm run mock:subscriber
SUBSCRIBER_URL=http://host.docker.internal:4000/receive npm run mock:producer

# Stop and clean up the stack
docker-compose down
```

### Option 2 — Manual
Prerequisites: MongoDB and Redis running locally

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Local demo only: the mock subscriber runs on localhost, which SSRF
# protection blocks by default — allow it for local development
export DISABLE_SSRF_CHECK=true   # never enable in production

# Terminal 1 — API server
npm start

# Terminal 2 — Delivery worker
npm run worker

# Terminal 3 — Mock subscriber (receives deliveries)
npm run mock:subscriber

# Terminal 4 — Fire test events
npm run mock:producer
```

---

## Running Tests
```bash
npm test
```

15 suites, 112 unit tests (no full end-to-end coverage — routes and workers are tested with mocked dependencies):

Tests cover:
- HMAC signing/verification, tampering, wrong secrets, replay-window expiry
- Retry classification (transient → retry, permanent 4xx → fail fast) and DLQ escalation
- Worker safeguards (global timeout, no redirects) and delivery duration logging
- Producer/subscriber/admin authentication (missing/invalid/inactive keys)
- Event ingestion idempotency (create → duplicate → conflict, header and body keys)
- Pending-event recovery (stays pending on Redis failure, queues when back)
- Single-job DLQ replay (202 + event tracking, 409 on active replay, 404 unknown)
- SSRF blocking, body-size limits, health/readiness, request IDs

### Known limitation — single-instance recovery
The pending-event recovery loop uses process-local coordination and is designed around a single API instance. Running multiple API replicas would need distributed coordination (or an explicit decision about which instance runs recovery) before horizontal scaling. Also note: if Redis itself is down, the rate limiter fails closed with a bounded `503`, so requests never reach event persistence — recovery covers queue failures after the limiter, not a full Redis outage at ingress.

---

## Project Structure
```
webhook-delivery-system/
├── src/
│   ├── app.js                 # Express setup, health/ready, error handling
│   ├── config/
│   │   ├── db.js              # MongoDB connection
│   │   ├── redis.js           # Redis connection for BullMQ
│   │   ├── rateLimitRedis.js  # Dedicated bounded Redis client for rate limiting
│   │   └── logger.js          # Winston structured logging
│   ├── middlewares/
│   │   ├── authenticateProducer.js    # Producer x-api-key auth
│   │   ├── authenticateSubscriber.js  # Subscriber x-api-key auth
│   │   ├── authenticateAdmin.js       # DLQ X-Admin-Api-Key auth
│   │   └── requestId.js               # X-Request-Id propagation
│   ├── models/
│   │   ├── Producer.js        # Producer credentials + allowedEvents
│   │   ├── Subscriber.js      # Subscriber registry (encrypted signingKey)
│   │   ├── Event.js           # Events + idempotency + recovery + replay fields
│   │   └── DeliveryLog.js     # Per-attempt delivery log (+ durationMs)
│   ├── routes/
│   │   ├── events.js          # POST /events, GET /events/:id
│   │   ├── webhooks.js        # Register, update, deactivate, view logs
│   │   ├── producer.js        # Producer registration + management
│   │   └── deadLetters.js     # DLQ inspection + single-job replay
│   ├── queues/
│   │   └── deliveryQueue.js   # BullMQ queue + dead letter queue
│   ├── workers/
│   │   └── deliveryWorker.js  # Delivery, retry classification, DLQ escalation
│   ├── utils/
│   │   ├── hmac.js            # HMAC-SHA256 sign + verify
│   │   ├── encryption.js      # AES-256-GCM secret encryption
│   │   ├── ssrf.js            # DNS-based SSRF protection
│   │   ├── eventQueue.js      # Job building, queueing, pending recovery
│   │   ├── jobSchema.js       # Delivery job validation
│   │   ├── retryPolicy.js     # Transient vs permanent failure rules
│   │   └── apiKey.js          # API key generation + hashing
│   ├── mock/
│   │   ├── subscriber.js      # Mock receiving server (30% failure rate)
│   │   └── producer.js        # Registers producer/subscriber + fires events
│   └── tests/                 # Jest suites (auth, delivery, idempotency, DLQ, …)
├── docker-compose.yml
├── Dockerfile
└── .github/workflows/ci.yml
```

---

## What This Demonstrates

- **Event-driven architecture** — decoupled producer/consumer via queue
- **Reliability engineering** — exponential backoff, dead letter queue, delivery logging
- **API security** — HMAC-SHA256 signing, timing-safe comparison, rate limiting
- **Observability** — structured Winston logging on every job lifecycle event
- **Deployment readiness** — Docker, CI, environment configuration, graceful shutdown, and practical backend reliability and security patterns in a small, understandable system