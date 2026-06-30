import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowToOrder,
  rowToRefund,
  rowToSubscription,
  SqlProcessedEventStore,
  SqlClient,
} from '../src/storage/sql/sqlStore';
import { OrderStatus } from '../src/domain/types';
import { RefundStatus } from '../src/domain/refund';

test('rowToOrder maps DB types (bigint-as-string, jsonb) correctly', () => {
  const o = rowToOrder({
    id: 'o1', out_trade_no: 'VPN1', user_id: 'u1', plan_id: 'monthly', method: 'wechat',
    currency: 'CNY', amount: '1500', status: 'PAID', provider_txn_id: 'wx1', idempotency_key: null,
    created_at: '1000', updated_at: '2000', expires_at: '3000', paid_at: '1500',
    refunded_amount: '500', metadata: { payInfo: '{}' },
  });
  assert.equal(o.amount, 1500);
  assert.equal(typeof o.amount, 'number');
  assert.equal(o.status, OrderStatus.PAID);
  assert.equal(o.providerTxnId, 'wx1');
  assert.equal(o.idempotencyKey, undefined);
  assert.equal(o.refundedAmount, 500);
  assert.equal(o.metadata.payInfo, '{}');
});

test('rowToOrder parses metadata supplied as a JSON string', () => {
  const o = rowToOrder({
    id: 'o1', out_trade_no: 'VPN1', user_id: 'u1', plan_id: 'monthly', method: 'usdt',
    currency: 'USDT', amount: '2000000', status: 'PENDING', created_at: '1', updated_at: '1',
    expires_at: '2', refunded_amount: null, metadata: '{"k":"v"}',
  });
  assert.equal(o.metadata.k, 'v');
  assert.equal(o.refundedAmount, 0);
});

test('rowToRefund and rowToSubscription map correctly', () => {
  const rf = rowToRefund({
    id: 'r1', order_id: 'o1', out_refund_no: 'RF1', amount: '1500', currency: 'CNY',
    reason: 'x', status: 'SUCCESS', provider_refund_id: 'p1', raw_status: 'OK',
    created_at: '1', updated_at: '2',
  });
  assert.equal(rf.amount, 1500);
  assert.equal(rf.status, RefundStatus.SUCCESS);

  const sub = rowToSubscription({
    id: 's1', user_id: 'u1', plan_id: 'monthly', starts_at: '1', expires_at: '2',
    traffic_gb: '200', device_limit: '3', active: true, order_ids: ['o1', 'o2'],
    created_at: '1', updated_at: '2',
  });
  assert.deepEqual(sub.orderIds, ['o1', 'o2']);
  assert.equal(sub.trafficGb, 200);
  assert.equal(sub.active, true);
});

test('SqlProcessedEventStore.markIfNew is atomic via ON CONFLICT rowCount', async () => {
  const seen = new Set<string>();
  const fakeDb: SqlClient = {
    async query(sql: string, params?: unknown[]) {
      assert.match(sql, /ON CONFLICT \(event_id\) DO NOTHING/);
      const id = String((params ?? [])[0]);
      if (seen.has(id)) return { rows: [], rowCount: 0 };
      seen.add(id);
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new SqlProcessedEventStore(fakeDb);
  assert.equal(await store.markIfNew('e1'), true);
  assert.equal(await store.markIfNew('e1'), false);
  assert.equal(await store.markIfNew('e2'), true);
});
