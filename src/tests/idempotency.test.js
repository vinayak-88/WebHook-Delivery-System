process.env.NODE_ENV = 'test';

jest.mock('../models/Producer', () => ({ findOne: jest.fn() }));
jest.mock('../models/Subscriber', () => ({ find: jest.fn() }));
jest.mock('../models/Event', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../utils/eventQueue', () => ({
  queueEventDeliveries: jest.fn(),
  startPendingEventRecovery: jest.fn(),
}));
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const http = require('http');
const express = require('express');
const Producer = require('../models/Producer');
const Subscriber = require('../models/Subscriber');
const Event = require('../models/Event');
const { queueEventDeliveries } = require('../utils/eventQueue');
const eventRoutes = require('../routes/events');

const PRODUCER = { _id: '507f1f77bcf86cd799439011', allowedEvents: ['payment.success'] };
const PAYLOAD = { orderId: 'ORD-1', amount: 100 };

describe('POST /events ingestion idempotency', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/events', eventRoutes);
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
    Producer.findOne.mockResolvedValue(PRODUCER);
    Subscriber.find.mockResolvedValue([]);
  });

  const postEvent = (body, headers = {}) =>
    fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'prod-key', ...headers },
      body: JSON.stringify(body),
    });

  it('first request with a key creates the event and enqueues once (202)', async () => {
    Event.findOne.mockResolvedValueOnce(null);
    Event.create.mockResolvedValueOnce({ _id: 'evt-1' });
    queueEventDeliveries.mockResolvedValueOnce({ jobsQueued: 1, queueStatus: 'queued' });

    const res = await postEvent({ type: 'payment.success', payload: PAYLOAD, idempotencyKey: 'abc123' });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(Event.create).toHaveBeenCalledTimes(1);
    expect(Event.create).toHaveBeenCalledWith(
      expect.objectContaining({ producerId: PRODUCER._id, idempotencyKey: 'abc123' })
    );
    expect(queueEventDeliveries).toHaveBeenCalledTimes(1);
    expect(body.eventId).toBe('evt-1');
  });

  it('same key + same request returns the existing event without duplicating (200)', async () => {
    Event.findOne.mockResolvedValueOnce({
      _id: 'evt-1',
      type: 'payment.success',
      payload: { ...PAYLOAD },
      queueStatus: 'queued',
      queuedJobCount: 1,
    });

    const res = await postEvent({ type: 'payment.success', payload: PAYLOAD, idempotencyKey: 'abc123' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.isDuplicate).toBe(true);
    expect(body.eventId).toBe('evt-1');
    expect(Event.create).not.toHaveBeenCalled();
    expect(queueEventDeliveries).not.toHaveBeenCalled();
  });

  it('same key + different payload is rejected (409)', async () => {
    Event.findOne.mockResolvedValueOnce({
      _id: 'evt-1',
      type: 'payment.success',
      payload: { ...PAYLOAD },
      queueStatus: 'queued',
      queuedJobCount: 1,
    });

    const res = await postEvent({
      type: 'payment.success',
      payload: { orderId: 'ORD-1', amount: 99999 },
      idempotencyKey: 'abc123',
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/different event type or payload/i);
    expect(Event.create).not.toHaveBeenCalled();
    expect(queueEventDeliveries).not.toHaveBeenCalled();
  });

  it('accepts the key via the Idempotency-Key header', async () => {
    Event.findOne.mockResolvedValueOnce({
      _id: 'evt-1',
      type: 'payment.success',
      payload: { ...PAYLOAD },
      queueStatus: 'queued',
      queuedJobCount: 1,
    });

    const res = await postEvent(
      { type: 'payment.success', payload: PAYLOAD },
      { 'Idempotency-Key': 'abc123' }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.isDuplicate).toBe(true);
    expect(Event.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ producerId: PRODUCER._id, idempotencyKey: 'abc123' })
    );
  });
});
