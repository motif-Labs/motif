import { describe, expect, it } from 'vitest';
import { confidence, freshness } from '@motif/server';

const base = { status: 'current', verification: 'unverified', stale: 0, support: 1 };
const fresh = new Date().toISOString();

describe('confidence, one trust number every surface agrees on', () => {
  it('rises with a human vouch and with corroboration', () => {
    const plain = confidence({ ...base, createdAt: fresh });
    const vouched = confidence({ ...base, verification: 'verified', createdAt: fresh });
    const corroborated = confidence({ ...base, support: 4, createdAt: fresh });
    expect(vouched).toBeGreaterThan(plain);
    expect(corroborated).toBeGreaterThan(plain);
  });

  it('falls with conflict, dispute and staleness', () => {
    const plain = confidence({ ...base, createdAt: fresh });
    expect(confidence({ ...base, status: 'conflicted', createdAt: fresh })).toBeLessThan(plain);
    expect(confidence({ ...base, verification: 'disputed', createdAt: fresh })).toBeLessThan(plain);
    expect(confidence({ ...base, stale: 1, createdAt: fresh })).toBeLessThan(plain);
  });

  it('tempers with age but never zeroes, old knowledge is less certain, not wrong', () => {
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    const c = confidence({ ...base, createdAt: old });
    expect(c).toBeGreaterThan(0.05);
    expect(c).toBeLessThan(confidence({ ...base, createdAt: fresh }));
    expect(freshness(old)).toBeLessThan(freshness(fresh));
  });

  it('stays within [0.05, 1]', () => {
    const hi = confidence({
      status: 'current',
      verification: 'verified',
      stale: 0,
      support: 20,
      createdAt: fresh,
    });
    const lo = confidence({
      status: 'conflicted',
      verification: 'disputed',
      stale: 1,
      support: 1,
      createdAt: fresh,
    });
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(0.05);
  });
});
