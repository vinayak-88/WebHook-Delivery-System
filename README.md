# Webhook Delivery System

A production-style webhook engine that guarantees event delivery to registered subscribers — with exponential backoff retry, HMAC-SHA256 payload signing, dead letter queue handling, and structured delivery logging.

This mirrors the internal infrastructure used by Stripe, GitHub, and Razorpay for their webhook systems.

---

## Architecture

```
[Event Producer]
      │
      ▼
POST /events ──► [Express API] ──► [BullMQ Queue] ──► [Delivery Worker]
                      │                                       │
                      │                           ┌───────────┴───────────┐
                      │                           │                       │
                      ▼                           ▼                       ▼
               [MongoDB]                    [Success]               [Failure]
               - Events                          │                       │
               - Subscribers                     ▼                       ▼
               - DeliveryLogs           [DeliveryLog]         [Retry w/ backoff]
                                        (persisted)                      │
                                                               [Max retries hit]
                                                                         │
                                                                         ▼
                                                               [Dead Letter Queue]
```

---

## Key Design Decisions

### Why 202 Accepted instead of 200 OK on POST /events?
Delivery is asynchronous — the API queues the job and returns immediately without waiting for the subscriber to respond. Returning 200 would imply the delivery already succeeded, which is false. 202 accurately signals "received and queued, not yet delivered."

### Why exponential backoff instead of fixed-interval retry?
Fixed-interval retry (every 5 seconds regardless) causes a thundering herd problem — if a subscriber goes down and 10,000 events are queued, all 10,000 hammer the subscriber the moment it comes back up, likely taking it down again. Exponential backoff (1s → 2s → 4s → 8s → 16s) spreads the load and gives the subscriber time to recover.

### Why HMAC-SHA256 for payload signing?
When the worker delivers to a subscriber URL, the subscriber has no way to know if the request genuinely came from this server or from an attacker who discovered their endpoint. HMAC solves this: both parties share a secret at registration time, and every delivery is signed with it. The subscriber recomputes the hash and compares — if they match, the request is authentic.

### Why timingSafeEqual instead of === for signature comparison?
String comparison with === short-circuits — it stops at the first non-matching character. An attacker can measure tiny differences in response time to guess the correct signature one character at a time (timing attack). `crypto.timingSafeEqual` always takes the same amount of time regardless of where the mismatch is, making this attack impossible.

### Why a dead letter queue?
Jobs that exhaust all retry attempts don't silently disappear. They land in a dead letter queue where they can be inspected, manually replayed, or trigger an alert. Without this, permanently failed deliveries are invisible — you'd have no way to know a subscriber missed critical events.

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
  "secret": "your-shared-secret"
}

Response 201:
{
  "message": "Subscriber registered successfully",
  "subscriberId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "subscriberUrl": "https://your-service.com/webhook",
  "events": ["payment.success", "payment.failed"]
}
```

### Deactivate a Subscriber
```
DELETE /webhooks/:id

Response 200:
{
  "message": "Subscriber deactivated successfully"
}
```

### View Delivery Logs
```
GET /webhooks/:id/logs

Response 200:
{
  "subscriberId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "logs": [
    {
      "attemptNumber": 1,
      "statusCode": 503,
      "success": false,
      "errorMessage": null,
      "createdAt": "2024-01-15T10:23:01.000Z"
    },
    {
      "attemptNumber": 2,
      "statusCode": 200,
      "success": true,
      "createdAt": "2024-01-15T10:23:03.000Z"
    }
  ]
}
```

### Ingest an Event
```
POST /events
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

---

## How Delivery Works

Every outgoing request includes:
```
POST https://your-service.com/webhook
Content-Type: application/json
X-Webhook-Signature: <hmac-sha256-hex>
X-Webhook-Event-Id: <eventId>
X-Webhook-Attempt: <attemptNumber>

{ ...your event payload }
```

### Verifying the signature on your end (Node.js example)
```javascript
const crypto = require('crypto')

app.post('/webhook', (req, res) => {
  const received = req.headers['x-webhook-signature']
  const expected = crypto
    .createHmac('sha256', YOUR_SECRET)
    .update(JSON.stringify(req.body))
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
| Attempt | Delay after previous |
|---------|---------------------|
| 1       | Immediate           |
| 2       | 1 second            |
| 3       | 2 seconds           |
| 4       | 4 seconds           |
| 5       | 8 seconds           |
| Failed  | → Dead letter queue |

---

## Running Locally

### Option 1 — Docker (recommended)
```bash
# Start everything: API + Worker + MongoDB + Redis
docker-compose up

# In a separate terminal, register and fire events
npm run mock:producer
```

### Option 2 — Manual
Prerequisites: MongoDB and Redis running locally

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

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

Tests cover:
- HMAC signature generation consistency
- Signature verification for valid payloads
- Signature rejection for tampered payloads
- Delivery success on 200 response
- Delivery failure propagation on 503
- Retry simulation (fail once, succeed on retry)

---

## Project Structure
```
webhook-delivery-system/
├── src/
│   ├── config/
│   │   ├── db.js              # MongoDB connection
│   │   ├── redis.js           # Redis + IORedis connection
│   │   └── logger.js          # Winston structured logging
│   ├── models/
│   │   ├── Subscriber.js      # Subscriber schema
│   │   ├── Event.js           # Event schema
│   │   └── DeliveryLog.js     # Per-attempt delivery log
│   ├── routes/
│   │   ├── webhooks.js        # Register, deactivate, view logs
│   │   └── events.js          # Event ingestion
│   ├── queues/
│   │   └── deliveryQueue.js   # BullMQ queue + dead letter queue
│   ├── workers/
│   │   └── deliveryWorker.js  # Core delivery + retry + DLQ logic
│   ├── utils/
│   │   └── hmac.js            # HMAC-SHA256 sign + verify
│   └── app.js                 # Express setup + rate limiting
├── tests/
│   ├── hmac.test.js           # Signature utility tests
│   └── retry.test.js          # Delivery behaviour tests
├── mock/
│   ├── subscriber.js          # Mock receiving server (30% failure rate)
│   └── producer.js            # Registers subscriber + fires events
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
- **Production readiness** — Docker, CI/CD, environment configuration, error handling