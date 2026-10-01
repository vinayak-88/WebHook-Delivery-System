# INTERVIEW_QUESTIONS — Based Only on This Repository

> Every expected answer cites current files. No textbook-only answers.

## Level 1: Basic

### Q1. Sketch the architecture from producer to subscriber.
**Testing:** system decomposition. **Answer:** Producer → `POST /events` (Express `src/app.js`) → Mongo `Event` + BullMQ `webhook-delivery` (Redis) → `deliveryWorker.js` (Axios HMAC POST) → subscriber; failures → retries → `webhook-dead-letter` → admin replay; every attempt → `DeliveryLog`. **Concepts:** decoupling, at-least-once, 202. **Evidence:** `src/app.js`, `src/routes/events.js`, `src/queues/deliveryQueue.js`, `src/workers/deliveryWorker.js`.

### Q2. What routes exist and who can call them?
**Testing:** route inventory. **Answer:** 15: producers (register public; PATCH/DELETE producer-auth), webhooks (register public; GET/PATCH×2/DELETE/logs subscriber-auth), events (POST/GET/:id producer-auth), dead-letters (GET/replay admin), `/health`+`/ready` public. **Evidence:** `src/routes/*.js`, `API_AND_ROUTE_FLOWS.md`.

### Q3. What lives in MongoDB vs Redis?
**Testing:** storage separation. **Answer:** Mongo: Producer/Subscriber/Event/DeliveryLog (durable entities+audit). Redis: BullMQ jobs/state + rate-limit counters (two connections). Redis is not a cache. **Evidence:** `src/models/*`, `src/config/redis.js`, `src/config/rateLimitRedis.js`.

### Q4. How does BullMQ deliver and retry?
**Testing:** queue semantics. **Answer:** `webhook-delivery` attempts 5, exponential 1s base + jitter; worker throws → delayed retry; permanent → `UnrecoverableError` → DLQ immediately; `attemptsMade>=5` → DLQ. **Evidence:** `deliveryQueue.js`, `retryPolicy.js`, `deliveryWorker.js`.

### Q5. How is a producer/subscriber authenticated?
**Testing:** authN. **Answer:** `x-api-key` → SHA-256 → `findOne({apiSecret,isActive:true})` on own collection → `req.producer/req.subscriber`; admin uses `X-Admin-Api-Key` vs env with `timingSafeEqual`. **Evidence:** `src/middlewares/*`, `src/utils/apiKey.js`.

### Q6. How is a webhook signed and verified?
**Testing:** HMAC. **Answer:** `HMAC_SHA256(secret, String(ts)+'.'+bodyBuffer).hex` in `X-Webhook-Signature` + `X-timestamp`; verify raw bytes + 5-min window + `timingSafeEqual`. **Evidence:** `src/utils/hmac.js`, worker, `mock/subscriber.js`.

## Level 2: Intermediate

### Q7. Why `202` not `200` on `POST /events`?
**Testing:** async semantics. **Answer:** Accepted≠delivered; response after persist+`addBulk`, before dial. Variants: queued / no_subscribers / recoveryScheduled. `GET /events/:id` is handoff status, not outcome. **Evidence:** `src/routes/events.js`.

### Q8. How does idempotency work?
**Testing:** dedup. **Answer:** `Idempotency-Key`/body key scoped `{producerId,idempotencyKey}` sparse-unique; same type+`JSON.stringify` payload → `200 isDuplicate`; mismatch → `409`; `11000` race → `200`. **Evidence:** `events.js`, `Event.js` index.

### Q9. Why deterministic job IDs with dashes?
**Testing:** dedup. **Answer:** `event-<e>-subscriber-<s>` (+`dead-letter-`, `replay-`) dedupes recovery/replay while retained; colons illegal in BullMQ IDs; `409` replay guard; eviction after 100 completions re-allows same ID. **Evidence:** `eventQueue.js`, `deadLetters.js`.

### Q10. How are retries classified?
**Testing:** failure handling. **Answer:** `isRetryableError`: no-response/408/429/5xx → retry; other 4xx + deterministic pre-delivery (inactive/missing, decrypt fail) → `UnrecoverableError` + pre-delivery log (null status/body/duration). **Evidence:** `retryPolicy.js`, `deliveryWorker.js`.

### Q11. What is the DLQ + replay contract?
**Testing:** ops. **Answer:** Terminal `webhook-dead-letter` (`failed-delivery`, failureReason/originalJobId/failedAt); admin GET waiting + POST replay (guard 409, `$inc replayCount`, retain DLQ entry, no queueStatus sync). **Evidence:** worker `failed` listener, `deadLetters.js`.

### Q12. AES-GCM vs hashing — when and why?
**Testing:** crypto choice. **Answer:** Secrets reversible-needed → AES-256-GCM `iv:tag:ct` (`WEBHOOK_ENCRYPTION_KEY`), decrypted per delivery; API keys verify-only → SHA-256 stored/compared. **Evidence:** `encryption.js`, `apiKey.js`, `Subscriber.js`.

### Q13. How does SSRF protection work?
**Testing:** security. **Answer:** `validateNoSSRF`: protocol, raw-IP/localhost blocks, `resolve4+6` every IP vs v4/v6 CIDRs, prod-https, `maxRedirects:0`, pre-dial re-check; `DISABLE_SSRF_CHECK` dev-only. **Evidence:** `ssrf.js`, worker, routes.

