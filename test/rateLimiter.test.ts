import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/api/rateLimiter';

test('allows up to the limit, then blocks within the window', () => {
  const clock = { v: 1000 };
  const rl = new RateLimiter(3, 60_000, () => clock.v);
  assert.equal(rl.check('k').allowed, true);
  assert.equal(rl.check('k').allowed, true);
  const third = rl.check('k');
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const fourth = rl.check('k');
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.limit, 3);
  assert.ok(fourth.retryAfterSec >= 1);
});

test('separate keys have independent budgets', () => {
  const rl = new RateLimiter(1, 60_000, () => 0);
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('b').allowed, true);
  assert.equal(rl.check('a').allowed, false);
});

test('window resets after windowMs', () => {
  const clock = { v: 0 };
  const rl = new RateLimiter(1, 1000, () => clock.v);
  assert.equal(rl.check('k').allowed, true);
  assert.equal(rl.check('k').allowed, false);
  clock.v = 1001; // window elapsed
  assert.equal(rl.check('k').allowed, true);
});

test('sweep drops expired windows', () => {
  const clock = { v: 0 };
  const rl = new RateLimiter(1, 1000, () => clock.v);
  rl.check('k');
  clock.v = 2000;
  rl.sweep(); // should not throw and should free memory
  assert.equal(rl.check('k').allowed, true); // fresh window
});
