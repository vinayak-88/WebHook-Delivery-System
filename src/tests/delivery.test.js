process.env.DISABLE_SSRF_CHECK = 'true';
process.env.WEBHOOK_ENCRYPTION_KEY = 'c0ffee112233445566778899aabbccddeeff00112233445566778899aabbccdd';
process.env.WEBHOOK_TIMEOUT_MS = '5000';

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
  call: jest.fn().mockResolvedValue('OK'),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
}));
jest.mock('../queues/deliveryQueue', () => ({
  deliveryQueue: {
    add: jest.fn(),
    getJob: jest.fn(),
  },
  deadLetterQueue: {
    add: jest.fn().mockResolvedValue({ id: 'dlq-1' }),
    getWaitingCount: jest.fn().mockResolvedValue(0),
  },
  MAX_DELIVERY_ATTEMPTS: 5,
}));
jest.mock('bullmq', () => {
  class MockUnrecoverableError extends Error {
    constructor(message) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  }
  return {
    UnrecoverableError: MockUnrecoverableError,
    Worker: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

const axios = require('axios');
const { UnrecoverableError } = require('bullmq');
const DeliveryLog = require('../models/DeliveryLog');
const Subscriber = require('../models/Subscriber');
const { deadLetterQueue } = require('../queues/deliveryQueue');
const { encrypt } = require('../utils/encryption');
const {
  deliveryWorker,
  processDeliveryJob,
  truncateResponseBody,
  MAX_RESPONSE_BODY_CHARS,
} = require('../workers/deliveryWorker');

const TEST_SECRET = 'a-test-secret-that-is-at-least-32-characters-long!';

// Capture the BullMQ 'failed' listener registered at import time
// (beforeEach clearing wipes mock.calls, but this reference stays valid).
const failedHandler = deliveryWorker.on.mock.calls.find(([event]) => event === 'failed')[1];

afterAll(async () => {
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

const httpError = (status) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { error: 'subscriber error' } };
  return err;
};

beforeEach(() => {
  jest.clearAllMocks();
  Subscriber.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({
      signingKey: encrypt(TEST_SECRET),
      isActive: true,
    }),
  });
});

describe('Delivery failure classification', () => {
  it('fails fast with UnrecoverableError on permanent 4xx (400)', async () => {
    axios.post.mockRejectedValueOnce(httpError(400));

    await expect(processDeliveryJob(makeJob())).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });

    // Attempt is still audited
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 400 })
    );
    // No retry storm: exactly one outbound attempt
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 422])('fails fast on permanent %i', async (status) => {
    axios.post.mockRejectedValueOnce(httpError(status));

    await expect(processDeliveryJob(makeJob())).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
  });

  it('retries (generic error) on 429 and 5xx', async () => {
    axios.post.mockRejectedValueOnce(httpError(429));
    const first = await processDeliveryJob(makeJob()).catch((err) => err);
    expect(first).toBeInstanceOf(Error);
    expect(first.name).not.toBe('UnrecoverableError');

    jest.clearAllMocks();
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        signingKey: encrypt(TEST_SECRET),
        isActive: true,
      }),
    });

    axios.post.mockRejectedValueOnce(httpError(503));
    const second = await processDeliveryJob(makeJob()).catch((err) => err);
    expect(second.name).not.toBe('UnrecoverableError');
  });
});

describe('Outbound request safeguards', () => {
  it('sends the global timeout and disables redirects', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { received: true } });

    await processDeliveryJob(makeJob());

    expect(axios.post).toHaveBeenCalledWith(
      'http://mock-subscriber.com/receive',
      expect.any(Buffer),
      expect.objectContaining({ timeout: 5000, maxRedirects: 0 })
    );
  });

  it('records delivery duration on success and failure', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { received: true } });
    await processDeliveryJob(makeJob());
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, durationMs: expect.any(Number) })
    );

    jest.clearAllMocks();
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        signingKey: encrypt(TEST_SECRET),
        isActive: true,
      }),
    });

    axios.post.mockRejectedValueOnce(httpError(503));
    await expect(processDeliveryJob(makeJob())).rejects.toThrow();
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, durationMs: expect.any(Number) })
    );
  });
});

describe('DLQ escalation', () => {
  const dlqJob = (attemptsMade) => ({
    id: 'event-507f1f77bcf86cd799439011-subscriber-507f191e810c19729de860ea',
    attemptsMade,
    data: {
      eventId: '507f1f77bcf86cd799439011',
      subscriberId: '507f191e810c19729de860ea',
      subscriberUrl: 'http://mock-subscriber.com/receive',
      payload: { orderId: 'ORD-1' },
    },
  });

  it('moves permanent failures to the DLQ immediately (attempts not exhausted)', async () => {
    await failedHandler(dlqJob(1), new UnrecoverableError('Permanent delivery failure (status 400)'));

    expect(deadLetterQueue.add).toHaveBeenCalledTimes(1);
    expect(deadLetterQueue.add).toHaveBeenCalledWith(
      'failed-delivery',
      expect.objectContaining({
        failureReason: expect.stringContaining('Permanent delivery failure'),
        failedAt: expect.any(String),
      }),
      expect.objectContaining({ jobId: expect.stringContaining('dead-letter-') })
    );
  });

  it('moves exhausted retries to the DLQ', async () => {
    await failedHandler(dlqJob(5), new Error('Request failed with status code 503'));

    expect(deadLetterQueue.add).toHaveBeenCalledTimes(1);
  });

  it('does not escalate transient failures before attempts are exhausted', async () => {
    await failedHandler(dlqJob(2), new Error('Request failed with status code 503'));

    expect(deadLetterQueue.add).not.toHaveBeenCalled();
  });
});

