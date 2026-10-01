# LIMITATIONS_AND_TRADEOFFS — Real Limits and Deliberate Tradeoffs

> Every claim tied to code. `Choice → Benefit → Cost → Why acceptable`.

## Current limitations (genuinely cannot do today)

1. **Single-job DLQ replay only; no bulk replay.** `POST /dead-letters/:jobId/replay` handles one DLQ ID; bulk endpoint was deliberately removed (scope note). Large backlogs need scripting.
2. **Replay doesn't remove DLQ entry nor sync `queueStatus`.** Replay adds `replay-*` job + `$inc replayCount`; DLQ job retained; `Event.queueStatus/deliveryTargets` untouched; post-terminal re-replay enqueues anew (`src/routes/deadLetters.js`).
3. **No per-subscriber timeout/policy.** Single `WEBHOOK_TIMEOUT_MS` for all dials (per-subscriber config removed by design).
4. **No secret rotation endpoint.** Secret change requires direct DB/manual flow; no migration path in code.
5. **No EventType registry.** `noun.verb` is regex-only; producer `allowedEvents` + subscriber `events` are free-form strings (typos fail silently as `no_subscribers`).
6. **No DLQ monitoring/alerting.** DLQ is poll-only (`GET /dead-letters`); no metrics/webhooks (removed by scope).
7. **No ordering guarantee.** BullMQ concurrency + backoff + retries + replay can reorder per-subscriber deliveries; no sequence numbers.
8. **Payload compare is key-order sensitive.** Idempotency uses `JSON.stringify` equality; semantically equal objects with different key order → `409`.
9. **DNS TOCTOU in SSRF.** Validate-then-dial window allows DNS change between `resolve4/6` and Axios connect; no dial-time IP pinning.
10. **Truncated audit bodies.** Responses >8192 chars persisted with `...[truncated]`; full bodies not recoverable from `DeliveryLog`.

## Deliberate tradeoffs

- **At-least-once (not exactly-once).** Choice: retry+recovery+replay → Benefit: no silent loss → Cost: duplicates (timeout-before-response, recovery race, post-eviction re-add) → Acceptable: subscribers keyed on `X-Webhook-Event-Id`.
- **Async `202` (not sync `200`).** Choice: persist+enqueue then respond → Benefit: API immune to subscriber slowness → Cost: client polls logs/status; `queued≠delivered` → Acceptable: documented + `GET /events/:id` + logs.
- **Fail-fast permanent 4xx via `UnrecoverableError`.** Choice: 400/401/403/404 etc. → DLQ immediately → Benefit: preserves attempts/capacity → Cost: subscriber misusing 4xx for transient gets no retry → Acceptable: rule documented (`408/429/5xx`/no-response retry).
- **Deterministic job IDs with eviction window.** Choice: `event-*-subscriber-*` dedup → Benefit: recovery/replay safe while retained → Cost: after `removeOnComplete:100` same ID re-executes → Acceptable: small demo scale; documented.
- **Encrypted secrets + hashed keys.** Choice: AES-GCM reversible secrets, SHA-256 verify-only keys → Benefit: DB read ≠ forge/authenticate → Cost: env key management + per-delivery decrypt → Acceptable: standard pattern at this scale.
- **Fail-closed rate limiting.** Choice: Redis error → `503` not pass-through → Benefit: never un-limited during outage → Cost: `503`s even for valid traffic when Redis down → Acceptable: safe default; test env uses memory store.
- **Global timeout + `maxRedirects:0`.** Choice: one timeout, no follows → Benefit: bounded slots, no redirect-SSRF → Cost: no per-subscriber tuning; redirecting subscribers break → Acceptable: simplicity + security.
- **Sparse unique idempotency (per-producer).** Choice: `{producerId,idempotencyKey}` unique, nulls excluded → Benefit: keyless events unlimited, tenants isolated → Cost: cross-producer sharing impossible; blank keys never dedupe → Acceptable: matches ownership model.

## Operational limitations

- **Redis down at ingress → `503`, no Event stored.** Limiter (bounded conn) rejects before persistence; `202+pending` recovery only covers post-limiter `addBulk` failures (`src/app.js`, `rateLimitRedis.js`).
- **Redis down mid-flight → deliveries pause; stalled `active` reclaimed on reconnect.** Waiting/delayed durability depends on Redis persistence (image defaults; no custom `redis.conf` in repo — Not determinable beyond volume `redis_data`).
- **Mongo down at ingest → `500`, nothing queued.** Worker subscriber-fetch fail → retry; log-write fail → logged, delivery continues (`rethrowOnFailure:false`).
- **Config sensitivity:** missing/invalid `WEBHOOK_ENCRYPTION_KEY` fatal in production; missing `ADMIN_API_KEY` → DLQ `503`; `BODY_LIMIT` overflow → `413`; `DISABLE_SSRF_CHECK=true` must never reach production.
- **Logs:** file+console; Docker bind-mount `./logs` required to survive recreation; no log rotation in code.

## Scalability limitations

- **Single-instance recovery.** `isRunning` is process-local; N API replicas → overlapping scans + duplicate `addBulk` (mitigated while jobs retained, not after eviction). Mitigation in code: `DISABLE_RECOVERY=true` on all but one. Production fix: Redlock/leader election (`src/utils/eventQueue.js`).
- **Rate limits hold across replicas (Redis-backed)** — safe to scale API horizontally for throttling; worker scales via `WORKER_CONCURRENCY` (event-loop concurrency, not threads) + more worker containers (at-least-once duplicates rise with concurrency).
- **No queue partitioning/priority.** One `webhook-delivery` queue; hot subscriber head-of-line blocks behind same concurrency pool.
- **Retention windows bound history.** `removeOnComplete:100/removeOnFail:200` (main), `500/200` (DLQ) — high throughput evicts fast; replay-after-eviction creates new work silently.

## Reliability limitations

- **Mongo↔Redis dual-write boundary.** `Event.create` then `addBulk`: crash between → `pending` (healed by recovery); crash after `addBulk` before `queueStatus` update → duplicate enqueue on recovery (deduped while retained).
- **Idempotency race:** concurrent same-key creates → one `11000` → both resolve `200` (safe); same-key different-payload race → winner's Event stands, loser may `409` or `200` depending on interleaving.
- **Replay race:** concurrent replays → one wins `add`, other `409` (safe while first active); after terminal, both enqueue anew (duplicate delivery).
- **Backoff ceiling:** 1s→2s→4s→8s+jitter (~15s+ per job); long subscriber outage → DLQ after 5 attempts regardless of recovery mid-window.
- **`SIGKILL`/container kill:** in-flight Axios dropped; BullMQ reclaims stalled; API un-`queueStatus`-updated Events healed by recovery.

## Security tradeoffs

- **SSRF bypass flag.** `DISABLE_SSRF_CHECK=true` enables localhost demos (`host.docker.internal` in Docker) but disables all DNS/IP checks — dev-only by contract, no code gate on `NODE_ENV`.
- **Key-order idempotency + `JSON.stringify`.** Simplicity over canonical JSON; cost documented above.
- **Response bodies in `DeliveryLog`.** Audit value vs PII retention: subscriber responses (possibly sensitive) persisted up to 8k; no redaction/ закули TTL.
- **`producerUrl` regex is loose.** Schema regex requires dotted hostname but not full URL validity; SSRF layer provides the real protection.
- **No mTLS / payload encryption.** HMAC authenticates + TLS (HTTPS in production) protects transit; payload itself is plaintext JSON to subscriber.
