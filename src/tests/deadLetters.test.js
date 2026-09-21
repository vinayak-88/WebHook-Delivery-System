process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

jest.mock('../queues/deliveryQueue', () => ({
  deadLetterQueue: { getJob: jest.fn(), getJobs: jest.fn() },
  deliveryQueue: { getJob: jest.fn(), add: jest.fn() },
}));
jest.mock('../models/Event', () => ({ findByIdAndUpdate: jest.fn() }));
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const http = require('http');
const express = require('express');
const { deadLetterQueue, deliveryQueue } = require('../queues/deliveryQueue');
const Event = require('../models/Event');
const deadLetterRoutes = require('../routes/deadLetters');

const DLQ_JOB = {
  id: 'dead-letter:event:evt-1:subscriber:sub-1',
  data: {
    eventId: '507f1f77bcf86cd799439011',
    subscriberId: '507f191e810c19729de860ea',
    subscriberUrl: 'https://example.com/hook',
    payload: { orderId: 'ORD-1' },
    requestId: null,
    failureReason: 'Request failed with status code 500',
    failedAt: new Date().toISOString(),
  },
};

describe('Dead-letter routes (admin-authenticated)', () => {
  let server;
  let baseUrl;
  const adminHeaders = { 'X-Admin-Api-Key': 'test-admin-key' };

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/dead-letters', deadLetterRoutes);
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects DLQ inspection without the admin key (401)', async () => {
    const res = await fetch(`${baseUrl}/dead-letters`);
    expect(res.status).toBe(401);
  });

  it('lists waiting dead-letter jobs for admins', async () => {
    deadLetterQueue.getJobs.mockResolvedValueOnce([
      { ...DLQ_JOB, name: 'failed-delivery', timestamp: Date.now(), getState: async () => 'waiting' },
    ]);

    const res = await fetch(`${baseUrl}/dead-letters`, { headers: adminHeaders });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.jobs[0]).toEqual(expect.objectContaining({ eventId: DLQ_JOB.data.eventId }));
  });

  it('replays a single job and tracks it on the parent event (202)', async () => {
    deadLetterQueue.getJob.mockResolvedValueOnce(DLQ_JOB);
    deliveryQueue.getJob.mockResolvedValueOnce(null);
    deliveryQueue.add.mockResolvedValueOnce({ id: `replay:${DLQ_JOB.id}` });

    const res = await fetch(
      `${baseUrl}/dead-letters/${encodeURIComponent(DLQ_JOB.id)}/replay`,
      { method: 'POST', headers: adminHeaders }
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(deliveryQueue.add).toHaveBeenCalledTimes(1);
    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      DLQ_JOB.data.eventId,
      expect.objectContaining({
        $inc: { replayCount: 1 },
        lastReplayedAt: expect.any(Date),
      })
    );
    expect(body.replayJobId).toBe(`replay:${DLQ_JOB.id}`);
  });

  it('returns 409 when a replay for the job is already active', async () => {
    deadLetterQueue.getJob.mockResolvedValueOnce(DLQ_JOB);
    deliveryQueue.getJob.mockResolvedValueOnce({
      id: `replay:${DLQ_JOB.id}`,
      getState: async () => 'active',
    });

    const res = await fetch(
      `${baseUrl}/dead-letters/${encodeURIComponent(DLQ_JOB.id)}/replay`,
      { method: 'POST', headers: adminHeaders }
    );

    expect(res.status).toBe(409);
    expect(deliveryQueue.add).not.toHaveBeenCalled();
    expect(Event.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown dead-letter job', async () => {
    deadLetterQueue.getJob.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/dead-letters/nope/replay`, {
      method: 'POST',
      headers: adminHeaders,
    });

    expect(res.status).toBe(404);
    expect(deliveryQueue.add).not.toHaveBeenCalled();
  });
});
