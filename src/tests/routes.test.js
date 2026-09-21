process.env.NODE_ENV = 'test';
process.env.BODY_LIMIT = '1kb';
process.env.WEBHOOK_ENCRYPTION_KEY = 'c0ffee112233445566778899aabbccddeeff00112233445566778899aabbccdd';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.DISABLE_RECOVERY = 'true';

jest.mock('../config/db', () => jest.fn().mockResolvedValue());
jest.mock('../config/redis', () => ({
  ping: jest.fn().mockResolvedValue('PONG'),
  call: jest.fn().mockResolvedValue('OK'),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
}));
jest.mock('../config/rateLimitRedis', () => ({
  rateLimitRedisConnection: {
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  },
  sendRateLimitCommand: jest.fn().mockResolvedValue('OK'),
  registerRateLimitStore: jest.fn(),
  RATE_LIMIT_REDIS_TIMEOUT_MS: 1000,
}));
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../queues/deliveryQueue', () => ({
  deliveryQueue: { close: jest.fn() },
  deadLetterQueue: { close: jest.fn() },
}));
jest.mock('../utils/eventQueue', () => ({
  startPendingEventRecovery: jest.fn(),
  queueEventDeliveries: jest.fn(),
}));

const mongoose = require('mongoose');
const redisConnection = require('../config/redis');
const app = require('../app');

// Minimal mock server/request helper without external dependencies
const http = require('http');

describe('API Routes & Operational Endpoints', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  describe('GET /health', () => {
    it('returns status ok and timestamp (liveness)', async () => {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('GET /ready', () => {
    const originalReadyStateDescriptor = Object.getOwnPropertyDescriptor(
      mongoose.connection,
      'readyState'
    );
    let originalReadyState;

    beforeEach(() => {
      originalReadyState = mongoose.connection.readyState;
    });

    afterEach(() => {
      // Restore original readyState (defineProperty covers both data & accessor cases)
      try {
        if (originalReadyStateDescriptor) {
          Object.defineProperty(mongoose.connection, 'readyState', originalReadyStateDescriptor);
        } else {
          mongoose.connection.readyState = originalReadyState;
        }
      } catch {
        mongoose.connection.readyState = originalReadyState;
      }
      jest.restoreAllMocks();
    });

    const setReadyState = (value) => {
      // readyState is a plain data property on mongoose Connection — assign directly
      try {
        Object.defineProperty(mongoose.connection, 'readyState', {
          value,
          writable: true,
          configurable: true,
        });
      } catch {
        mongoose.connection.readyState = value;
      }
    };

    it('returns ready (200) when both Mongo and Redis are connected', async () => {
      // Mock mongoose readyState 1 (connected)
      setReadyState(1);
      redisConnection.ping.mockResolvedValueOnce('PONG');

      const res = await fetch(`${baseUrl}/ready`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.dependencies.mongodb).toBe('connected');
      expect(body.dependencies.redis).toBe('connected');
    });

    it('returns unready (503) when Mongo is disconnected', async () => {
      setReadyState(0);
      redisConnection.ping.mockResolvedValueOnce('PONG');

      const res = await fetch(`${baseUrl}/ready`);
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.status).toBe('unready');
      expect(body.dependencies.mongodb).toBe('disconnected');
    });

    it('returns unready (503) when Redis is disconnected', async () => {
      setReadyState(1);
      redisConnection.ping.mockRejectedValueOnce(new Error('Connection lost'));

      const res = await fetch(`${baseUrl}/ready`);
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.status).toBe('unready');
      expect(body.dependencies.redis).toBe('disconnected');
    });
  });

  describe('Request ID middleware', () => {
    it('generates X-Request-Id header when none provided', async () => {
      const res = await fetch(`${baseUrl}/health`);
      const reqId = res.headers.get('x-request-id');
      expect(reqId).toBeDefined();
      expect(reqId.length).toBeGreaterThan(0);
    });

    it('propagates a valid incoming X-Request-Id header', async () => {
      const customId = 'custom-trace-id-12345';
      const res = await fetch(`${baseUrl}/health`, {
        headers: { 'X-Request-Id': customId },
      });
      expect(res.headers.get('x-request-id')).toBe(customId);
    });
  });

  describe('Payload size limit', () => {
    it('returns 413 Payload Too Large when request body exceeds configured limit', async () => {
      // Configured to 1kb in beforeAll
      const oversizedPayload = JSON.stringify({ data: 'x'.repeat(2048) });

      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'some-key',
        },
        body: oversizedPayload,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toMatch(/Payload too large/i);
    });
  });
});
