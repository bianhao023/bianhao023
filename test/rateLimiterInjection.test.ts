import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { RateLimiter, RateLimiterLike, RateLimitDecision } from '../src/api/rateLimiter';

const baseConfig: AppConfig = {
  port: 0,
  orderTtlMinutes: 15,
  enabledMethods: [],
  expiryReminderDays: 3,
  processedEventTtlDays: 7,
  shutdownTimeoutMs: 10000,
  rateLimit: { enabled: true, max: 100, windowMs: 60_000 },
  security: { corsOrigins: ['*'], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
};

/** A sentinel limiter so we can assert the container used the injected one. */
class SentinelLimiter implements RateLimiterLike {
  calls = 0;
  check(): RateLimitDecision {
    this.calls++;
    return { allowed: true, limit: 100, remaining: 99, resetAt: 0, retryAfterSec: 1 };
  }
}

test('injected rateLimiter replaces the in-process limiter', () => {
  const limiter = new SentinelLimiter();
  const container = buildContainer(baseConfig, { rateLimiter: limiter });
  assert.equal(container.rateLimit?.limiter, limiter);
});

test('without injection, the in-process RateLimiter is used when enabled', () => {
  const container = buildContainer(baseConfig);
  assert.ok(container.rateLimit, 'rate limiting should be enabled');
  assert.ok(container.rateLimit!.limiter instanceof RateLimiter);
});

test('rate limiting disabled -> no limiter wired', () => {
  const container = buildContainer({ ...baseConfig, rateLimit: { enabled: false, max: 100, windowMs: 60_000 } });
  assert.equal(container.rateLimit, undefined);
});
