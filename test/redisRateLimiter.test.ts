import test from 'node:test';
import assert from 'node:assert/strict';

import { RedisRateLimiter, type RedisLike } from '../src/api/redisRateLimiter';

interface Entry {
  value: number;
  /** Epoch millis when the entry expires, or undefined for no expiry. */
  expireAt?: number;
}

/**
 * In-memory RedisLike backed by a Map, using an injected clock so tests can
 * control time deterministically.
 */
class FakeRedis implements RedisLike {
  private store = new Map<string, Entry>();

  constructor(private readonly now: () => number) {}

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expireAt !== undefined && e.expireAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async incr(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) {
      const created: Entry = { value: 1 };
      this.store.set(key, created);
      return 1;
    }
    e.value += 1;
    return e.value;
  }

  async pexpire(key: string, ms: number): Promise<unknown> {
    const e = this.live(key);
    if (!e) return 0;
    e.expireAt = this.now() + ms;
    return 1;
  }

  async pttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2; // missing
    if (e.expireAt === undefined) return -1; // no expiry
    return e.expireAt - this.now();
  }
}

const MAX = 3;
const WINDOW = 60_000;

test('allows up to max, then denies the next check', async () => {
  let now = 1_000_000;
  const redis = new FakeRedis(() => now);
  const limiter = new RedisRateLimiter(redis, MAX, WINDOW, () => now);

  for (let i = 0; i < MAX; i++) {
    const d = await limiter.check('ip-a');
    assert.equal(d.allowed, true, `request ${i + 1} should be allowed`);
    assert.equal(d.limit, MAX);
  }

  const denied = await limiter.check('ip-a');
  assert.equal(denied.allowed, false);
  assert.equal(denied.limit, MAX);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterSec >= 1);
  assert.ok(denied.resetAt > now);
});

test('a new window allows again after the clock advances past windowMs', async () => {
  let now = 2_000_000;
  const redis = new FakeRedis(() => now);
  const limiter = new RedisRateLimiter(redis, MAX, WINDOW, () => now);

  for (let i = 0; i < MAX; i++) {
    await limiter.check('ip-b');
  }
  assert.equal((await limiter.check('ip-b')).allowed, false);

  now += WINDOW; // roll into the next fixed window
  const fresh = await limiter.check('ip-b');
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.remaining, MAX - 1);
  assert.equal(fresh.limit, MAX);
});

test('different keys have independent budgets', async () => {
  let now = 3_000_000;
  const redis = new FakeRedis(() => now);
  const limiter = new RedisRateLimiter(redis, MAX, WINDOW, () => now);

  // Exhaust key one.
  for (let i = 0; i < MAX; i++) {
    await limiter.check('ip-c');
  }
  assert.equal((await limiter.check('ip-c')).allowed, false);

  // A different key is unaffected.
  const other = await limiter.check('ip-d');
  assert.equal(other.allowed, true);
  assert.equal(other.remaining, MAX - 1);
});
