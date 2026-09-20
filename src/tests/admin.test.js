process.env.ADMIN_API_KEY = 'super-secret-admin-key-for-testing';

const authenticateAdmin = require('../middlewares/authenticateAdmin');

describe('Admin Authentication Middleware', () => {
  const createReqRes = (headers = {}) => {
    const req = { headers };
    const res = {
      statusCode: null,
      body: null,
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      json: function (data) {
        this.body = data;
        return this;
      },
    };
    const next = jest.fn();
    return { req, res, next };
  };

  it('rejects requests missing the X-Admin-Api-Key header (401)', () => {
    const { req, res, next } = createReqRes({});
    authenticateAdmin(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/required/i) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects requests with an incorrect API key (401)', () => {
    const { req, res, next } = createReqRes({ 'x-admin-api-key': 'wrong-admin-key' });
    authenticateAdmin(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid/i) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows requests with the correct admin API key (calls next)', () => {
    const { req, res, next } = createReqRes({
      'x-admin-api-key': 'super-secret-admin-key-for-testing',
    });
    authenticateAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });
});
