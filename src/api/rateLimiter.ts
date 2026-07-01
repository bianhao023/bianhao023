/**
 * A dependency-free fixed-window rate limiter. Each key (typically clientIp +
 * route) gets `max` requests per `windowMs`. Simple, memory-bounded (stale
 * windows are lazily dropped), and adequate for single-process deployments; for
 * a cluster, back it with Redis behind the same interface.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** The configured max requests per window. */
  limit: number;
  remaining: number;
  /** Epoch millis when the current window resets. */
  resetAt: number;
  /** Seconds until reset (for the Retry-After header). */
  retryAfterSec: number;
}

/** The contract the router depends on; swap in a Redis-backed implementation. */
export interface RateLimiterLike {
  check(key: string): RateLimitDecision | Promise<RateLimitDecision>;
  sweep?(): void;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter implements RateLimiterLike {
  private windows = new Map<string, Window>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitDecision {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    const allowed = w.count <= this.max;
    const remaining = Math.max(0, this.max - w.count);
    return {
      allowed,
      limit: this.max,
      remaining,
      resetAt: w.resetAt,
      retryAfterSec: Math.max(1, Math.ceil((w.resetAt - t) / 1000)),
    };
  }

  /** Drop windows that have expired (call periodically to bound memory). */
  sweep(): void {
    const t = this.now();
    for (const [key, w] of this.windows) {
      if (w.resetAt <= t) this.windows.delete(key);
    }
  }
}
