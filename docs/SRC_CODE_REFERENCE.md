# SRC_CODE_REFERENCE — Every File Under `src/`

> 44 JS files. Source of truth: current implementation. Purpose/Imports/Functions/Constants/Flow/Failure/Security/Relationships per file. Tests summarized by protected behavior + mocks.

---

## `src/app.js` — Express entrypoint, middleware wiring, health/ready, shutdown

**Purpose:** builds `app`, wires global middleware → limiters → routers, exposes `/health` `/ready`, starts server + recovery loop, graceful shutdown.
**Imports:** dotenv, express, mongoose (readyState + close), express-rate-limit + rate-limit-redis RedisStore, `config/db` (connectDB), `config/redis` (BullMQ conn, ping), `config/rateLimitRedis` (bounded conn, sendCommand, register), `config/logger`, 4 routers, `middlewares/requestId`, `utils/eventQueue:startPendingEventRecovery`, `queues/deliveryQueue:deliveryQueue` (close).
**Functions:** `createRedisStore(prefix,windowMs)` — test→undefined else RedisStore+register; `shutdown(signal)` (closure in `listen` cb: `server.close()`, clear recovery timer, `deliveryQueue.close()`, `redis.quit()`, `rateLimit.quit()`, `mongoose.close()`, `SHUTDOWN_TIMEOUT_MS` 10s force-exit); `startServer()` — `connectDB()`, `listen(PORT)`, start recovery, arm SIGTERM/SIGINT. `GET /health`, `GET /ready` (mongo readyState + ping race 2s → 200/503), 404, error handler (413 + sanitized 500s).
**Constants:** `BODY_LIMIT` 16kb, limiter windows 60s/15min + max 100/50, `READY_REDIS_TIMEOUT_MS` 2000, `SHUTDOWN_TIMEOUT_MS` 10000.
**Flow:** dotenv → validate `WEBHOOK_ENCRYPTION_KEY` (fatal in production) → requestId → json(rawBody) → limiter → router → 404 → errors. `require.main===module` gates listen; exports `app` for tests.
**Failure:** DB connect fail → exit 1; Redis down → limiters 503, ready 503; oversize → 413.
**Security:** fail-closed limiters, sanitized prod errors, bounded Redis, rawBody preserved.
**Relationships:** mounts all routers/middlewares; owns recovery timer + shutdown.

## `src/config/db.js` — `connectDB()`

Connects `MONGODB_URI||localhost/webhook-delivery` via mongoose; logs; `process.exit(1)` on failure. Called by `app.js` + worker. No pooling options set.

## `src/config/logger.js` — Winston `logger`

`logs/` resolved from `process.cwd()` + created; format timestamp+errors+printf; transports Console + `logs/error.log`(error) + `logs/combined.log`. Imported everywhere.

## `src/config/redis.js` — `redisConnection` (BullMQ/shared)

`new Redis({host,port,maxRetriesPerRequest:null})` (BullMQ-required). `connect`/`error` logs. Shared by queues, worker, `GET /ready` ping, `shutdown quit()`.

## `src/config/rateLimitRedis.js` — bounded rate-limit Redis

**Purpose:** request-time-safe Redis. `RATE_LIMIT_REDIS_TIMEOUT_MS` 1000. `rateLimitRedisConnection=new Redis({host,port,enableOfflineQueue:false,maxRetriesPerRequest:1})` (fails fast, auto-reconnects). `serviceUnavailable()` → 503 Error. `registeredStores[]` + `registerRateLimitStore(store,windowMs)` + `ready`-listener re-`init()` (Lua reload). `whenUsable()` (immediate if ready else once-ready/close). `sendRateLimitCommand(...args)` = `race(whenUsable().then(call), timeout)` → 503 on any failure, clears timer. Used only by `app.js` limiters.

## `src/middlewares/requestId.js` — `requestIdMiddleware`

