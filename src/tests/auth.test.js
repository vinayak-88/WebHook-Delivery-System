jest.mock('../models/Producer', () => ({ findOne: jest.fn() }));
jest.mock('../models/Subscriber', () => ({ findOne: jest.fn() }));
jest.mock('../utils/apiKey', () => ({
  hashKey: jest.fn((key) => `hashed:${key}`),
}));

const Producer = require('../models/Producer');
const Subscriber = require('../models/Subscriber');
const authenticateProducer = require('../middlewares/authenticateProducer');
const authenticateSubscriber = require('../middlewares/authenticateSubscriber');

const createReqRes = (headers = {}) => {
  const req = { headers };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  const next = jest.fn();
  return { req, res, next };
};

describe.each([
  ['producer', authenticateProducer, Producer],
  ['subscriber', authenticateSubscriber, Subscriber],
])('%s API-key authentication', (label, middleware, Model) => {
  void label;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects requests with no API key (401)', async () => {
    const { req, res, next } = createReqRes({});

    await middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/required/i) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects requests with an invalid API key (401)', async () => {
    Model.findOne.mockResolvedValueOnce(null);
    const { req, res, next } = createReqRes({ 'x-api-key': 'wrong-key' });

    await middleware(req, res, next);

    expect(Model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ apiSecret: 'hashed:wrong-key', isActive: true })
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid/i) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects inactive credentials (401)', async () => {
    // Inactive records never match the { isActive: true } query
    Model.findOne.mockResolvedValueOnce(null);
    const { req, res, next } = createReqRes({ 'x-api-key': 'deactivated-key' });

    await middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows requests with a valid active API key', async () => {
    const record = { _id: 'record-1', isActive: true };
    Model.findOne.mockResolvedValueOnce(record);
    const { req, res, next } = createReqRes({ 'x-api-key': 'good-key' });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });
});
