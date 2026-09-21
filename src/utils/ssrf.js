const dns = require('dns').promises;
const net = require('net');

/**
 * List of private/reserved CIDR ranges that should not be reachable
 * via outbound webhook deliveries (SSRF protection).
 *
 * Each entry is { networkInt, maskInt, bits } (see parseCIDR).
 */
const BLOCKED_CIDRS = [
  // IPv4 loopback
  '127.0.0.0/8',
  // IPv4 private ranges
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // IPv4 link-local (includes AWS metadata 169.254.169.254)
  '169.254.0.0/16',
  // IPv4 this-network
  '0.0.0.0/8',
  // IPv4 broadcast
  '255.255.255.255/32',
  // IPv4 documentation ranges
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
].map(parseCIDR);

const BLOCKED_IPV6_CIDRS = [
  // IPv6 loopback
  '::1/128',
  // IPv6 link-local
  'fe80::/10',
  // IPv6 unique local
  'fc00::/7',
  // IPv6 unspecified
  '::/128',
  // IPv4-mapped IPv6 addresses (::ffff:0:0/96 covers all IPv4-mapped)
  '::ffff:0:0/96',
].map(parseIPv6CIDR);

/**
 * Parse an IPv4 CIDR string into { network, mask, bits }.
 */
function parseCIDR(cidr) {
  const [ip, bits] = cidr.split('/');
  const numBits = Number(bits);
  const networkInt = ipToInt(ip);
  const maskInt = numBits === 0 ? 0 : numBits === 32 ? 0xffffffff : ((0xffffffff << (32 - numBits)) >>> 0);
  return {
    networkInt: (networkInt & maskInt) >>> 0,
    maskInt: maskInt >>> 0,
    bits: numBits,
  };
}

/**
 * Convert a dotted-decimal IPv4 address to an unsigned 32-bit integer.
 */
function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc * 256 + Number(octet)) >>> 0), 0);
}

/**
 * Check if an IPv4 address is within a parsed CIDR block.
 */
function ipv4InCIDR(ipStr, { networkInt, maskInt }) {
  const ipInt = ipToInt(ipStr);
  return ((ipInt & maskInt) >>> 0) === networkInt;
}

/**
 * Parse an IPv6 CIDR — very simplified: stores prefix as hex for prefix matching.
 */
function parseIPv6CIDR(cidr) {
  const [prefix, bits] = cidr.split('/');
  return { prefix, bits: Number(bits) };
}

/**
 * Expand a compact IPv6 address to its full 128-bit representation.
 */
function expandIPv6(ip) {
  // Handle IPv4-mapped: ::ffff:a.b.c.d
  if (ip.includes('.')) {
    const parts = ip.split(':');
    const ipv4 = parts.pop();
    const expanded = ipv4
      .split('.')
      .map((n) => Number(n).toString(16).padStart(2, '0'));
    const hex = `${expanded[0]}${expanded[1]}:${expanded[2]}${expanded[3]}`;
    parts.push(hex);
    ip = parts.join(':');
  }

  // Expand ::
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle = Array(missing).fill('0000');
    const all = [...leftParts, ...middle, ...rightParts];
    ip = all.join(':');
  }

  return ip
    .split(':')
    .map((p) => p.padStart(4, '0'))
    .join(':');
}

/**
 * Check if an IPv6 address falls within a parsed CIDR.
 */
function ipv6InCIDR(ipStr, { prefix, bits }) {
  try {
    const expanded = expandIPv6(ipStr);
    const expandedPrefix = expandIPv6(prefix);

    // Compare bit by bit up to `bits` prefix length
    const ipHex = expanded.replace(/:/g, '');
    const prefixHex = expandedPrefix.replace(/:/g, '');

    const fullBytes = Math.floor(bits / 4); // hex chars
    if (ipHex.substring(0, fullBytes) !== prefixHex.substring(0, fullBytes)) {
      return false;
    }

    const remainingBits = bits % 4;
    if (remainingBits > 0) {
      const ipNibble = parseInt(ipHex[fullBytes], 16);
      const prefixNibble = parseInt(prefixHex[fullBytes], 16);
      const mask = 0xf & (0xf0 >> remainingBits);
      if ((ipNibble & mask) !== (prefixNibble & mask)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an IP address (v4 or v6) is in any blocked range.
 *
 * @param {string} ip
 * @returns {boolean} true if the IP is blocked
 */
function isBlockedIP(ip) {
  if (net.isIPv4(ip)) {
    return BLOCKED_CIDRS.some((cidr) => ipv4InCIDR(ip, cidr));
  }

  if (net.isIPv6(ip)) {
    // Check native IPv6 blocks
    if (BLOCKED_IPV6_CIDRS.some((cidr) => ipv6InCIDR(ip, cidr))) {
      return true;
    }
    // Extract embedded IPv4 from IPv4-mapped IPv6 (::ffff:192.168.1.1)
    const v4mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4mapped) {
      return BLOCKED_CIDRS.some((cidr) => ipv4InCIDR(v4mapped[1], cidr));
    }
  }

  return false;
}

/**
 * Validate a URL against SSRF risks.
 *
 * Steps:
 * 1. Parse the URL
 * 2. Enforce protocol (http/https, https-only in production)
 * 3. Resolve DNS (including CNAME chains)
 * 4. Check every resolved IP against the blocked CIDR list
 *
 * @param {string} url  The subscriber URL to validate
 * @returns {Promise<void>}  Throws if the URL is blocked or invalid
 */
async function validateNoSSRF(url) {
  // Allow bypass in development/test for mock subscribers
  if (process.env.DISABLE_SSRF_CHECK === 'true') {
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  const { protocol, hostname, port } = parsed;

  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('URL must use HTTP or HTTPS protocol');
  }

  if (protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('URL must use HTTPS in production');
  }

  // Check if hostname is already a raw IP address (skip DNS)
  if (net.isIP(hostname)) {
    if (isBlockedIP(hostname)) {
      throw new Error(`URL resolves to a blocked/private IP address: ${hostname}`);
    }
    return;
  }

  // Block obvious hostname variants regardless of DNS
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === 'localhost.localdomain'
  ) {
    throw new Error(`URL hostname "${hostname}" resolves to a loopback address`);
  }

  // DNS resolution — resolve ALL addresses and check each one
  let addresses;
  try {
    // resolve4 + resolve6 for comprehensive coverage
    const [v4Results, v6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    addresses = [];
    if (v4Results.status === 'fulfilled') addresses.push(...v4Results.value);
    if (v6Results.status === 'fulfilled') addresses.push(...v6Results.value);

    if (addresses.length === 0) {
      throw new Error(`Could not resolve hostname: ${hostname}`);
    }
  } catch (err) {
    if (err.message.startsWith('Could not resolve')) throw err;
    throw new Error(`DNS resolution failed for hostname "${hostname}": ${err.message}`);
  }

  for (const addr of addresses) {
    if (isBlockedIP(addr)) {
      throw new Error(
        `URL hostname "${hostname}" resolves to a blocked/private IP address: ${addr}`
      );
    }
  }
}

module.exports = { validateNoSSRF, isBlockedIP };