Accepts `x-request-id` iff safe `/^[A-Za-z0-9_-]{1,128}$/` else `randomUUID()`; sets `req.requestId` + response header; always `next()`. First middleware globally.

## `src/middlewares/authenticateProducer.js` — `authenticateProducer`

`x-api-key` → `hashKey` → `Producer.findOne({apiSecret:hashed,isActive:true})` → `req.producer` or 401/500. Used by `/events*`, producer PATCH/DELETE.

## `src/middlewares/authenticateSubscriber.js` — `authenticateSubscriber`

Same shape on `Subscriber` → `req.subscriber`. Used by `/webhooks*` management + logs.

## `src/middlewares/authenticateAdmin.js` — `authenticateAdmin`

`x-admin-api-key`; per-request `ADMIN_API_KEY`; unset→503; `timingSafeEqual(sha256(p),sha256(c))` → 401 or `next()`. `router.use()` on DLQ router.

## `src/models/Producer.js` — `Producer`

Schema: `producerUrl` (trim, unique, regex dotted-host), `apiSecret` (unique), `allowedEvents` ([String] non-empty + no-dup validators), `isActive` (default true), timestamps. No extra indexes. Created by producer register; read by auth + ingest; updated by PATCH events / DELETE deactivate.

## `src/models/Subscriber.js` — `Subscriber`

Schema: `subscriberUrl` (trim, unique), `events` (non-empty + no-dup), `signingKey` (required; encrypted `iv:tag:ct`), `apiSecret` (unique), `isActive`, timestamps; `index({events:1})` multikey; `virtual('secret').set(v=>signingKey=encrypt(v))`. Created by webhook register; read by auth/match/worker; updated by PATCH×2/DELETE.

## `src/models/Event.js` — `Event`

Fields: `producerId` (ObjectId ref Producer, optional, indexed), `idempotencyKey` (trim, null), `type`, `payload` (Mixed), `deliveryTargets` ([{subscriberId ref, subscriberUrl}] `_id:false`, no-dup validator), `queueStatus` enum pending/queued/no_subscribers, `queuedJobCount`, `queueEnqueuedAt`, `lastQueueError{message,code,occurredAt}`, `replayCount`, `lastReplayedAt`, `lastReplayJobId`, `requestId`, timestamps. Indexes: `{queueStatus,createdAt}`, `{producerId,idempotencyKey}` unique sparse partial `$ne:null`. Created by ingest; read by lookup/idempotency/recovery; updated by `queueEventDeliveries` + DLQ replay.

## `src/models/DeliveryLog.js` — `DeliveryLog`

Fields: `eventId`, `subscriberId`, `subscriberUrl`, `attemptNumber`, `statusCode` (null), `responseBody` (null, truncated at write), `success`, `errorMessage` (null), `durationMs` (null), `requestId` (null); `timestamps:{createdAt:true,updatedAt:false}` (append-only); `index({subscriberId,createdAt:-1})`. Created per attempt by worker; read by logs endpoint; never updated/deleted.

## `src/routes/producer.js` — `/producers` router

`EVENT_TYPE_RE` noun.verb. `POST /register` (public: validate, `validateNoSSRF`, key/hash, `Producer.create`, 201/400/409/500). `PATCH /events` (producer-auth: validate, save, 200). `DELETE /` (producer-auth: `isActive=false`). Imports Producer, logger, auth, apiKey, ssrf.

## `src/routes/webhooks.js` — `/webhooks` router

`SECRET_MIN_LENGTH` 32, `EVENT_TYPE_RE`. `GET /` (profile). `POST /register` (public: validate secret/events/SSRF, key/hash, virtual-encrypt, save, 201/409). `PATCH /` (url and/or events, rejects id/secret keys, SSRF, 409). `PATCH /events` (events-only). `DELETE /` (deactivate). `GET /logs` (page/limit, `find+sort+skip+limit+populate` + count → `{subscriberId,total,page,limit,pages,logs}`). All but register subscriber-authed.

