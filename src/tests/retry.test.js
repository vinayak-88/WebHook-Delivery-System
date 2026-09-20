process.env.DISABLE_SSRF_CHECK = 'true';
process.env.WEBHOOK_ENCRYPTION_KEY = 'c0ffee112233445566778899aabbccddeeff00112233445566778899aabbccdd';

const { generateSignature, verifySignature } = require('../utils/hmac');

jest.mock('axios');
jest.mock('../models/DeliveryLog', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Subscriber', () => ({
  findById: jest.fn(),
}));
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../config/redis', () => ({
  mget: jest.fn().mockResolvedValue([null, null]),
  incr: jest.fn().mockResolvedValue(1),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  mset: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  call: jest.fn().mockResolvedValue('OK'),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
}));
jest.mock('../queues/deliveryQueue', () => ({
  deadLetterQueue: {
    add: jest.fn().mockResolvedValue({ id: 'dlq-1' }),
    getWaitingCount: jest.fn().mockResolvedValue(0),
  },
  MAX_DELIVERY_ATTEMPTS: 5,
}));
// Mock BullMQ Worker so importing deliveryWorker doesn't hold open Redis
// handles/timers in Jest. processDeliveryJob (the real handler) is still tested.
jest.mock('bullmq', () => {
  class MockDelayedError extends Error {
    constructor() {
      super('Delayed');
      this.name = 'DelayedError';
    }
  }
  return {
    DelayedError: MockDelayedError,
    Worker: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

const axios = require('axios');
const DeliveryLog = require('../models/DeliveryLog');
const Subscriber = require('../models/Subscriber');
const { encrypt } = require('../utils/encryption');
const { deliveryWorker, processDeliveryJob } = require('../workers/deliveryWorker');

const TEST_SECRET = 'a-test-secret-that-is-at-least-32-characters-long!';

afterAll(async () => {
  // Close the BullMQ worker so Jest can exit cleanly (no open handles)
  try {
    await deliveryWorker.close();
  } catch {}
});

const makeJob = (overrides = {}) => ({
  id: 'job-test-1',
  attemptsMade: 0,
  token: 'mock-token',
  data: {
    eventId: '507f1f77bcf86cd799439011',
    subscriberId: '507f191e810c19729de860ea',
    subscriberUrl: 'http://mock-subscriber.com/receive',
    payload: { orderId: 'ORD-1' },
    requestId: 'req-123',
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  Subscriber.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({
      // Store the secret encrypted, as the real registration path does —
      // exercises the worker's decrypt-before-sign code path.
      signingKey: encrypt(TEST_SECRET),
      isActive: true,
      timeoutMs: 5000,
    }),
  });
});

// --- HMAC integration ---
describe('Delivery Signature Behaviour', () => {
  it('secret-signed payload produces a verifiable signature on subscriber side', () => {
    const payload = { orderId: 'ORD-999', amount: 500 };
    const bodyBuffer = Buffer.from(JSON.stringify(payload));
    const now = Date.now();
    const signature = generateSignature(bodyBuffer, TEST_SECRET, now);
    expect(verifySignature(bodyBuffer, TEST_SECRET, now, signature)).toBe(true);
  });

  it('subscriber rejects a delivery where payload was modified in transit', () => {
    const payload = { orderId: 'ORD-999', amount: 500 };
    const bodyBuffer = Buffer.from(JSON.stringify(payload));
    const now = Date.now();
    const signature = generateSignature(bodyBuffer, TEST_SECRET, now);
    const modifiedBuffer = Buffer.from(JSON.stringify({ ...payload, amount: 99999 }));
    expect(verifySignature(modifiedBuffer, TEST_SECRET, now, signature)).toBe(false);
  });

  it('wrong secret does not verify a signed payload', () => {
    const payload = { orderId: 'ORD-999', amount: 500 };
    const bodyBuffer = Buffer.from(JSON.stringify(payload));
    const now = Date.now();
    const signature = generateSignature(bodyBuffer, TEST_SECRET, now);
    expect(verifySignature(bodyBuffer, 'completely-different-secret-32-chars-long!', now, signature)).toBe(false);
  });
});

// --- Retry behaviour via processDeliveryJob ---
describe('Delivery Retry Behaviour', () => {
  it('resolves and logs success on 200', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { received: true } });

    await processDeliveryJob(makeJob());

    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, statusCode: 200 })
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('throws on 503 so BullMQ knows to retry, logs the failure', async () => {
    const err = new Error('Request failed with status code 503');
    err.response = { status: 503, data: { error: 'unavailable' } };
    axios.post.mockRejectedValueOnce(err);

    await expect(processDeliveryJob(makeJob())).rejects.toThrow();

    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 503 })
    );
  });

  it('throws on network timeout, logs null statusCode', async () => {
    const err = new Error('ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    axios.post.mockRejectedValueOnce(err);

    await expect(processDeliveryJob(makeJob())).rejects.toThrow('ECONNREFUSED');

    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: null })
    );
  });

  it('throws permanently when subscriber record is not found', async () => {
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });

    await expect(processDeliveryJob(makeJob())).rejects.toThrow(
      'Subscriber 507f191e810c19729de860ea is inactive or not found'
    );

    expect(axios.post).not.toHaveBeenCalled();
    expect(DeliveryLog.create).not.toHaveBeenCalled();
  });

  it('succeeds after simulated retry (fail once then succeed)', async () => {
    const networkError = new Error('Service temporarily unavailable');
    networkError.response = { status: 503, data: {} };

    // Attempt 1 — fails
    axios.post.mockRejectedValueOnce(networkError);
    await expect(processDeliveryJob(makeJob({ attemptsMade: 0 }))).rejects.toThrow();
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, attemptNumber: 1 })
    );

    jest.clearAllMocks();
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        signingKey: encrypt(TEST_SECRET),
        isActive: true,
        timeoutMs: 5000,
      }),
    });

    // Attempt 2 — succeeds
    axios.post.mockResolvedValueOnce({ status: 200, data: { received: true } });
    await processDeliveryJob(makeJob({ attemptsMade: 1 }));
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, attemptNumber: 2 })
    );
  });
});