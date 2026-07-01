import type { RateLimitDecision, RateLimiterLike } from './rateLimiter';

/**
 * Minimal subset of a Redis client this limiter needs. Compatible with both
 * `node-redis` and `ioredis` — the concrete client is injected, so this module
 * adds no hard dependency on any redis package (mirrors how the SQL adapter
 * depends on an injected client interface).
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

/**
 * A distributed, Redis-backed fixed-window rate limiter that is a drop-in for
 * the in-process `RateLimiter` (both implement `RateLimiterLike`).
 *
 * Each key gets `max` requests per `windowMs`. The window is derived from the
 * clock (`rl:{key}:{floor(now/windowMs)}`) so buckets roll over and expire on
 * their own — no sweeping needed. Counting is a single atomic `INCR`, with a
 * `PEXPIRE` set once when the bucket is first created.
 *
 * Wiring a real client (node-redis v4):
 *
 *   const limiter = new RedisRateLimiter(
 *     {
 *       incr: (k) => client.incr(k),
 *       pexpire: (k, ms) => client.pExpire(k, ms),
 *       pttl: (k) => client.pTTL(k),
 *     },
 *     100,
 *     60_000,
 *   );
 *
 * (For ioredis the method names already match: pass the client's `incr`,
 * `pexpire`, and `pttl` bound to the client.)
 */
export class RedisRateLimiter implements RateLimiterLike {
  constructor(
    private readonly redis: RedisLike,
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const bucket = Math.floor(this.now() / this.windowMs);
    const bucketKey = `rl:${key}:${bucket}`;

    const count = await this.redis.incr(bucketKey);
    if (count === 1) {
      await this.redis.pexpire(bucketKey, this.windowMs);
    }

    let ttl = await this.redis.pttl(bucketKey);
    if (ttl < 0) {
      // Missing TTL (key with no expiry set, or lost the race): treat the full
      // window as remaining and best-effort re-apply the expiry.
      ttl = this.windowMs;
      await this.redis.pexpire(bucketKey, this.windowMs);
    }

    const allowed = count <= this.max;
    const remaining = Math.max(0, this.max - count);
    return {
      allowed,
      limit: this.max,
      remaining,
      resetAt: this.now() + ttl,
      retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)),
    };
  }
}
