# SECURITY_DECISIONS — Mechanisms, Threats, and Residual Risk

> Format per mechanism: `Threat → Defense → Implementation → Remaining risk`. No mechanism is claimed to make an attack "impossible".

## 1. Authentication — producer / subscriber / admin

**Threat:** unauthorized ingest, subscription takeover, DLQ snooping/replay.
**Defense:** per-request API-key auth; inactive keys rejected; admin plane separated.
**Implementation:**
- Keys: `generateApiKey()=randomBytes(32).hex` (64 hex, 256-bit); stored `hashKey()=sha256.hex` in `Producer.apiSecret` / `Subscriber.apiSecret` (`src/utils/apiKey.js`, routes). Raw shown once in `201`.
- Producer: `authenticateProducer` — `x-api-key` → hash → `Producer.findOne({apiSecret,isActive:true})` → `req.producer` (401 missing/invalid, 500 DB err).
- Subscriber: `authenticateSubscriber` — same on `Subscriber` → `req.subscriber`.
- Admin: `authenticateAdmin` — `x-admin-api-key` vs per-request `ADMIN_API_KEY` as SHA-256 + `timingSafeEqual`; missing→401, unconfigured→503, mismatch→401 (`src/middlewares/authenticateAdmin.js`).
**Remaining risk:** key theft via logs/leaks (bearer tokens, no expiry/rotation endpoint); producer/subscriber `x-api-key` namespaces separate but same header (cross-use fails closed as 401); timing side-channel on producer/subscriber lookup negligible (DB query dominates) vs admin compare hardened.

## 2. Authorization — ownership + admin-only DLQ

**Threat:** cross-tenant read/update, replaying others' failures.
**Defense:** ownership checks + collection-separated credentials + router-level admin gate.
**Implementation:** `GET /events/:id` compares `event.producerId.equals(req.producer._id)` → 403 (null-`producerId` legacy events readable by any authed producer); `GET /webhooks/logs` scopes `find({subscriberId:req.subscriber._id})`; `PATCH/DELETE` mutate only `req.*`; DLQ router `router.use(authenticateAdmin)`.
**Remaining risk:** legacy null-`producerId` events lack ownership; no role granularity beyond producer/subscriber/admin.

## 3. Webhook signing — HMAC-SHA256 + raw body + timestamp + constant-time compare

**Threat:** forged deliveries, tampered payloads, replayed captures.
**Defense:** shared-secret HMAC over exact wire bytes + freshness window + timing-safe verify.
**Implementation:** worker: `bodyBuffer=Buffer(JSON.stringify(payload))`, `ts=Date.now()`, `sig=HMAC_SHA256(secret, String(ts)+'.'+bodyBuffer).hex` (`src/utils/hmac.js:generateSignature`); headers `X-Webhook-Signature/X-timestamp/X-Webhook-Event-Id/X-Webhook-Attempt/[X-Request-Id]`. `verifySignature(payload,secret,ts,received)`: `abs(now-Number(ts))>5min` or NaN → false; else `timingSafeEqual(hex(expected),hex(received))` try/catch. Mock subscriber verifies `req.rawBody` (express `verify` capture) — byte-exact, order-safe.
**Remaining risk:** 5-min replay window accepts fast replays (subscriber must add nonce/`Event-Id` dedup); clock skew >5min breaks legit traffic; key-order `JSON.stringify` must match byte-exactly (worker signs its serialization, subscriber verifies wire bytes — safe as long as subscriber uses raw body, not re-stringify).

## 4. Secret protection — AES-256-GCM + env key + minimal plaintext lifetime

