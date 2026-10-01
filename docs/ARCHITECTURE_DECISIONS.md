# ARCHITECTURE_DECISIONS — Decisions Actually Present in the Code

> Each entry: Decision → Implementation → Why → Problem → Alternatives → Advantages → Costs → Limits → Code location.

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
**Costs:** no transactions; dual-write Mongo↔Redis consistency boundary (Event written, jobs may fail → `pending` + recovery).
**Code:** `src/models/*`, `src/config/db.js`.

## 4. Two Redis connections (BullMQ unbounded vs rate-limit bounded)

**Impl:** `config/redis.js` (`maxRetriesPerRequest:null`, offline queue) vs `config/rateLimitRedis.js` (`enableOfflineQueue:false`, `maxRetriesPerRequest:1`, 1s race → 503).
**Why:** BullMQ needs indefinite retries; request path needs fail-fast (sharing hangs HTTP during outage before persistence).
**Alternatives:** one connection; in-memory limiter; sidecar.
**Advantages:** deliveries eventually resume; HTTP never hangs; Lua re-init on reconnect.
**Costs:** two pools to configure/monitor.
**Code:** `src/config/redis.js`, `src/config/rateLimitRedis.js`, `src/app.js`.

## 5. Async `202 Accepted` ingest decoupled from delivery

**Impl:** persist Event + `addBulk` attempt → `202` (queued / no_subscribers / recoveryScheduled); worker later.
**Why:** honest semantics (accepted≠delivered), absorbs subscriber slowness.
**Alternatives:** `200` after delivery; webhook relay sync.
**Costs:** client must poll logs/status; `queueStatus≠delivered` confusion.
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

**Impl:** header/body key → `{producerId,idempotencyKey}` sparse-unique partial index; same type+`JSON.stringify` payload → `200 isDuplicate`; mismatch → `409`; `11000` race → `200`.
**Why:** safe producer retries without `Event`/job duplication; per-producer scope prevents cross-tenant collisions.
**Alternatives:** global keys, Redis dedup window, no idempotency.
**Costs:** key-order-sensitive compare; blank keys never dedupe.
**Code:** `src/routes/events.js`, `src/models/Event.js`.

## 9. Retry classification + `UnrecoverableError`

**Impl:** `isRetryableError` (no-response/408/429/5xx → retry; other 4xx → permanent) + pre-delivery deterministic fails (inactive/missing, decrypt/serialize) → `UnrecoverableError` + pre-delivery log; `failed` listener escalates permanent immediately or `attemptsMade>=5`.
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
**Why:** subscribers supply dial targets — must not reach instance metadata/internal hosts.
**Costs:** DNS TOCTOU (resolve→dial gap); `localhost` demos need bypass + `host.docker.internal` in Docker.
**Code:** `src/utils/ssrf.js`.

## 14. AES-256-GCM for signing secrets; SHA-256 hash for API keys

**Impl:** secrets encrypted `iv:tag:ct` via `WEBHOOK_ENCRYPTION_KEY`, decrypted per delivery; API/admin keys only SHA-256 stored/compared.
**Why:** secrets need reversible use (HMAC) → encrypt; API keys need verify-only → hash (DB read doesn't leak usable key).
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

**Impl:** liveness = static ok; readiness = mongo `readyState===1` + Redis `ping` race 2s → 200/503 with per-dep status.
**Why:** liveness = restart signal; readiness = traffic gate; BullMQ's infinite retry forces the ping timeout.
**Code:** `src/app.js`.

## 18. Pending-event recovery loop

**Impl:** `setInterval(RECOVERY_INTERVAL_MS 5000)` + immediate run, batch 25, `find({queueStatus:'pending'}).sort({createdAt:1})`, `isRunning` guard, `DISABLE_RECOVERY` escape.
**Why:** `202+pending` on `addBulk` failure self-heals without operator.
**Costs:** single-instance coordination only (see Limitations); full-Redis-outage ingress never reaches it (limiter 503 first).
**Code:** `src/utils/eventQueue.js`.

## 19. Graceful shutdown (API + worker)

**Impl:** API: stop accept → clear timer → close queue → quit both Redis → close mongo → exit (10s force). Worker: `worker.close()` drains in-flight.
**Why:** avoid dropping queued work / half-written logs on deploy.
**Costs:** `SIGKILL` still drops in-flight HTTP (job retried/stalled-reclaimed).
**Code:** `src/app.js`, `deliveryWorker.js`.

## 20. Docker 4-service topology + fail-closed rate limiting

**Impl:** `app`+`worker` (build, `WEBHOOK_ENCRYPTION_KEY`/`ADMIN_API_KEY` passthrough, `./logs` mount, mongo/redis health deps) + `mongo:7` + `redis:7-alpine` with volumes/healthchecks; limiter `passOnStoreError:false` + 1s bound → 503 instead of un-limited pass.
**Why:** local prod-like stack; never fail open on limiter outage.
**Costs:** Redis still SPOF; limiter 503s during Redis outage even when Mongo healthy.
**Code:** `Dockerfile`, `docker-compose.yml`, `src/app.js`.
