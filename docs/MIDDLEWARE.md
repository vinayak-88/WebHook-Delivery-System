# MIDDLEWARE — Every Middleware, Behavior, and Route Map

> Source of truth: `src/middlewares/*.js` + `src/app.js` wiring. 4 middleware files + 2 app-level functions (rate limiters, 404/error handlers).

---

## 1. `requestId.js` — `requestIdMiddleware(req,res,next)`

- **Purpose/why:** distributed tracing across API → Mongo (`Event.requestId`) → BullMQ job → worker logs → delivery header → `DeliveryLog.requestId`.
- **Registered:** first in `src/app.js` (`app.use(requestIdMiddleware)`), so every route, 404, and error handler sees `req.requestId` and every response carries `X-Request-Id`.
- **Inputs:** `req.headers['x-request-id']`. Accepts iff `/^[A-Za-z0-9_-]{1,128}$/`; else `crypto.randomUUID()`. Unsafe/overlong client values are replaced, not rejected.
- **Mutates:** `req.requestId`; `res.setHeader('X-Request-Id', id)`.
- **`next()`:** always called (never short-circuits). **Errors:** none (cannot fail).
- **Security:** allowlist prevents header-injection/log-forgery via exotic IDs; length cap bounds storage.

## 2. `authenticateProducer(req,res,next)` — `src/middlewares/authenticateProducer.js`

- **Purpose:** gate all producer operations (`/events*`, `/producers` PATCH/DELETE) to the owning active producer.
- **Reads:** `req.headers['x-api-key']`. Missing → `401 {error:'API key required'}` (no DB hit).
- **Logic:** `hashKey(apiKey)` (SHA-256) → `Producer.findOne({apiSecret:hashed, isActive:true})`. No match (wrong key or `isActive:false`) → `401 {error:'Invalid API key'}`. Match → `req.producer=doc; next()`. DB throw → `500 {error:'Internal server error'}`.
- **Security:** hash-compare (no plaintext lookup); inactive keys fail closed; identical shape to subscriber auth but different collection (keys not interchangeable).
- **Downstream:** `POST /events` uses `req.producer._id` (ownership/idempotency) + `allowedEvents`; `GET /events/:id` ownership check; producer PATCH/DELETE mutate `req.producer`.

## 3. `authenticateSubscriber(req,res,next)` — `src/middlewares/authenticateSubscriber.js`

- **Purpose:** gate subscriber self-management + private logs to the owning active subscriber.
- **Logic:** identical to producer auth but `Subscriber.findOne({apiSecret:hashed, isActive:true})` → `req.subscriber`. Same 401/500 shapes.
- **Downstream:** `GET/PATCH/DELETE /webhooks`, `GET /webhooks/logs` (query scoped to `req.subscriber._id`).

## 4. `authenticateAdmin(req,res,next)` — `src/middlewares/authenticateAdmin.js`

- **Purpose:** gate DLQ inspection/replay to operators. Only middleware using constant-time compare.
- **Reads:** `req.headers['x-admin-api-key']` (Express lowercases). Missing → `401 {error:'Admin API key required (X-Admin-Api-Key header)'}`.
- **Logic:** reads `process.env.ADMIN_API_KEY` **per request** (no module-load caching — test/reload safe). Empty/unset → `503 {error:'Admin authentication is not configured on this server'}` (fail-closed, distinct from 401). Else `timingSafeEqual(sha256(provided), sha256(configured))` in try/catch → mismatch → `401 {error:'Invalid admin API key'}`; match → `next()`.
- **Security:** SHA-256 + `timingSafeEqual` blocks timing side-channels; 503-vs-401 distinguishes misconfiguration from wrong key without leaking the key.

## 5. Rate limiting — `eventLimiter`, `managementLimiter` (`src/app.js` + `src/config/rateLimitRedis.js`)

- **What:** `express-rate-limit` + `rate-limit-redis` `RedisStore({sendCommand:sendRateLimitCommand, prefix:'rl:events:'|'rl:mgmt:'})`, `passOnStoreError:false`.
- **Where:** `app.use('/events',eventLimiter,eventRoutes)` (100/min); `app.use('/webhooks'|'/dead-letters'|'/producers',managementLimiter,…)` (50/15min). Runs **after** request-ID, **before** auth/validation (abusive traffic rejected before DB work).
- **`sendRateLimitCommand`:** `whenUsable()` (immediate if `status==='ready'`, else one-shot `ready`/`close` listeners) raced against `RATE_LIMIT_REDIS_TIMEOUT_MS` (1000ms); any failure → generic `503 {error:'Service temporarily unavailable'}`. `enableOfflineQueue:false` + `maxRetriesPerRequest:1` on this connection (vs BullMQ's `null`/unbounded) so requests fail fast instead of hanging. `registerRateLimitStore` + `ready`-listener re-`init()`s Lua scripts on reconnect (boot-while-Redis-down safe).
- **Test env:** `NODE_ENV==='test'` → `store:undefined` → in-memory (avoids open handles in Jest).
- **Behavior:** over-limit → `429 {error:'Too many requests, slow down'}`; Redis down → `503` fail-closed (never lets traffic through un-limited).

## 6. Body parser + 404 + global error handler (`src/app.js`)

- **`express.json({limit:BODY_LIMIT||'16kb', verify:(req,res,buf)=>req.rawBody=buf})`:** rejects oversize before routes; preserves raw bytes (used by mock subscriber/HMAC flows; API itself signs worker-side buffers).
- **404:** `app.use((req,res)=>res.status(404).json({error:'Route not found'}))` after all mounts.
- **Error handler:** `(err,req,res,next)`: `entity.too.large`/413 → `413 {error:'Payload too large',limit:BODY_LIMIT}`; else logs with `requestId`, `statusCode=err.statusCode||500`, production 500s sanitized to `'Internal server error'` (no stacks/driver messages), always `{error:message}`.

## Differences at a glance

| Concern | Producer auth | Subscriber auth | Admin auth | Request ID | Rate limit |
|---|---|---|---|---|---|
| Header | `x-api-key` | `x-api-key` | `x-admin-api-key` | `x-request-id` | none (IP-based) |
| Store | `Producer` | `Subscriber` | env `ADMIN_API_KEY` | none | Redis counters |
| Compare | sha256 equality via query | sha256 equality via query | sha256 + `timingSafeEqual` | allowlist/UUID | counters |
| Inactive | `401` | `401` | n/a | n/a | n/a |
| Attaches | `req.producer` | `req.subscriber` | nothing | `req.requestId` | nothing |

## Route → middleware execution map

| Route | Order (after global JSON) |
|---|---|
| `POST /producers/register` | requestId → mgmtLimiter → handler |
| `PATCH/DELETE /producers*` | requestId → mgmtLimiter → authenticateProducer → handler |
| `POST /webhooks/register` | requestId → mgmtLimiter → handler |
| `GET/PATCH/DELETE /webhooks*`, `GET /webhooks/logs` | requestId → mgmtLimiter → authenticateSubscriber → handler |
| `POST /events`, `GET /events/:id` | requestId → eventLimiter → authenticateProducer → handler |
| `GET /dead-letters`, `POST /dead-letters/:jobId/replay` | requestId → mgmtLimiter → authenticateAdmin (`router.use`) → handler |
| `GET /health`, `GET /ready` | requestId only (no limiter/auth) |
| Unknown | requestId → 404 |
| Throw/next(err) anywhere | → global error handler |
