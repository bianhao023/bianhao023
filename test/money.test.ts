import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits, fromMinorUnits } from '../src/core/money';
import { ValidationError } from '../src/domain/errors';

test('CNY converts to fen', () => {
  assert.equal(toMinorUnits('15.00', 'CNY'), 1500);
  assert.equal(toMinorUnits('0.01', 'CNY'), 1);
  assert.equal(toMinorUnits('128', 'CNY'), 12800);
  assert.equal(toMinorUnits(39.9, 'CNY'), 3990);
});

test('USDT converts to micro units (6 decimals)', () => {
  assert.equal(toMinorUnits('2', 'USDT'), 2_000_000);
  assert.equal(toMinorUnits('5.5', 'USDT'), 5_500_000);
  assert.equal(toMinorUnits('0.000001', 'USDT'), 1);
});

test('formatting round-trips', () => {
  assert.equal(fromMinorUnits(1500, 'CNY'), '15.00');
  assert.equal(fromMinorUnits(1, 'CNY'), '0.01');
  assert.equal(fromMinorUnits(2_000_001, 'USDT'), '2.000001');
});

test('rejects excessive precision and bad input', () => {
  assert.throws(() => toMinorUnits('1.001', 'CNY'), ValidationError);
  assert.throws(() => toMinorUnits('1.0000001', 'USDT'), ValidationError);
  assert.throws(() => toMinorUnits('abc', 'CNY'), ValidationError);
  assert.throws(() => toMinorUnits('-1', 'CNY'), ValidationError);
});

test('no floating point drift on tricky values', () => {
  // 0.1 + 0.2 style values that break naive float math.
  assert.equal(toMinorUnits('0.30', 'CNY'), 30);
  assert.equal(toMinorUnits('19.99', 'CNY'), 1999);
});
