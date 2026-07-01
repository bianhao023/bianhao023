import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  StaticExchangeRateProvider,
  demoProvider,
} from '../src/pricing/exchangeRates';
import {
  DECIMALS,
  decimalsOf,
  convertMinor,
  formatMinor,
  PricingService,
} from '../src/pricing/pricingService';

// --- StaticExchangeRateProvider ---------------------------------------------

test('rate(x, x) === 1', () => {
  const p = new StaticExchangeRateProvider('CNY', { USD: 1 / 7.2, EUR: 1 / 7.8 });
  assert.equal(p.rate('CNY', 'CNY'), 1);
  assert.equal(p.rate('USD', 'USD'), 1);
});

test('cross rate is derived via the base', () => {
  // base CNY; USD = 1/7.2 per CNY, EUR = 1/7.8 per CNY.
  const p = new StaticExchangeRateProvider('CNY', {
    CNY: 1,
    USD: 1 / 7.2,
    EUR: 1 / 7.8,
  });
  // rate(USD, EUR) = ratesFromBase[EUR] / ratesFromBase[USD] = (1/7.8)/(1/7.2) = 7.2/7.8
  const expected = 7.2 / 7.8;
  assert.ok(Math.abs(p.rate('USD', 'EUR') - expected) < 1e-9);
  // And the round trip multiplies back to ~1.
  assert.ok(Math.abs(p.rate('USD', 'EUR') * p.rate('EUR', 'USD') - 1) < 1e-9);
});

test('base defaults to 1 when omitted', () => {
  const p = new StaticExchangeRateProvider('CNY', { USD: 1 / 7.2 });
  // rate(CNY, USD) = ratesFromBase[USD] / ratesFromBase[CNY] = (1/7.2)/1
  assert.ok(Math.abs(p.rate('CNY', 'USD') - 1 / 7.2) < 1e-12);
});

test('unknown currency throws', () => {
  const p = new StaticExchangeRateProvider('CNY', { USD: 1 / 7.2 });
  assert.throws(() => p.rate('CNY', 'JPY'), /unknown currency/);
  assert.throws(() => p.rate('JPY', 'CNY'), /unknown currency/);
  assert.throws(() => p.rate('JPY', 'JPY'), /unknown currency/);
});

test('constructor rejects non-positive rates', () => {
  assert.throws(() => new StaticExchangeRateProvider('CNY', { USD: 0 }), /invalid rate/);
  assert.throws(() => new StaticExchangeRateProvider('CNY', { USD: -1 }), /invalid rate/);
});

// --- decimalsOf -------------------------------------------------------------

test('decimalsOf returns configured decimals and throws on unknown', () => {
  assert.equal(decimalsOf('CNY'), 2);
  assert.equal(decimalsOf('USDT'), 6);
  assert.equal(DECIMALS.USD, 2);
  assert.throws(() => decimalsOf('JPY'), /unknown currency/);
});

// --- convertMinor -----------------------------------------------------------

test('same-currency conversion is identity at rate 1', () => {
  assert.equal(convertMinor(123456, 'USDT', 'USDT', 1), 123456);
  assert.equal(convertMinor(100_00, 'CNY', 'CNY', 1), 100_00);
});

test('conversion across different decimals: 100.00 CNY -> USDT', () => {
  // 100.00 CNY = 10000 fen (2 decimals). Pick rate = 0.14 USDT per CNY.
  // major USDT = 100.00 * 0.14 = 14.00 USDT.
  // USDT has 6 decimals -> 14.000000 USDT = 14_000_000 micro.
  //
  // Formula check:
  //   minorTo = minorFrom * rate * 10^(6-2)
  //           = 10000 * 0.14 * 10000 = 14_000_000
  const rate = 0.14;
  assert.equal(convertMinor(10000, 'CNY', 'USDT', rate), 14_000_000);
});

test('half-up rounding boundary', () => {
  // Same decimals so scale = 1; result minor = round(amountMinor * rate).
  // amountMinor = 1, rate = 0.5  -> 0.5 -> rounds up to 1 (half-up / away from zero).
  assert.equal(convertMinor(1, 'CNY', 'CNY', 0.5), 1);
  // amountMinor = 1, rate = 0.49 -> 0.49 -> rounds to 0.
  assert.equal(convertMinor(1, 'CNY', 'CNY', 0.49), 0);
  // amountMinor = 3, rate = 0.5 -> 1.5 -> rounds up to 2.
  assert.equal(convertMinor(3, 'CNY', 'CNY', 0.5), 2);
});

test('convertMinor rejects negative and non-integer input', () => {
  assert.throws(() => convertMinor(-1, 'CNY', 'USDT', 1), /non-negative integer/);
  assert.throws(() => convertMinor(1.5, 'CNY', 'USDT', 1), /non-negative integer/);
  assert.throws(() => convertMinor(100, 'CNY', 'USDT', -1), /non-negative finite/);
});

// --- formatMinor ------------------------------------------------------------

test('formatMinor renders with the given decimals', () => {
  assert.equal(formatMinor(14_000_000, 6), '14.000000');
  assert.equal(formatMinor(1234, 2), '12.34');
  assert.equal(formatMinor(5, 2), '0.05');
  assert.equal(formatMinor(42, 0), '42');
});

// --- PricingService.quote ---------------------------------------------------

test('PricingService.quote returns integer minor, display string, and echoes rate', () => {
  const provider = new StaticExchangeRateProvider('CNY', { CNY: 1, USDT: 0.14 });
  const svc = new PricingService(provider);

  const q = svc.quote(10000, 'CNY', 'USDT'); // 100.00 CNY -> USDT
  assert.equal(q.currency, 'USDT');
  assert.equal(q.rate, 0.14);
  assert.ok(Number.isInteger(q.amountMinor));
  assert.equal(q.amountMinor, 14_000_000);
  assert.equal(q.amountDisplay, '14.000000');
});

test('PricingService.quote same-currency round-trips exactly', () => {
  const svc = new PricingService(demoProvider);
  const q = svc.quote(9999, 'CNY', 'CNY');
  assert.equal(q.amountMinor, 9999);
  assert.equal(q.rate, 1);
  assert.equal(q.amountDisplay, '99.99');
});