## `src/routes/events.js` — `/events` router

`EVENT_TYPE_RE`. `GET /:id` (producer-auth: `findById`, 400 CastError, 404, 403 ownership, returns handoff+replay+targets). `POST /` (producer-auth: require type/payload, noun.verb, allowedEvents 403, idempotency pre-check 200/409, `Subscriber.find`, `Event.create` with 11000-race →200, `queueEventDeliveries` → 202 queued/no_subscribers/recoveryScheduled, 500 on DB fail).

## `src/routes/deadLetters.js` — `/dead-letters` router (admin)

`router.use(authenticateAdmin)`. `formatJob(job)` (id,name,`getState()`,event/sub/url,failureReason,failedAt,originalJobId,ISO timestamp). `GET /` (limit 1–100 def 50, `getJobs(['waiting'])`, `{count,jobs}`). `POST /:jobId/replay` (`getJob` 404, missing-data 400, `replay-<id>` + active-guard 409, `deliveryQueue.add deliver`, `Event $inc replayCount`, 202; DLQ retained).

## `src/queues/deliveryQueue.js` — `deliveryQueue`, `deadLetterQueue`, `MAX_DELIVERY_ATTEMPTS=5`

`Queue('webhook-delivery',{connection:redisConnection, defaultJobOptions:{attempts:5,backoff:{exponential,1000},removeOnComplete:100,removeOnFail:200}})`; `Queue('webhook-dead-letter',{…,removeOnComplete:500,removeOnFail:200})`. Imported by ingest, recovery, replay, worker, shutdown.

## `src/workers/deliveryWorker.js` — `processDeliveryJob`, worker, DLQ escalation

**Imports:** dotenv, BullMQ `Worker/UnrecoverableError`, axios, redis conn, db, logger, DeliveryLog, Subscriber, queues, `hmac:generateSignature`, `encryption:decrypt`, `ssrf:validateNoSSRF`, `jobSchema:assertValidDeliveryJobData`, `retryPolicy:isRetryableError`.
**Consts:** `RETRY_JITTER_MS` 500, `WEBHOOK_TIMEOUT_MS` 5000, `MAX_RESPONSE_BODY_CHARS` 8192 + `...[truncated]`, `workerConcurrency` (env>0 else 5).
**Functions:** `truncateResponseBody(s)`; `buildLogPayload(...)`; `persistDeliveryLog(payload,{rethrowOnFailure:false})` (logs failure, optional rethrow); `processDeliveryJob(job)` — assert schema → SSRF → `Subscriber.findById.select` (DB throw→retry) → missing/inactive→pre-delivery log + `UnrecoverableError` → decrypt+`Buffer(JSON(payload))`+`Date.now()`+`generateSignature` (throw→pre-delivery log + Unrecoverable) → `axios.post(url,bodyBuffer,{headers:Content-Type/X-Webhook-Signature/X-Webhook-Event-Id/X-Webhook-Attempt/X-timestamp/[X-Request-Id],timeout,maxRedirects:0})` → success log + `{statusCode,eventId,subscriberId,attemptNumber}` (never raw Axios) / catch: duration+status/body/errorMessage → failure log → `!isRetryableError→UnrecoverableError` else rethrow; `shutdown(signal)` → `worker.close()`.
**Worker:** `new Worker('webhook-delivery',processDeliveryJob,{connection,concurrency,settings:{backoffStrategy:attemptsMade=>round(1000*2^(n-1)+rand*jitter)}})`; `on('failed')` — permanent (`instanceof UnrecoverableError`) or `attemptsMade>=MAX` → `deadLetterQueue.add('failed-delivery',{...data,failureReason,originalJobId,failedAt:ISO},{jobId:'dead-letter-'+id})`; `on('completed'/'error')` logs; `startWorker()` connects DB; `require.main` gate; exports worker+handler+truncate+const.
**Failure/security:** transient→retry, permanent→DLQ immediately; pre-delivery logs have null status/body/duration; SSRF+no-redirect+timeout+jitter; secrets never in job data.

