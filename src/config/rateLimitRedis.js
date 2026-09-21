const { Redis } = require("ioredis");
const logger = require("./logger");

// Upper bound for a single rate-limit Redis round-trip at request time.
// Healthy local Redis answers in milliseconds; this default only bites when
// Redis is unavailable, turning an indefinite hang into a fast fail-closed
// 503. Override with RATE_LIMIT_REDIS_TIMEOUT_MS if needed.
const RATE_LIMIT_REDIS_TIMEOUT_MS =
  Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS) || 1000;

// Dedicated connection for rate limiting ONLY. The BullMQ connection
// (src/config/redis.js) requires maxRetriesPerRequest: null and an unbounded
// offline queue; sharing it lets a Redis outage hang HTTP requests forever
// inside the rate limiter, before they ever reach event persistence.
// This connection is tuned the opposite way for request-time use:
// - enableOfflineQueue: false → commands issued while disconnected reject
//   immediately instead of queueing behind an endless reconnect loop.
// - maxRetriesPerRequest: 1 → a flaky-but-connected Redis can't pile
//   retries onto request latency.
// - Default reconnect strategy is kept, so normal operation resumes on its
//   own once Redis is back (no restart needed).
const rateLimitRedisConnection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

rateLimitRedisConnection.on("connect", () =>
  logger.info("Rate-limit Redis connected"),
);
rateLimitRedisConnection.on("error", (err) =>
  logger.warn("Rate-limit Redis error", { error: err.message }),
);

const serviceUnavailable = () => {
  const err = new Error("Service temporarily unavailable");
  err.statusCode = 503;
  return err;
};

/**
 * Stores registered by the app so their Lua scripts can be (re)loaded.
 * express-rate-limit calls store.init() once at setup; if Redis is not
 * reachable then, the stored SHA promises stay rejected forever and the
 * limiter would never recover. Re-running init on every (re)connect keeps
 * recovery restart-free, including booting while Redis is down.
 */
const registeredStores = [];

const registerRateLimitStore = (store, windowMs) => {
  registeredStores.push({ store, windowMs });
};

rateLimitRedisConnection.on("ready", () => {
  for (const { store, windowMs } of registeredStores) {
    if (store && typeof store.init === "function") {
      store.init({ windowMs }).catch((err) => {
        logger.warn("Rate-limit store re-init failed", { error: err.message });
      });
    }
  }
});

/**
 * Waits for a usable connection, bounded by the caller (see below).
 * Resolves immediately when already connected; rejects as soon as the
 * client reports the connection is down instead of waiting out a
 * reconnect loop that request-time code must never sit through.
 */
const whenUsable = () =>
  new Promise((resolve, reject) => {
    if (rateLimitRedisConnection.status === "ready") {
      resolve();
      return;
    }
    const cleanup = () => {
      rateLimitRedisConnection.removeListener("ready", onReady);
      rateLimitRedisConnection.removeListener("close", onClosed);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onClosed = () => {
      cleanup();
      reject(serviceUnavailable());
    };
    rateLimitRedisConnection.once("ready", onReady);
    rateLimitRedisConnection.once("close", onClosed);
  });

/**
 * Runs a rate-limit Redis command with a hard upper bound.
 * On any Redis failure the request fails closed with a generic 503:
 * internal details are never exposed and the request is never let
 * through un-limited.
 */
const sendRateLimitCommand = (...args) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(serviceUnavailable()), RATE_LIMIT_REDIS_TIMEOUT_MS);
  });

  const run = whenUsable().then(() => rateLimitRedisConnection.call(...args));

  return Promise.race([run, timeout])
    .catch(() => {
      throw serviceUnavailable();
    })
    .finally(() => clearTimeout(timer));
};

module.exports = {
  rateLimitRedisConnection,
  sendRateLimitCommand,
  registerRateLimitStore,
  RATE_LIMIT_REDIS_TIMEOUT_MS,
};