### Q14. How does rate limiting survive Redis outage?
**Testing:** resilience. **Answer:** Dedicated bounded conn (`enableOfflineQueue:false`, `maxRetriesPerRequest:1`, 1s race) → generic 503 fail-closed (`passOnStoreError:false`); Lua re-init on ready; BullMQ conn untouched (unbounded). **Evidence:** `rateLimitRedis.js`, `app.js`.

### Q15. How does pending-event recovery work?
**Testing:** self-healing. **Answer:** `setInterval(5000)`+immediate, batch 25, `find({queueStatus:'pending'}).sort({createdAt:1})` via compound index, `queueEventDeliveries` per event, `isRunning` guard, `DISABLE_RECOVERY` escape. Covers post-limiter `addBulk` fails only (limiter 503 never reaches it). **Evidence:** `eventQueue.js`.

### Q16. What happens on graceful shutdown?
**Testing:** ops. **Answer:** API: stop accept → clear timer → close queue → quit both Redis → close mongo (10s force). Worker: `worker.close()` drains in-flight. `SIGKILL` drops in-flight (reclaimed/retried). **Evidence:** `app.js`, `deliveryWorker.js`.

## Level 3: Advanced

### Q17. List every duplicate-delivery path.
**Testing:** at-least-once reasoning. **Answer:** timeout-before-response retry; recovery duplicate `addBulk` (post-eviction); replay-after-terminal; `11000`-race window; concurrent replay. Mitigation: subscriber `X-Webhook-Event-Id` dedup. **Evidence:** worker, `eventQueue.js`, `deadLetters.js`.

### Q18. What races exist around idempotency?
**Testing:** concurrency. **Answer:** Concurrent same-key creates → one `11000` → both `200` (safe); same-key different-payload interleave → winner stands; `JSON.stringify` order sensitivity → false `409`. **Evidence:** `events.js` try/catch `11000`.

### Q19. Where is the Mongo/Redis consistency boundary?
**Testing:** distributed state. **Answer:** `Event.create` then `addBulk` (no txn): crash between → `pending` (healed); crash after addBulk before status update → duplicate add (deduped while retained). Log-write fail doesn't fail delivery (`rethrowOnFailure:false`). **Evidence:** `events.js`, `eventQueue.js`, worker.

### Q20. What breaks if Redis is fully down?
**Testing:** failure modes. **Answer:** Ingress → limiter 503 (no Events); post-limiter adds → `pending`; worker stalls (stalled reclaimed); `/ready` 503; recovery spins pending. BullMQ unbounded waits; limiter bounded fails fast. **Evidence:** `rateLimitRedis.js`, `app.js`, `DATA_STORAGE.md` matrix.

### Q21. What breaks with 10 API replicas? Multiple workers?
**Testing:** scale. **Answer:** 10 APIs: overlapping recovery scans (process-local `isRunning`) → duplicate adds (fix: `DISABLE_RECOVERY` all-but-one / Redlock). Rate limits still correct (Redis). Workers: higher throughput, more duplicates + ordering skew; BullMQ handles distribution; stalled reclamation on crash. **Evidence:** `eventQueue.js`, `deliveryQueue.js`.

### Q22. How do replay races behave?
**Testing:** DLQ ops. **Answer:** Concurrent replays → one `add`, other `409` (safe while active/waiting); after terminal → both enqueue anew (duplicate). DLQ retained always. **Evidence:** `deadLetters.js`.

### Q23. Why jitter on top of exponential backoff?
**Testing:** retry storms. **Answer:** `1000*2^(n-1)+rand*500` via `backoffStrategy` spreads restrikes when a subscriber flaps with many queued jobs; pure exponential still herds. **Evidence:** `deliveryWorker.js` settings.

### Q24. SSRF/DNS edge cases?
**Testing:** security depth. **Answer:** TOCTOU (check-vs-dial), rebinding, mapped-IPv6 (`::ffff:`) handled, `localhost*` blocked, docs ranges blocked, metadata `169.254.169.254` blocked; bypass flag unguarded by env. **Evidence:** `ssrf.js` + tests.

### Q25. Secret handling lifetime?
**Testing:** data protection. **Answer:** Plaintext only in register body → encrypted immediately (virtual); at rest encrypted; decrypted transiently per delivery; never in jobs/events/logs; env key rotation out-of-band (no endpoint). **Evidence:** `Subscriber.js`, `encryption.js`, worker.

## Level 4: Deep-dive / system design

### Q26. Scale to 100k events/sec — what changes?
**Testing:** bottleneck analysis. **Answer:** Needs: queue partitioning (per-subscriber/sharded queues), worker fleet + autoscale, Mongo sharding + `DeliveryLog` TTL/rollup, Redis Cluster/Sentinel + persistence, bulk DLQ tooling, per-subscriber backoff/quotas, observability (lag, attempts, DLQ depth). Current single queue + retention 100/200 + per-attempt Mongo writes won't hold. **Evidence:** `deliveryQueue.js`, `DeliveryLog.js`, `LIMITATIONS_AND_TRADEOFFS.md`.

### Q27. Fix multi-replica recovery?
**Testing:** distributed coordination. **Answer:** Redlock lease around `recoverPendingEvents` or Mongo leader election / `findOneAndUpdate` claim per Event (`queueStatus:pending→claimed`) so only one replica owns a batch. **Evidence:** current `isRunning` in `eventQueue.js`.

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
