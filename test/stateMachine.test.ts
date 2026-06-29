import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderStatus } from '../src/domain/types';
import {
  assertTransition,
  canTransition,
  isTerminal,
} from '../src/core/orderStateMachine';
import { InvalidStateError } from '../src/domain/errors';

test('valid transitions are allowed', () => {
  assert.ok(canTransition(OrderStatus.PENDING, OrderStatus.PAID));
  assert.ok(canTransition(OrderStatus.PAID, OrderStatus.FULFILLED));
  assert.ok(canTransition(OrderStatus.PENDING, OrderStatus.EXPIRED));
  assert.ok(canTransition(OrderStatus.FULFILLED, OrderStatus.REFUNDED));
});

test('invalid transitions are rejected', () => {
  assert.ok(!canTransition(OrderStatus.PENDING, OrderStatus.FULFILLED));
  assert.ok(!canTransition(OrderStatus.EXPIRED, OrderStatus.PAID));
  assert.throws(() => assertTransition(OrderStatus.EXPIRED, OrderStatus.PAID), InvalidStateError);
  assert.throws(() => assertTransition(OrderStatus.FULFILLED, OrderStatus.PENDING), InvalidStateError);
});

test('same-state transition is an idempotent no-op', () => {
  assert.equal(assertTransition(OrderStatus.PAID, OrderStatus.PAID), OrderStatus.PAID);
  assert.equal(assertTransition(OrderStatus.FULFILLED, OrderStatus.FULFILLED), OrderStatus.FULFILLED);
});

test('terminal states are detected', () => {
  assert.ok(isTerminal(OrderStatus.EXPIRED));
  assert.ok(isTerminal(OrderStatus.CANCELLED));
  assert.ok(isTerminal(OrderStatus.REFUNDED));
  assert.ok(isTerminal(OrderStatus.FAILED));
  assert.ok(!isTerminal(OrderStatus.PENDING));
  assert.ok(!isTerminal(OrderStatus.PAID));
});