## `src/utils/apiKey.js` — `generateApiKey()`, `hashKey(key)`

`randomBytes(32).hex` (64 hex); `sha256.hex`. Used by both registers + both auth middlewares.

## `src/utils/encryption.js` — AES-256-GCM `encrypt/decrypt`, `getEncryptionKey()`

`ALGORITHM aes-256-gcm`, `IV 12B`, `TAG 16B`. `getEncryptionKey()` reads `WEBHOOK_ENCRYPTION_KEY`, requires 64-hex else throw. `encrypt(plaintext)` → `iv:tag:ct` hex (random IV). `decrypt(stored)` validates 3-part hex + lengths, `createDecipheriv`+`setAuthTag`, throws on tamper/wrong key; never treats undecryptable as plaintext (worker fail-fast). Used by Subscriber virtual + worker.

## `src/utils/hmac.js` — `generateSignature(payload,secret,timestamp)`, `verifySignature(payload,secret,timestamp,received)`

`generate`: Buffer(payload or `JSON.stringify`) + `update(String(ts)+'.')` + HMAC-sha256 hex. `verify`: 5-min `abs(now-Number(ts))` window (NaN→false) → expected → `timingSafeEqual(hex,hex)` try/catch → bool. Used by worker (sign) + mock subscriber (verify).

## `src/utils/jobSchema.js` — `validateDeliveryJobData(data)`, `assertValidDeliveryJobData(data)`

Checks: object; `eventId/subscriberId` 24-hex strings; `subscriberUrl` `^https?://.+`; `payload` not null/undef; optional `requestId` non-empty string. Returns `{valid,errors}` / throws `Invalid delivery job data: …`. Called producer-side (`buildDeliveryJobs`) + consumer-side (worker entry).

## `src/utils/retryPolicy.js` — `isRetryableError(err)`

No-response (no `err.response.status`) → true; 408/429 → true; 500–599 → true; else false (all other 4xx permanent). Used by worker to choose rethrow vs `UnrecoverableError`.

## `src/utils/ssrf.js` — `validateNoSSRF(url)`, `isBlockedIP(ip)` (+ helpers)

`BLOCKED_CIDRS` (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. metadata, 0/8, 255.255.255.255/32, 192.0.2/24, 198.51.100/24, 203.0.113/24) + `BLOCKED_IPV6_CIDRS` (::1/128, fe80/10, fc00/7, ::/128, ::ffff:0:0/96). Helpers `parseCIDR/ipToInt/ipv4InCIDR/parseIPv6CIDR/expandIPv6/ipv6InCIDR`. `isBlockedIP` handles v4/v6 + mapped. `validateNoSSRF`: `DISABLE_SSRF_CHECK==='true'`→return; `new URL` (→Invalid URL); protocol http/https (https-only in production); raw-IP→block check; `localhost*` hostnames blocked; else `resolve4+resolve6` (allSettled, ≥1 required) → every addr block-checked. Used by producer/subscriber registers, PATCH url, worker pre-dial. TOCTOU (DNS re-resolve) is a known residual risk.

## `src/utils/eventQueue.js` — job build/queue/recovery

Consts `PENDING/QUEUED/NO_SUBSCRIBERS`. `buildJobId(e,s)` → `event-<e>-subscriber-<s>` (no colons). `buildDeliveryJobs(event)` → per-target `{name:'deliver',data:{eventId,subscriberId,subscriberUrl,payload,requestId},opts:{jobId}}` + assert schema (secret omitted). `markEventQueueState(id,updates)` → `findByIdAndUpdate`. `queueEventDeliveries(event)` — zero jobs→`no_subscribers`; `addBulk` OK→`queued`+count+`queueEnqueuedAt`+clear error; throw→`pending`+`lastQueueError`+rethrow. `recoverPendingEvents({limit:25})` — `find({queueStatus:'pending'}).sort({createdAt:1}).limit` → per-event queue → `{scanned,recovered}`. `startPendingEventRecovery({intervalMs:RECOVERY_INTERVAL_MS||5000,batchSize:RECOVERY_BATCH_SIZE||25})` — `intervalMs<=0`→null; `DISABLE_RECOVERY==='true'`→warn+null; else process-local `isRunning` guard, immediate + interval run, logs. Called by `app.listen`.