describe('Pre-delivery failure classification', () => {
  const expectAuditedWithoutHttp = () => {
    expect(DeliveryLog.create).toHaveBeenCalledTimes(1);
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: null,
        responseBody: null,
        durationMs: null,
        attemptNumber: 1,
      })
    );
  };

  it('missing subscriber → permanent failure, no Axios call, audited without HTTP data', async () => {
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });

    await expect(processDeliveryJob(makeJob())).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: expect.stringContaining('inactive or not found'),
    });

    expect(axios.post).not.toHaveBeenCalled();
    expectAuditedWithoutHttp();
  });

  it('inactive subscriber → permanent failure, no Axios call, no retry loop', async () => {
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        signingKey: encrypt(TEST_SECRET),
        isActive: false,
      }),
    });

    await expect(processDeliveryJob(makeJob())).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });

    expect(axios.post).not.toHaveBeenCalled();
    expectAuditedWithoutHttp();
  });

  it('undecryptable signing secret → permanent failure, no Axios call', async () => {
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        signingKey: 'corrupt-value-that-was-never-encrypted',
        isActive: true,
      }),
    });

    await expect(processDeliveryJob(makeJob())).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: expect.stringContaining('Permanent pre-delivery failure'),
    });

    expect(axios.post).not.toHaveBeenCalled();
    expectAuditedWithoutHttp();
  });

  it('temporary database failure on lookup → stays retryable, never UnrecoverableError', async () => {
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockRejectedValue(new Error('MongoServerSelectionError: connection timed out')),
    });

    const err = await processDeliveryJob(makeJob()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('UnrecoverableError');
    expect(axios.post).not.toHaveBeenCalled();
    // The attempt never started far enough to audit — nothing fabricated
    expect(DeliveryLog.create).not.toHaveBeenCalled();
  });

  it('retries on 408 Request Timeout (generic error, like 429/5xx)', async () => {
    axios.post.mockRejectedValueOnce(httpError(408));

    const err = await processDeliveryJob(makeJob()).catch((e) => e);

    expect(err.name).not.toBe('UnrecoverableError');
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 408 })
    );
  });
});

describe('Response-body audit bound', () => {
  const TRUNCATED_SUFFIX = '...[truncated]';

  it('stores small responses unchanged', async () => {
    const data = { received: true };
    axios.post.mockResolvedValueOnce({ status: 200, data });

    await processDeliveryJob(makeJob());

    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        statusCode: 200,
        responseBody: JSON.stringify(data),
      })
    );
  });

  it('truncates large success responses and marks them, keeping success classification', async () => {
    const big = { blob: 'x'.repeat(MAX_RESPONSE_BODY_CHARS + 5000) };
    axios.post.mockResolvedValueOnce({ status: 200, data: big });

    await processDeliveryJob(makeJob());

    const stored = DeliveryLog.create.mock.calls[0][0].responseBody;
    expect(stored.endsWith(TRUNCATED_SUFFIX)).toBe(true);
    expect(stored.length).toBeLessThanOrEqual(
      MAX_RESPONSE_BODY_CHARS + TRUNCATED_SUFFIX.length
    );
    expect(stored.startsWith(JSON.stringify(big).slice(0, MAX_RESPONSE_BODY_CHARS))).toBe(true);
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, statusCode: 200 })
    );
  });

  it('truncates large failure responses without changing retry classification', async () => {
    const big = { error: 'y'.repeat(MAX_RESPONSE_BODY_CHARS + 1000) };
    const err = new Error('Request failed with status code 503');
    err.response = { status: 503, data: big };
    axios.post.mockRejectedValueOnce(err);

    const thrown = await processDeliveryJob(makeJob()).catch((e) => e);

    expect(thrown.name).not.toBe('UnrecoverableError');
    const stored = DeliveryLog.create.mock.calls[0][0].responseBody;
    expect(stored.endsWith(TRUNCATED_SUFFIX)).toBe(true);
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 503 })
    );
  });

  it('truncateResponseBody passes through short, null, and non-string values', () => {
    expect(truncateResponseBody('short')).toBe('short');
    expect(truncateResponseBody(null)).toBeNull();
    expect(truncateResponseBody(undefined)).toBeUndefined();
  });
});
