const mockRedisStore = new Map();

jest.mock('../config/redis', () => ({
  get: jest.fn(async (key) => mockRedisStore.get(key) || null),
  mget: jest.fn(async (...keys) => keys.map((k) => mockRedisStore.get(k) || null)),
  set: jest.fn(async (key, val) => {
    mockRedisStore.set(key, String(val));
    return 'OK';
  }),
  mset: jest.fn(async (...args) => {
    for (let i = 0; i < args.length; i += 2) {
      mockRedisStore.set(args[i], String(args[i + 1]));
    }
    return 'OK';
  }),
  incr: jest.fn(async (key) => {
    const current = Number(mockRedisStore.get(key)) || 0;
    const next = current + 1;
    mockRedisStore.set(key, String(next));
    return next;
  }),
  del: jest.fn(async (...keys) => {
    let deleted = 0;
    keys.forEach((k) => {
      if (mockRedisStore.delete(k)) deleted++;
    });
    return deleted;
  }),
  on: jest.fn(),
}));

jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  getCircuitState,
  recordFailure,
  recordSuccess,
  resetCircuit,
  FAILURE_THRESHOLD,
  COOLDOWN_MS,
} = require('../utils/circuitBreaker');

describe('Per-Subscriber Circuit Breaker', () => {
  const SUB_ID = 'sub-test-123';

  beforeEach(async () => {
    mockRedisStore.clear();
    await resetCircuit(SUB_ID);
  });

  it('starts in closed state with zero failures', async () => {
    const state = await getCircuitState(SUB_ID);
    expect(state.state).toBe('closed');
    expect(state.remainingCooldownMs).toBe(0);
  });

  it('records failures incrementally without opening until threshold is reached', async () => {
    for (let i = 1; i < FAILURE_THRESHOLD; i++) {
      const res = await recordFailure(SUB_ID);
      expect(res.opened).toBe(false);
      expect(res.failures).toBe(i);
    }

    const state = await getCircuitState(SUB_ID);
    expect(state.state).toBe('closed');
  });

  it('opens the circuit when failure threshold is reached', async () => {
    for (let i = 1; i < FAILURE_THRESHOLD; i++) {
      await recordFailure(SUB_ID);
    }

    const res = await recordFailure(SUB_ID);
    expect(res.opened).toBe(true);

    const state = await getCircuitState(SUB_ID);
    expect(state.state).toBe('open');
    expect(state.remainingCooldownMs).toBeGreaterThan(0);
  });

  it('transitions to half-open after cooldown period has elapsed', async () => {
    // Force circuit open with timestamp in the past
    mockRedisStore.set(`cb:${SUB_ID}:state`, 'open');
    mockRedisStore.set(`cb:${SUB_ID}:openedAt`, String(Date.now() - (COOLDOWN_MS + 1000)));

    const state = await getCircuitState(SUB_ID);
    expect(state.state).toBe('half-open');
    expect(state.remainingCooldownMs).toBe(0);
  });

  it('resets and closes circuit on delivery success', async () => {
    // Open circuit
    mockRedisStore.set(`cb:${SUB_ID}:state`, 'open');
    mockRedisStore.set(`cb:${SUB_ID}:failures`, '5');

    const { wasOpen } = await recordSuccess(SUB_ID);
    expect(wasOpen).toBe(true);

    const state = await getCircuitState(SUB_ID);
    expect(state.state).toBe('closed');
    expect(mockRedisStore.has(`cb:${SUB_ID}:failures`)).toBe(false);
  });
});
