import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toCsv,
  ordersToCsv,
  refundsToCsv,
  ORDER_COLUMNS,
  REFUND_COLUMNS,
} from '../src/reporting/csv';
import { Order, OrderStatus } from '../src/domain/types';
import { Refund, RefundStatus } from '../src/domain/refund';

test('toCsv emits CRLF header and trailing CRLF for plain values', () => {
  const out = toCsv([{ a: 'x', b: 'y' }], ['a', 'b']);
  assert.equal(out, 'a,b\r\nx,y\r\n');
});

test('toCsv with empty rows yields header-only', () => {
  const out = toCsv([], ['a', 'b']);
  assert.equal(out, 'a,b\r\n');
});

test('toCsv escapes commas', () => {
  const out = toCsv([{ a: 'hello, world' }], ['a']);
  assert.equal(out, 'a\r\n"hello, world"\r\n');
});

test('toCsv escapes embedded double quotes by doubling them', () => {
  const out = toCsv([{ a: 'say "hi"' }], ['a']);
  assert.equal(out, 'a\r\n"say ""hi"""\r\n');
});

test('toCsv escapes newlines (CR and LF)', () => {
  const lf = toCsv([{ a: 'line1\nline2' }], ['a']);
  assert.equal(lf, 'a\r\n"line1\nline2"\r\n');
  const cr = toCsv([{ a: 'line1\rline2' }], ['a']);
  assert.equal(cr, 'a\r\n"line1\rline2"\r\n');
});

test('toCsv leaves plain values unquoted', () => {
  const out = toCsv([{ a: 'plain', b: '123' }], ['a', 'b']);
  assert.equal(out, 'a,b\r\nplain,123\r\n');
});

test('toCsv renders null and undefined as empty cells', () => {
  const out = toCsv([{ a: null, b: undefined, c: 'x' }], ['a', 'b', 'c']);
  assert.equal(out, 'a,b,c\r\n,,x\r\n');
});

test('toCsv missing column key renders as empty cell', () => {
  const out = toCsv([{ a: 'x' }], ['a', 'missing']);
  assert.equal(out, 'a,missing\r\nx,\r\n');
});

test('toCsv renders object values as JSON strings', () => {
  const out = toCsv([{ a: { k: 1, v: 'z' } }], ['a']);
  // JSON contains a comma so it must be quoted.
  assert.equal(out, 'a\r\n"{""k"":1,""v"":""z""}"\r\n');
});

test('toCsv renders array values as JSON strings', () => {
  const out = toCsv([{ a: [1, 2, 3] }], ['a']);
  assert.equal(out, 'a\r\n"[1,2,3]"\r\n');
});

function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord_1',
    outTradeNo: 'OTN-001',
    userId: 'user_1',
    planId: 'plan_1',
    method: 'wechat',
    currency: 'CNY',
    amount: 1990,
    status: OrderStatus.PAID,
    createdAt: 1000,
    updatedAt: 2000,
    expiresAt: 3000,
    paidAt: 1500,
    refundedAmount: 500,
    metadata: {},
    ...overrides,
  };
}

test('ordersToCsv header equals ORDER_COLUMNS joined by commas', () => {
  const out = ordersToCsv([]);
  assert.equal(out, ORDER_COLUMNS.join(',') + '\r\n');
});

test('ordersToCsv row places id/amount/status in the right columns', () => {
  const out = ordersToCsv([sampleOrder()]);
  const lines = out.split('\r\n');
  assert.equal(lines[0], ORDER_COLUMNS.join(','));
  const header = lines[0].split(',');
  const cells = lines[1].split(',');
  assert.equal(cells[header.indexOf('id')], 'ord_1');
  assert.equal(cells[header.indexOf('amount')], '1990');
  assert.equal(cells[header.indexOf('status')], 'PAID');
  assert.equal(cells[header.indexOf('refundedAmount')], '500');
});

test('ordersToCsv renders missing refundedAmount as 0', () => {
  const order = sampleOrder({ refundedAmount: undefined });
  const out = ordersToCsv([order]);
  const lines = out.split('\r\n');
  const header = lines[0].split(',');
  const cells = lines[1].split(',');
  assert.equal(cells[header.indexOf('refundedAmount')], '0');
});

function sampleRefund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: 'ref_1',
    orderId: 'ord_1',
    outRefundNo: 'ORN-001',
    amount: 500,
    currency: 'CNY',
    status: RefundStatus.SUCCESS,
    providerRefundId: 'prov_ref_1',
    rawStatus: 'SUCCESS',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

test('refundsToCsv header + sample refund row', () => {
  const out = refundsToCsv([sampleRefund()]);
  const lines = out.split('\r\n');
  assert.equal(lines[0], REFUND_COLUMNS.join(','));
  const header = lines[0].split(',');
  const cells = lines[1].split(',');
  assert.equal(cells[header.indexOf('id')], 'ref_1');
  assert.equal(cells[header.indexOf('orderId')], 'ord_1');
  assert.equal(cells[header.indexOf('amount')], '500');
  assert.equal(cells[header.indexOf('status')], 'SUCCESS');
  assert.equal(cells[header.indexOf('providerRefundId')], 'prov_ref_1');
});
