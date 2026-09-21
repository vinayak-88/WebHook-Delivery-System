process.env.NODE_ENV = 'test';
process.env.REDIS_HOST = 'redis-test-host';
process.env.REDIS_PORT = '6380';
process.env.RATE_LIMIT_REDIS_TIMEOUT_MS = '150';

jest.mock('ioredis', () => {
  const { EventEmitter } = require('events');
  return {
    Redis: jest.fn().mockImplementation((opts) => {
      const client = new EventEmitter();
      client.options = opts;
      client.call = jest.fn().mockResolvedValue('OK');
      client.quit = jest.fn().mockResolvedValue('OK');
      return client;
    }),
  };
});
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { Redis } = require('ioredis');
const {
  rateLimitRedisConnection,
  sendRateLimitCommand,
  registerRateLimitStore,
  RATE_LIMIT_REDIS_TIMEOUT_MS,
} = require('../config/rateLimitRedis');

const client = () => Redis.mock.results[0].value;

describe('Rate-limit Redis connection', () => {
  it('uses a dedicated connection tuned for bounded request-time use', () => {
    expect(Redis).toHaveBeenCalledTimes(1);
    expect(Redis).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'redis-test-host',
        port: 6380,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      })
    );
    expect(Redis.mock.calls[0][0].maxRetriesPerRequest).not.toBeNull();
    expect(RATE_LIMIT_REDIS_TIMEOUT_MS).toBe(150);
  });

  it('does not share the BullMQ connection (isolation)', () => {
    const bullmqRedisSrc = fs.readFileSync(
      path.join(__dirname, '..', 'config', 'redis.js'),
      'utf8'
    );
    // BullMQ keeps its required unbounded semantics
    expect(bullmqRedisSrc).toMatch(/maxRetriesPerRequest:\s*null/);
    expect(bullmqRedisSrc).not.toMatch(/enableOfflineQueue/);

    const queueSrc = fs.readFileSync(
      path.join(__dirname, '..', 'queues', 'deliveryQueue.js'),
      'utf8'
    );
    expect(queueSrc).toContain("require('../config/redis')");
    expect(queueSrc).not.toContain('rateLimitRedis');

    const rateLimitSrc = fs.readFileSync(
      path.join(__dirname, '..', 'config', 'rateLimitRedis.js'),
      'utf8'
    );
    expect(rateLimitSrc).not.toContain("require('./redis')");
    expect(rateLimitSrc).toContain('maxRetriesPerRequest: 1');
  });
});

describe('sendRateLimitCommand', () => {
  beforeEach(() => {
    client().call.mockReset();
    client().call.mockResolvedValue('OK');
    client().status = 'ready';
  });

  it('passes successful commands through normally', async () => {
    await expect(sendRateLimitCommand('PING')).resolves.toBe('OK');
    expect(client().call).toHaveBeenCalledWith('PING');
  });

  it('fails closed with a generic 503 when Redis rejects (no hang, no leak)', async () => {
    client().call.mockRejectedValueOnce(new Error('Connection is closed'));

    const startedAt = Date.now();
    const err = await sendRateLimitCommand('EVALSHA', 'abc', 1, 'k').catch((e) => e);
    const elapsedMs = Date.now() - startedAt;

    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(503);
    expect(err.message).toBe('Service temporarily unavailable');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('bounds a hung Redis command within the configured timeout', async () => {
    client().call.mockImplementationOnce(() => new Promise(() => {}));

    const startedAt = Date.now();
    const err = await sendRateLimitCommand('EVALSHA', 'abc', 1, 'k').catch((e) => e);
    const elapsedMs = Date.now() - startedAt;

    // Settles via timeout instead of hanging until Jest gives up
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(503);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('recovers without restart: success works again after a failure', async () => {
    client().call.mockRejectedValueOnce(new Error('Connection is closed'));

    await expect(sendRateLimitCommand('PING')).rejects.toMatchObject({ statusCode: 503 });
    await expect(sendRateLimitCommand('PING')).resolves.toBe('OK');
  });

  it('exposes the shared connection for graceful shutdown', async () => {
    expect(rateLimitRedisConnection).toBe(client());
    await expect(rateLimitRedisConnection.quit()).resolves.toBe('OK');
  });

  it('waits for the connection at startup instead of failing the first requests', async () => {
    client().status = 'connecting';
    const pending = sendRateLimitCommand('PING');

    // Not ready yet: nothing sent, but nothing rejected either
    expect(client().call).not.toHaveBeenCalled();

    setTimeout(() => {
      client().status = 'ready';
      client().emit('ready');
    }, 20);

    await expect(pending).resolves.toBe('OK');
    expect(client().call).toHaveBeenCalledWith('PING');
    client().status = 'ready';
  });

  it('rejects immediately when the connection reports it is down', async () => {
    client().status = 'reconnecting';
    // Simulate ioredis closing: listeners attached by the pending command fire
    const pending = sendRateLimitCommand('PING');
    client().emit('close');

    const startedAt = Date.now();
    const err = await pending.catch((e) => e);

    expect(err).toMatchObject({ statusCode: 503, message: 'Service temporarily unavailable' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(client().call).not.toHaveBeenCalled();
    client().status = 'ready';
  });
});

describe('Lua script recovery without restart', () => {
  it('re-runs store init on reconnect so a boot-time outage heals itself', async () => {
    const store = { init: jest.fn().mockResolvedValue(undefined) };
    registerRateLimitStore(store, 60000);

    client().emit('ready');
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.init).toHaveBeenCalledWith({ windowMs: 60000 });

    // A failing re-init is contained (warned, not thrown)
    store.init.mockRejectedValueOnce(new Error('boom'));
    client().emit('ready');
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.init).toHaveBeenCalledTimes(2);
  });
});