## `src/mock/subscriber.js` — mock receiver :4000

Express + rawBody; `WEBHOOK_SECRET` or dev default (warns); `POST /receive` reads signature/attempt/timestamp, `verifySignature(rawBody,secret,ts,sig)` → 401 if bad; 30% random 503; else 200 `{received:true}`. Demo HMAC verifier.

## `src/mock/producer.js` — demo driver

`BASE_URL/SUBSCRIBER_URL/SHARED_SECRET(WEBHOOK_SECRET)/DELIVERY_WAIT_MS` envs; `registerProducer()` (POST producers/register `mock-producer.local:5000`), `registerSubscriber()` (POST webhooks/register), `fireEvent(key,type,payload,idempotencyKey?)` (POST /events with `x-api-key`), `checkLogs(subKey)` (GET /webhooks/logs), `run()` — register both, 3 events (payment.success/order.created/payment.failed), wait, print logs. Requires `DISABLE_SSRF_CHECK=true` for localhost URLs; re-run 409s on duplicate URLs.

## Tests (16 suites, 122 tests — all passing via `jest --runInBand src/tests`)

- `src/tests/admin.test.js` — missing/invalid/inactive admin keys (401), unconfigured (503), constant-time path.
- `src/tests/auth.test.js` — producer+subscriber: missing (401), invalid/inactive (401), DB error (500); mocked models+hash.
- `src/tests/deadLetters.test.js` — admin gate, GET format, replay 202/409(active)/404/400-missing-data; mocked queues+Event; live express server.
- `src/tests/delivery.test.js` — worker: 2xx success log+summary, 4xx permanent→Unrecoverable, 5xx/408/429/network→rethrow, pre-delivery inactive/decrypt fail-fast, timeout+`maxRedirects:0`, `durationMs`, body truncation; mocked axios/models/Worker.
- `src/tests/deliveryLog.test.js` — schema has `createdAt` not `updatedAt` + all audit fields.
- `src/tests/encryption.test.js` — round-trip, random IVs, wrong-key/tamper reject, bad formats.
- `src/tests/eventQueue.test.js` — deterministic IDs, `addBulk`, no_subscribers/queued/pending transitions, error capture.
- `src/tests/hmac.test.js` — 64-hex deterministic signing, secret/payload/ts sensitivity, tamper + replay-window reject.
- `src/tests/idempotency.test.js` — create→`200 isDuplicate`→`409` mismatch, header+body keys, `11000` race; live express + mocked models.
- `src/tests/jobSchema.test.js` — valid pass, optional requestId, ObjectId/URL/payload rejections.
- `src/tests/rateLimitRedis.test.js` — dedicated opts (`enableOfflineQueue:false,maxRetriesPerRequest:1`), timeout-bound 503 fail-closed, re-init on ready, BullMQ isolation.
- `src/tests/recovery.test.js` — pending→queued when Redis back, stays pending on failure, batch sort/limit.
- `src/tests/retry.test.js` — end-to-end handler retry paths + HMAC round-trip (like delivery, coarser).
- `src/tests/retryPolicy.test.js` — matrix: no-response/408/429/5xx retry; other 4xx permanent.
- `src/tests/routes.test.js` — `/health` shape, `/ready` 200/503 by mongo+redis, request-ID echo/generation, body-limit 413, 404, recovery wiring.
- `src/tests/ssrf.test.js` — blocked v4/v6/mapped/metadata/localhost, public allowed, bypass flag, DNS-failure errors.
