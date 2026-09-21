const { isRetryableError } = require('../utils/retryPolicy');

const httpError = (status) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: {} };
  return err;
};

describe('Retry classification (isRetryableError)', () => {
  describe('transient failures → retry', () => {
    it('retries network errors with no HTTP response', () => {
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    });

    it('retries DNS failures and timeouts', () => {
      const dns = new Error('getaddrinfo ENOTFOUND example.com');
      dns.code = 'ENOTFOUND';
      expect(isRetryableError(dns)).toBe(true);

      const timeout = new Error('timeout of 5000ms exceeded');
      timeout.code = 'ECONNABORTED';
      expect(isRetryableError(timeout)).toBe(true);
    });

    it('retries 408 Request Timeout and 429 Too Many Requests', () => {
      expect(isRetryableError(httpError(408))).toBe(true);
      expect(isRetryableError(httpError(429))).toBe(true);
    });

    it('retries all 5xx responses', () => {
      for (const status of [500, 502, 503, 504]) {
        expect(isRetryableError(httpError(status))).toBe(true);
      }
    });
  });

  describe('permanent failures → do not retry', () => {
    it.each([400, 401, 403, 404, 405, 409, 410, 415, 422])(
      'treats %i as permanent',
      (status) => {
        expect(isRetryableError(httpError(status))).toBe(false);
      }
    );
  });
});
