import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig, CANONICAL_USDT_TRC20, UsdtConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { PaymentMethod, OrderStatus } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { UsdtTronProvider } from '../src/providers/usdt/usdtTron';
import { MemorySubscriptionRepository } from '../src/storage/memoryStore';
import { SignatureError } from '../src/domain/errors';
import { FakeProvider, FakeChainClient, callbackBody } from './_helpers';

function baseConfig(): AppConfig {
  return { port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3 };
}

interface Harness {
  container: ReturnType<typeof buildContainer>;
  subs: MemorySubscriptionRepository;
  clock: { value: number };
  wechat: FakeProvider;
}

function makeHarness(extraProviders?: (chain: FakeChainClient) => Map<PaymentMethod, PaymentProvider>): Harness {
  const subs = new MemorySubscriptionRepository();
  const clock = { value: Date.UTC(2026, 0, 1) };
  const wechat = new FakeProvider('wechat');
  const chain = new FakeChainClient();
  const providers = extraProviders
    ? extraProviders(chain)
    : new Map<PaymentMethod, PaymentProvider>([['wechat', wechat]]);
  if (!providers.has('wechat')) providers.set('wechat', wechat);

  const container = buildContainer(baseConfig(), {
    providers,
    subscriptions: subs,
    now: () => clock.value,
  });
  return { container, subs, clock, wechat };
}

test('happy path: create -> callback -> fulfilled + subscription', async () => {
  const h = makeHarness();
  const { order } = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  assert.equal(order.status, OrderStatus.PENDING);
  assert.equal(order.amount, 1500);

  const ack = await h.container.payments.handleCallback('wechat', {
    rawBody: callbackBody({ outTradeNo: order.outTradeNo, paidAmount: 1500 }),
    headers: {},
  });
  assert.equal(ack.status, 200);

  const after = await h.container.payments.getOrder(order.id);
  assert.equal(after?.status, OrderStatus.FULFILLED);
  assert.equal(after?.providerTxnId !== undefined, true);

  const sub = await h.subs.findActiveByUser('u1');
  assert.ok(sub);
  assert.equal(sub!.orderIds.length, 1);
  assert.equal(sub!.expiresAt, h.clock.value + 30 * 24 * 3600 * 1000);
});

test('duplicate callback (same eventId) is idempotent', async () => {
  const h = makeHarness();
  const { order } = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  const body = callbackBody({ outTradeNo: order.outTradeNo, eventId: 'fixed-evt', paidAmount: 1500 });

  await h.container.payments.handleCallback('wechat', { rawBody: body, headers: {} });
  await h.container.payments.handleCallback('wechat', { rawBody: body, headers: {} });

  const sub = await h.subs.findActiveByUser('u1');
  assert.equal(sub!.orderIds.length, 1); // not double-fulfilled
  assert.equal(sub!.expiresAt, h.clock.value + 30 * 24 * 3600 * 1000);
});

test('two concurrent distinct callbacks fulfil exactly once', async () => {
  const h = makeHarness();
  const { order } = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });

  await Promise.all([
    h.container.payments.handleCallback('wechat', { rawBody: callbackBody({ outTradeNo: order.outTradeNo, eventId: 'e1', paidAmount: 1500 }), headers: {} }),
    h.container.payments.handleCallback('wechat', { rawBody: callbackBody({ outTradeNo: order.outTradeNo, eventId: 'e2', paidAmount: 1500 }), headers: {} }),
  ]);

  const after = await h.container.payments.getOrder(order.id);
  assert.equal(after?.status, OrderStatus.FULFILLED);
  const sub = await h.subs.findActiveByUser('u1');
  assert.equal(sub!.orderIds.length, 1);
});

test('underpayment is rejected; order stays PENDING', async () => {
  const h = makeHarness();
  const { order } = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  await h.container.payments.handleCallback('wechat', {
    rawBody: callbackBody({ outTradeNo: order.outTradeNo, paidAmount: 1000 }), headers: {},
  });
  const after = await h.container.payments.getOrder(order.id);
  assert.equal(after?.status, OrderStatus.PENDING);
  assert.equal(await h.subs.findActiveByUser('u1'), undefined);
});

