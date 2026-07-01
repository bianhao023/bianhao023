import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryOrderRepository, MemoryRefundRepository } from '../src/storage/memoryStore';
import { SqlOrderRepository, SqlRefundRepository, SqlClient } from '../src/storage/sql/sqlStore';
import { Order, OrderStatus } from '../src/domain/types';
import { Refund, RefundStatus } from '../src/domain/refund';

function order(id: string, over: Partial<Order>): Order {
  return {
    id, outTradeNo: `T-${id}`, userId: 'u', planId: 'monthly', method: 'wechat', currency: 'CNY',
    amount: 1500, status: OrderStatus.PENDING, createdAt: 1000, updatedAt: 1000, expiresAt: 2000,
    metadata: {}, ...over,
  };
}

test('memory summarize aggregates counts and paid gross by method+currency', async () => {
  const repo = new MemoryOrderRepository();
  await repo.create(order('o1', { status: OrderStatus.PENDING }));
  await repo.create(order('o2', { status: OrderStatus.FULFILLED, paidAt: 1, amount: 1500 }));
  await repo.create(order('o3', { status: OrderStatus.REFUNDED, paidAt: 1, amount: 1000 }));
  await repo.create(order('o4', { status: OrderStatus.FULFILLED, paidAt: 1, method: 'usdt', currency: 'USDT', amount: 2_000_000 }));

  const s = await repo.summarize({});
  assert.equal(s.ordersTotal, 4);
  assert.deepEqual(s.byStatus, { PENDING: 1, FULFILLED: 2, REFUNDED: 1 });

  const cny = s.paid.find((p) => p.currency === 'CNY')!;
  assert.equal(cny.paidCount, 2); // o2 + o3
  assert.equal(cny.grossMinor, 2500);
  const usdt = s.paid.find((p) => p.currency === 'USDT')!;
  assert.equal(usdt.grossMinor, 2_000_000);

  const wechatOnly = await repo.summarize({ method: 'wechat' });
  assert.equal(wechatOnly.paid.every((p) => p.method === 'wechat'), true);
});

test('SQL summarize issues COUNT + GROUP BY status + paid GROUP BY method,currency', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const fake: SqlClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '3' }], rowCount: 1 };
      if (/GROUP BY status/.test(sql)) return { rows: [{ status: 'FULFILLED', c: '2' }, { status: 'PENDING', c: '1' }], rowCount: 2 };
      return { rows: [{ method: 'wechat', currency: 'CNY', c: '2', g: '2500' }], rowCount: 1 };
    },
  };
  const s = await new SqlOrderRepository(fake).summarize({ method: 'wechat' });
  assert.equal(s.ordersTotal, 3);
  assert.deepEqual(s.byStatus, { FULFILLED: 2, PENDING: 1 });
  assert.equal(s.paid[0].grossMinor, 2500);

  const paidSql = calls[2].sql;
  assert.match(paidSql, /paid_at IS NOT NULL/);
  assert.match(paidSql, /status IN \('PAID','FULFILLED','REFUNDED'\)/);
  assert.match(paidSql, /GROUP BY method, currency/);
  assert.deepEqual(calls[2].params, ['wechat']);
});

// ── refund query pushdown ──────────────────────────────────────────────────

function refund(id: string, over: Partial<Refund>): Refund {
  return {
    id, orderId: 'o1', outRefundNo: `RF-${id}`, amount: 500, currency: 'CNY',
    status: RefundStatus.SUCCESS, rawStatus: 'OK', createdAt: 1000, updatedAt: 1000, ...over,
  };
}

test('memory refund query filters by status and paginates newest-first', async () => {
  const repo = new MemoryRefundRepository();
  await repo.create(refund('r1', { status: RefundStatus.SUCCESS, createdAt: 100 }));
  await repo.create(refund('r2', { status: RefundStatus.FAILED, createdAt: 300 }));
  await repo.create(refund('r3', { status: RefundStatus.SUCCESS, createdAt: 200 }));

  const all = await repo.query({}, 10, 0);
  assert.deepEqual(all.items.map((r) => r.id), ['r2', 'r3', 'r1']);

  const ok = await repo.query({ status: RefundStatus.SUCCESS }, 10, 0);
  assert.deepEqual(ok.items.map((r) => r.id), ['r3', 'r1']);
  assert.equal(ok.total, 2);
});

test('SQL refund query builds parameterized WHERE + paginated SELECT', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const fake: SqlClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/COUNT/.test(sql)) return { rows: [{ total: '2' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  await new SqlRefundRepository(fake).query({ status: RefundStatus.SUCCESS, from: 10 }, 25, 50);
  assert.match(calls[0].sql, /SELECT COUNT\(\*\) AS total FROM refunds WHERE status = \$1 AND created_at >= \$2/);
  assert.deepEqual(calls[0].params, ['SUCCESS', 10]);
  assert.match(calls[1].sql, /ORDER BY created_at DESC LIMIT \$3 OFFSET \$4/);
  assert.deepEqual(calls[1].params, ['SUCCESS', 10, 25, 50]);
});
