import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundRobin } from '../src/providers/usdt/roundRobin';

test('rotates through the pool and wraps around', () => {
  const rr = new RoundRobin(['a', 'b', 'c']);
  assert.deepEqual([rr.next(), rr.next(), rr.next(), rr.next(), rr.next()], ['a', 'b', 'c', 'a', 'b']);
  assert.equal(rr.size, 3);
});

test('a single-item pool always returns the same item', () => {
  const rr = new RoundRobin(['only']);
  assert.deepEqual([rr.next(), rr.next(), rr.next()], ['only', 'only', 'only']);
});

test('empty pool is rejected', () => {
  assert.throws(() => new RoundRobin([]), /non-empty/);
});

test('all() exposes every item without advancing the cursor', () => {
  const rr = new RoundRobin([1, 2]);
  assert.deepEqual([...rr.all()], [1, 2]);
  assert.equal(rr.next(), 1); // cursor untouched by all()
});
