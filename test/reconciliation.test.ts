import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryOrderRepository, MemoryRefundRepository } from '../src/storage/memoryStore';
import { ReconciliationService } from '../src/services/reconciliationService';
import { Order, OrderStatus } from '../src/domain/types';
import { Refund, RefundStatus } from '../src/domain/refund';

const NOW = Date.UTC(2026, 0, 10);

function order(over: Partial<Order> & { id: string }): Order {
  return {
    outTradeNo: `T-${over.id}`, userId: 'u', planId: 'monthly', method: 'wechat', currency: 'CNY',
    amount: 1500, status: OrderStatus.FULFILLED, createdAt: NOW - 1000, updatedAt: NOW - 1000,
    expiresAt: NOW + 900_000, paidAt: NOW - 500, metadata: {}, ...over,
  };
}

function refund(over: Partial<Refund> & { id: string; orderId: string }): Refund {
  return {
    outRefundNo: `RF-${over.id}`, amount: 500, currency: 'CNY', status: RefundStatus.SUCCESS,
    rawStatus: 'OK', createdAt: NOW, updatedAt: NOW, ...over,
  };
}

async function fixture(orders: Order[], refunds: Refund[] = []) {
  const orderRepo = new MemoryOrderRepository();
  const refundRepo = new MemoryRefundRepository();
  for (const o of orders) await orderRepo.create(o);
  for (const r of refunds) await refundRepo.create(r);
  return { orderRepo, refundRepo, svc: new ReconciliationService(orderRepo, refundRepo, undefined, () => NOW) };
}

test('a healthy ledger produces no discrepancies', async () => {
  const { svc } = await fixture(
    [order({ id: 'o1', refundedAmount: 500 })],
    [refund({ id: 'r1', orderId: 'o1', amount: 500, status: RefundStatus.SUCCESS })],
  );
  const report = await svc.run();
  assert.equal(report.checkedOrders, 1);
  assert.equal(report.checkedRefunds, 1);
  assert.deepEqual(report.discrepancies, []);
});

test('detects paid-but-unfulfilled', async () => {
  const { svc } = await fixture([order({ id: 'o1', status: OrderStatus.PAID })]);
  const d = (await svc.run()).discrepancies;
  assert.ok(d.some((x) => x.type === 'paid_unfulfilled' && x.orderId === 'o1'));
});

test('detects fulfilled-without-payment', async () => {
  const { svc } = await fixture([order({ id: 'o1', status: OrderStatus.FULFILLED, paidAt: undefined })]);
  assert.ok((await svc.run()).discrepancies.some((x) => x.type === 'fulfilled_without_payment'));
});

test('detects stale pending and heals when asked', async () => {
  const orderRepo = new MemoryOrderRepository();
  const refundRepo = new MemoryRefundRepository();
  await orderRepo.create(order({ id: 'o1', status: OrderStatus.PENDING, paidAt: undefined, expiresAt: NOW - 1 }));
  let healed = 0;
  const svc = new ReconciliationService(orderRepo, refundRepo, async () => { healed = 1; return 1; }, () => NOW);

  const report = await svc.run({ heal: true });
  assert.ok(report.discrepancies.some((x) => x.type === 'stale_pending'));
  assert.equal(report.healedStaleOrders, 1);
  assert.equal(healed, 1);
});

test('detects over-refund and refund-ledger mismatch', async () => {
  const { svc } = await fixture(
    // refundedAmount says 200 but the only non-failed refund is 500 -> mismatch;
    // also 500 > amount would be over-refund if refundedAmount exceeded amount.
    [order({ id: 'o1', amount: 1500, status: OrderStatus.REFUNDED, refundedAmount: 200 })],
    [refund({ id: 'r1', orderId: 'o1', amount: 500, status: RefundStatus.SUCCESS })],
  );
  const d = (await svc.run()).discrepancies;
  assert.ok(d.some((x) => x.type === 'refund_ledger_mismatch' && x.orderId === 'o1'));

  const { svc: svc2 } = await fixture(
    [order({ id: 'o2', amount: 1000, status: OrderStatus.REFUNDED, refundedAmount: 1500 })],
    [refund({ id: 'r2', orderId: 'o2', amount: 1500, status: RefundStatus.SUCCESS })],
  );
  assert.ok((await svc2.run()).discrepancies.some((x) => x.type === 'over_refunded' && x.orderId === 'o2'));
});

test('FAILED refunds are excluded from the reserved-ledger sum', async () => {
  const { svc } = await fixture(
    [order({ id: 'o1', refundedAmount: 0 })],
    [refund({ id: 'r1', orderId: 'o1', amount: 500, status: RefundStatus.FAILED })],
  );
  // refundedAmount 0 == reserved 0 (failed excluded) -> no mismatch.
  assert.deepEqual((await svc.run()).discrepancies, []);
});
