import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryOrderRepository } from '../src/storage/memoryStore';
import { SqlOrderRepository, SqlClient } from '../src/storage/sql/sqlStore';
import { Order, OrderStatus, PaymentMethod } from '../src/domain/types';

function order(id: string, over: Partial<Order> = {}): Order {
  return {
    id, outTradeNo: `T-${id}`, userId: 'u', planId: 'monthly', method: 'wechat', currency: 'CNY',
    amount: 1500, status: OrderStatus.PENDING, createdAt: 1000, updatedAt: 1000, expiresAt: 2000,
    metadata: {}, ...over,
  };
}

test('memory query filters, sorts newest-first, and paginates', async () => {
  const repo = new MemoryOrderRepository();
  await repo.create(order('a', { createdAt: 100, status: OrderStatus.PENDING, method: 'wechat' }));
  await repo.create(order('b', { createdAt: 300, status: OrderStatus.FULFILLED, method: 'alipay' as PaymentMethod }));
  await repo.create(order('c', { createdAt: 200, status: OrderStatus.FULFILLED, method: 'wechat' }));

  const all = await repo.query({}, 10, 0);
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((o) => o.id), ['b', 'c', 'a']); // newest-first

  const fulfilled = await repo.query({ status: OrderStatus.FULFILLED }, 10, 0);
  assert.deepEqual(fulfilled.items.map((o) => o.id).sort(), ['b', 'c']);

  const wechat = await repo.query({ method: 'wechat' }, 10, 0);
  assert.deepEqual(wechat.items.map((o) => o.id).sort(), ['a', 'c']);

  const windowed = await repo.query({ from: 150, to: 300 }, 10, 0); // [150,300)
  assert.deepEqual(windowed.items.map((o) => o.id), ['c']);

  const page = await repo.query({}, 2, 0);
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.equal((await repo.query({}, 2, 2)).items.length, 1);
});

test('SQL query builds a parameterized WHERE + COUNT + paginated SELECT', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const fake: SqlClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/COUNT/i.test(sql)) return { rows: [{ total: '5' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const repo = new SqlOrderRepository(fake);
  const res = await repo.query({ status: OrderStatus.FULFILLED, method: 'wechat', from: 100, to: 900 }, 20, 40);

  assert.equal(res.total, 5);
  const countCall = calls[0];
  assert.match(countCall.sql, /SELECT COUNT\(\*\) AS total FROM orders WHERE/);
  assert.match(countCall.sql, /status = \$1 AND method = \$2 AND created_at >= \$3 AND created_at < \$4/);
  assert.deepEqual(countCall.params, ['FULFILLED', 'wechat', 100, 900]);

  const listCall = calls[1];
  assert.match(listCall.sql, /ORDER BY created_at DESC LIMIT \$5 OFFSET \$6/);
  assert.deepEqual(listCall.params, ['FULFILLED', 'wechat', 100, 900, 20, 40]);
});

test('SQL query with no filter omits the WHERE clause', async () => {
  const calls: Array<{ sql: string }> = [];
  const fake: SqlClient = {
    async query(sql) {
      calls.push({ sql });
      if (/COUNT/i.test(sql)) return { rows: [{ total: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  await new SqlOrderRepository(fake).query({}, 10, 0);
  assert.ok(!/WHERE/.test(calls[0].sql));
  assert.match(calls[1].sql, /LIMIT \$1 OFFSET \$2/);
});