**Threat:** DB read → forge all subscriber deliveries.
**Defense:** encrypt-at-rest with authenticated encryption; decrypt only inside worker at sign time.
**Implementation:** `WEBHOOK_ENCRYPTION_KEY` 64-hex env, startup-validated (fatal in prod); `encrypt`: random 12B IV, 16B tag, `iv:tag:ct` hex; `decrypt` validates format/lengths, `setAuthTag`, throws on tamper/wrong key — never falls back to plaintext (`src/utils/encryption.js`). `Subscriber.virtual('secret')` encrypts on write; worker `decrypt` per attempt; secret never in `Event`/job data/logs.
**Remaining risk:** env-key theft = total decrypt; no KMS/rotation; decrypted secret lives transiently in worker heap per delivery; `WEBHOOK_SECRET` (mock demo HMAC secret) is distinct from `WEBHOOK_ENCRYPTION_KEY` — confusing the two breaks auth silently.

## 5. SSRF — DNS resolution, blocked ranges, no-redirect, bypass

**Threat:** malicious `subscriberUrl`/`producerUrl` reaching loopback, RFC1918, link-local/metadata (`169.254.169.254`), IPv6 equivalents.
**Defense:** validate-then-dial + redirect ban.
**Implementation:** `validateNoSSRF` (`src/utils/ssrf.js`): `DISABLE_SSRF_CHECK` bypass; `new URL`; http/https (https-only prod); raw-IP `isBlockedIP`; `localhost*` block; `resolve4+resolve6` (allSettled, ≥1) → every IP vs `BLOCKED_CIDRS` (127/8,10/8,172.16/12,192.168/16,169.254/16,0/8,255…/32,docs /24s) + `BLOCKED_IPV6_CIDRS` (::1,fe80/10,fc00/7,::,mapped). Called on both registers, `PATCH /webhooks` url, and worker pre-dial; Axios `maxRedirects:0`.
**Remaining risk:** DNS TOCTOU (re-resolves between check and connect); DNS-rebinding; bypass flag has no prod guard (process discipline only); `producerUrl` never dialed so its SSRF check is hygiene, not exploit prevention.

## 6. Rate limiting — Redis-backed, dedicated bounded connection, fail-closed

**Threat:** ingest floods, DLQ/management abuse, brute-force.
**Defense:** per-IP counters that hold across replicas and never fail open.
**Implementation:** `express-rate-limit`+`RedisStore` on `rateLimitRedisConnection` (`enableOfflineQueue:false`,`maxRetriesPerRequest:1`), `sendRateLimitCommand` raced `RATE_LIMIT_REDIS_TIMEOUT_MS` 1000ms → generic 503; `passOnStoreError:false`; 100/min `/events`, 50/15min mgmt; Lua re-`init` on `ready`; test-only memory store (`src/app.js`, `src/config/rateLimitRedis.js`).
**Remaining risk:** 503s during Redis outage (by design); IP-keyed limits shared behind NAT; no per-key quotas.

## 7. Input / transport limits

- **JSON `BODY_LIMIT` 16kb** (env-overridable) → `413 {error:'Payload too large',limit}`. Threat: memory/CPU exhaustion → bounded parse. Risk: legit large payloads rejected; chunked bypass not applicable (single JSON body).
- **`WEBHOOK_TIMEOUT_MS` 5000 global.** Threat: slowloris pinning worker slots → bounded dial. Risk: slow legit subscribers DLQ after retries.
- **`maxRedirects:0`.** Threat: redirect-SSRF → blocked. Risk: redirecting subscribers fail (logged as Axios error, retried per policy).
- **`X-Request-Id` allowlist/UUID.** Threat: log/header injection → constrained charset/length. Risk: none material.
- **Response-body bound 8192+marker.** Threat: huge subscriber bodies bloating Mongo → capped audit copy. Risk: debug detail lost (behavior unaffected).

## 8. Information disclosure

- **Prod 500s sanitized** (`'Internal server error'`, no stacks) in `app.js` error handler; 503 rate-limit generic; DLQ `503` unconfigured (no key hint); SSRF `400`s expose resolved IP (`:<addr>`) — aids debugging but confirms DNS outcome to registrant.
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
| Secret rotation gap | — (no endpoint) | rotation requires out-of-band DB work |