test('currency mismatch is rejected', async () => {
  const h = makeHarness();
  const { order } = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  await h.container.payments.handleCallback('wechat', {
    rawBody: callbackBody({ outTradeNo: order.outTradeNo, paidAmount: 1500, currency: 'USDT' }), headers: {},
  });
  assert.equal((await h.container.payments.getOrder(order.id))?.status, OrderStatus.PENDING);
});

test('bad signature rejects the callback', async () => {
  const h = makeHarness();
  h.wechat.signatureValid = false;
  await assert.rejects(
    () => h.container.payments.handleCallback('wechat', { rawBody: '{}', headers: {} }),
    SignatureError,
  );
});

test('idempotencyKey returns the same order without creating a new one', async () => {
  const h = makeHarness();
  const a = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat', idempotencyKey: 'k1' });
  const b = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat', idempotencyKey: 'k1' });
  assert.equal(a.order.id, b.order.id);
  assert.deepEqual((await h.container.orders.all()).length, 1);
});

test('stale pending orders expire and cannot then be paid', async () => {
  const h = makeHarness();
  const { order } = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });

  h.clock.value += 16 * 60_000; // beyond 15-minute TTL
  const expired = await h.container.payments.expireStaleOrders();
  assert.equal(expired, 1);
  assert.equal((await h.container.payments.getOrder(order.id))?.status, OrderStatus.EXPIRED);

  // A late callback must not revive an expired order.
  const ack = await h.container.payments.handleCallback('wechat', {
    rawBody: callbackBody({ outTradeNo: order.outTradeNo, paidAmount: 1500 }), headers: {},
  });
  assert.equal(ack.status, 500); // provider told to retry / flagged failure
  assert.equal((await h.container.payments.getOrder(order.id))?.status, OrderStatus.EXPIRED);
});

test('paying a second order extends (stacks) the subscription', async () => {
  const h = makeHarness();
  const first = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  await h.container.payments.handleCallback('wechat', { rawBody: callbackBody({ outTradeNo: first.order.outTradeNo, paidAmount: 1500 }), headers: {} });
  const second = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  await h.container.payments.handleCallback('wechat', { rawBody: callbackBody({ outTradeNo: second.order.outTradeNo, paidAmount: 1500 }), headers: {} });

  const sub = await h.subs.findActiveByUser('u1');
  assert.equal(sub!.orderIds.length, 2);
  assert.equal(sub!.expiresAt, h.clock.value + 60 * 24 * 3600 * 1000); // 2x30 days
});

// ---- USDT reconciliation end-to-end (real provider + fake chain) ----

function usdtCfg(): UsdtConfig {
  return {
    receivingAddress: 'TXYZreceivingAddr00000000000000000', contractAddress: CANONICAL_USDT_TRC20,
    apiBase: 'https://api.trongrid.io', minConfirmations: 19, uniqueAmountMaxDelta: 9999,
  };
}

test('USDT: unique amounts per order, reconciliation settles, dedupe holds', async () => {
  const chain = new FakeChainClient();
  const h = makeHarness(() =>
    new Map<PaymentMethod, PaymentProvider>([['usdt', new UsdtTronProvider(usdtCfg(), chain)]]),
  );

  const o1 = await h.container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'usdt' });
  const o2 = await h.container.payments.createOrder({ userId: 'u2', planId: 'monthly', method: 'usdt' });
  assert.notEqual(o1.order.amount, o2.order.amount); // unique amounts
  assert.equal(o1.order.currency, 'USDT');

  // Fund only o1 with the exact amount.
  chain.transfers = [
    { txId: 'tx1', to: usdtCfg().receivingAddress, from: 'sender', valueMicro: o1.order.amount, timestampMs: h.clock.value, confirmed: true },
  ];

  const settled = await h.container.usdtWatcher!.reconcileOnce();
  assert.equal(settled, 1);
  assert.equal((await h.container.payments.getOrder(o1.order.id))?.status, OrderStatus.FULFILLED);
  assert.equal((await h.container.payments.getOrder(o2.order.id))?.status, OrderStatus.PENDING);

  // Running again must not double-fulfil (txn dedupe).
  const settled2 = await h.container.usdtWatcher!.reconcileOnce();
  assert.equal(settled2, 0);
  const sub = await h.subs.findActiveByUser('u1');
  assert.equal(sub!.orderIds.length, 1);
});
