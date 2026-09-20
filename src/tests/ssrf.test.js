const { isBlockedIP, validateNoSSRF } = require('../utils/ssrf');

describe('SSRF Protection Utility', () => {
  describe('isBlockedIP', () => {
    it('blocks IPv4 loopback (127.0.0.1, 127.0.1.1)', () => {
      expect(isBlockedIP('127.0.0.1')).toBe(true);
      expect(isBlockedIP('127.0.1.10')).toBe(true);
    });

    it('blocks RFC 1918 private IPv4 ranges (10.x, 172.16.x, 192.168.x)', () => {
      expect(isBlockedIP('10.0.0.1')).toBe(true);
      expect(isBlockedIP('10.255.255.255')).toBe(true);
      expect(isBlockedIP('172.16.0.1')).toBe(true);
      expect(isBlockedIP('172.31.255.255')).toBe(true);
      expect(isBlockedIP('192.168.1.1')).toBe(true);
      expect(isBlockedIP('192.168.0.254')).toBe(true);
    });

    it('blocks AWS/cloud metadata link-local address (169.254.169.254)', () => {
      expect(isBlockedIP('169.254.169.254')).toBe(true);
      expect(isBlockedIP('169.254.0.1')).toBe(true);
    });

    it('blocks IPv6 loopback (::1)', () => {
      expect(isBlockedIP('::1')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 addresses for private ranges', () => {
      expect(isBlockedIP('::ffff:127.0.0.1')).toBe(true);
      expect(isBlockedIP('::ffff:10.0.0.1')).toBe(true);
      expect(isBlockedIP('::ffff:192.168.1.1')).toBe(true);
    });

    it('allows legitimate public IP addresses', () => {
      expect(isBlockedIP('8.8.8.8')).toBe(false);
      expect(isBlockedIP('1.1.1.1')).toBe(false);
      expect(isBlockedIP('93.184.216.34')).toBe(false); // example.com
    });
  });

  describe('validateNoSSRF', () => {
    beforeEach(() => {
      delete process.env.DISABLE_SSRF_CHECK;
    });

    it('rejects localhost explicitly', async () => {
      await expect(validateNoSSRF('http://localhost:3000/webhook')).rejects.toThrow(
        /loopback/i
      );
      await expect(validateNoSSRF('http://localhost.localdomain/receive')).rejects.toThrow(
        /loopback/i
      );
    });

    it('rejects raw private IP URLs', async () => {
      await expect(validateNoSSRF('http://127.0.0.1:8080/hook')).rejects.toThrow(/blocked/i);
      await expect(validateNoSSRF('http://192.168.1.100/webhook')).rejects.toThrow(/blocked/i);
      await expect(validateNoSSRF('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
        /blocked/i
      );
    });

    it('rejects invalid or unsupported protocol URLs', async () => {
      await expect(validateNoSSRF('ftp://example.com/file')).rejects.toThrow(/HTTP or HTTPS/i);
      await expect(validateNoSSRF('not-a-valid-url')).rejects.toThrow(/Invalid URL/i);
    });

    it('allows bypass when DISABLE_SSRF_CHECK is set to true', async () => {
      process.env.DISABLE_SSRF_CHECK = 'true';
      await expect(validateNoSSRF('http://localhost:4000/receive')).resolves.toBeUndefined();
      await expect(validateNoSSRF('http://127.0.0.1:4000/receive')).resolves.toBeUndefined();
    });
  });
});
