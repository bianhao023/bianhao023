import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig, AlipayConfig, WechatConfig, UsdtConfig, CANONICAL_USDT_TRC20 } from '../src/config';
import { buildContainer } from '../src/container';
import { OrderStatus, PaymentMethod, Order } from '../src/domain/types';
import { RefundStatus } from '../src/domain/refund';
import { InvalidStateError, ValidationError } from '../src/domain/errors';
import { PaymentProvider } from '../src/providers/provider';
import { WechatPayProvider } from '../src/providers/wechat/wechatPay';
import { AlipayProvider } from '../src/providers/alipay/alipay';
import { UsdtTronProvider } from '../src/providers/usdt/usdtTron';
import { MemorySubscriptionRepository } from '../src/storage/memoryStore';
import { genRsaKeyPair, MockHttpClient, FakeProvider, FakeChainClient, callbackBody } from './_helpers';

function order(method: PaymentMethod = 'wechat'): Order {
  const now = Date.now();
  return {
    id: 'o1', outTradeNo: 'VPN1', userId: 'u1', planId: 'monthly', method,
    currency: method === 'usdt' ? 'USDT' : 'CNY', amount: 1500, status: OrderStatus.PAID,
    createdAt: now, updatedAt: now, expiresAt: now + 900_000, metadata: {},
  };
}

// ---- provider-level refund ----

test('WeChat refund posts a signed request and maps SUCCESS', async () => {
  const merchant = genRsaKeyPair();
  const cfg: WechatConfig = {
    appId: 'wx', mchId: '160000', privateKeyPem: merchant.privateKey, serialNo: 'S1',
    apiV3Key: '0123456789abcdef0123456789abcdef', platformPublicKeyPem: genRsaKeyPair().publicKey,
    notifyUrl: 'https://x/notify', apiBase: 'https://api.mch.weixin.qq.com',
  };
  const http = new MockHttpClient(() => ({ status: 200, body: JSON.stringify({ refund_id: 'wxr1', status: 'SUCCESS' }) }));
  const res = await new WechatPayProvider(cfg, http).refund(order(), {
    outRefundNo: 'RF1', amount: 1500, totalAmount: 1500, currency: 'CNY', reason: 'test',
  });
  assert.equal(res.status, RefundStatus.SUCCESS);
  assert.equal(res.providerRefundId, 'wxr1');
  assert.match(http.requests[0].headers!['Authorization'], /WECHATPAY2-SHA256-RSA2048/);
  const sent = JSON.parse(http.requests[0].body!);
  assert.equal(sent.amount.refund, 1500);
  assert.equal(sent.amount.total, 1500);
});

test('WeChat refund maps PROCESSING to PENDING', async () => {
  const merchant = genRsaKeyPair();
  const cfg: WechatConfig = {
    appId: 'wx', mchId: '160000', privateKeyPem: merchant.privateKey, serialNo: 'S1',
    apiV3Key: '0123456789abcdef0123456789abcdef', platformPublicKeyPem: genRsaKeyPair().publicKey,
    notifyUrl: 'https://x/notify', apiBase: 'https://api.mch.weixin.qq.com',
  };
  const http = new MockHttpClient(() => ({ status: 200, body: JSON.stringify({ refund_id: 'wxr2', status: 'PROCESSING' }) }));
  const res = await new WechatPayProvider(cfg, http).refund(order(), {
    outRefundNo: 'RF2', amount: 700, totalAmount: 1500, currency: 'CNY',
  });
  assert.equal(res.status, RefundStatus.PENDING);
});

test('Alipay refund posts a signed request and maps 10000 to SUCCESS', async () => {
  const merchant = genRsaKeyPair();
  const cfg: AlipayConfig = {
    appId: '2021', privateKeyPem: merchant.privateKey, alipayPublicKeyPem: genRsaKeyPair().publicKey,
    notifyUrl: 'https://x/notify', gateway: 'https://openapi.alipay.com/gateway.do', signType: 'RSA2',
  };
  const http = new MockHttpClient(() => ({
    status: 200, body: JSON.stringify({ alipay_trade_refund_response: { code: '10000', msg: 'Success', trade_no: 'alir1', fund_change: 'Y' } }),
  }));
  const res = await new AlipayProvider(cfg, http).refund(order('alipay'), {
    outRefundNo: 'RF3', amount: 1500, totalAmount: 1500, currency: 'CNY',
  });
  assert.equal(res.status, RefundStatus.SUCCESS);
  assert.equal(res.providerRefundId, 'alir1');
  const sent = new URLSearchParams(http.requests[0].body!);
  assert.equal(sent.get('method'), 'alipay.trade.refund');
  assert.equal(JSON.parse(sent.get('biz_content')!).refund_amount, '15.00');
});

test('Alipay refund surfaces a rejection', async () => {
  const merchant = genRsaKeyPair();
  const cfg: AlipayConfig = {
    appId: '2021', privateKeyPem: merchant.privateKey, alipayPublicKeyPem: genRsaKeyPair().publicKey,
    notifyUrl: 'https://x/notify', gateway: 'https://openapi.alipay.com/gateway.do', signType: 'RSA2',
  };
  const http = new MockHttpClient(() => ({
    status: 200, body: JSON.stringify({ alipay_trade_refund_response: { code: '40004', msg: 'Business Failed' } }),
  }));
  await assert.rejects(() => new AlipayProvider(cfg, http).refund(order('alipay'), {
    outRefundNo: 'RF4', amount: 1500, totalAmount: 1500, currency: 'CNY',
  }), /rejected/);
});

// ---- service-level refund ----

function baseConfig(): AppConfig {
  return { port: 0, orderTtlMinutes: 15, enabledMethods: [] };
}

async function paidOrderHarness() {
  const subs = new MemorySubscriptionRepository();
  const clock = { value: Date.UTC(2026, 0, 1) };
  const wechat = new FakeProvider('wechat');
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', wechat]]);
  const container = buildContainer(baseConfig(), { providers, subscriptions: subs, now: () => clock.value });
  const created = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  await container.payments.handleCallback('wechat', {
    rawBody: callbackBody({ outTradeNo: created.order.outTradeNo, paidAmount: 1500 }), headers: {},
  });
  return { container, wechat, orderId: created.order.id };
}

test('full refund moves the order to REFUNDED', async () => {
  const h = await paidOrderHarness();
  const refund = await h.container.refunds.refundOrder(h.orderId);
  assert.equal(refund.status, RefundStatus.SUCCESS);
  assert.equal(refund.amount, 1500);
  const o = await h.container.payments.getOrder(h.orderId);
  assert.equal(o?.status, OrderStatus.REFUNDED);
  assert.equal(o?.refundedAmount, 1500);
});

test('partial refunds accumulate, then a final refund completes REFUNDED', async () => {
  const h = await paidOrderHarness();
  await h.container.refunds.refundOrder(h.orderId, { amount: 500 });
  let o = await h.container.payments.getOrder(h.orderId);
  assert.equal(o?.status, OrderStatus.FULFILLED); // not fully refunded yet
  assert.equal(o?.refundedAmount, 500);

  await h.container.refunds.refundOrder(h.orderId, { amount: 1000 });
  o = await h.container.payments.getOrder(h.orderId);
  assert.equal(o?.status, OrderStatus.REFUNDED);
  assert.equal(o?.refundedAmount, 1500);

  const refunds = await h.container.refunds.listOrderRefunds(h.orderId);
  assert.equal(refunds.length, 2);
});

test('over-refund is rejected', async () => {
  const h = await paidOrderHarness();
  await assert.rejects(() => h.container.refunds.refundOrder(h.orderId, { amount: 2000 }), ValidationError);
  await h.container.refunds.refundOrder(h.orderId, { amount: 1000 });
  await assert.rejects(() => h.container.refunds.refundOrder(h.orderId, { amount: 1000 }), ValidationError);
});

test('refunding a non-paid order is rejected', async () => {
  const subs = new MemorySubscriptionRepository();
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(baseConfig(), { providers, subscriptions: subs });
  const created = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  await assert.rejects(() => container.refunds.refundOrder(created.order.id), InvalidStateError);
});

test('refund is idempotent by outRefundNo', async () => {
  const h = await paidOrderHarness();
  const a = await h.container.refunds.refundOrder(h.orderId, { amount: 500, outRefundNo: 'fixed-1' });
  const b = await h.container.refunds.refundOrder(h.orderId, { amount: 500, outRefundNo: 'fixed-1' });
  assert.equal(a.id, b.id);
  const o = await h.container.payments.getOrder(h.orderId);
  assert.equal(o?.refundedAmount, 500); // not applied twice
});

test('USDT order without a refund channel records a MANUAL refund', async () => {
  const subs = new MemorySubscriptionRepository();
  const clock = { value: Date.UTC(2026, 0, 1) };
  const usdtCfg: UsdtConfig = {
    receivingAddress: 'TADDR', contractAddress: CANONICAL_USDT_TRC20,
    apiBase: 'https://api.trongrid.io', minConfirmations: 19, uniqueAmountMaxDelta: 9999,
  };
  const chain = new FakeChainClient();
  const providers = new Map<PaymentMethod, PaymentProvider>([['usdt', new UsdtTronProvider(usdtCfg, chain)]]);
  const container = buildContainer(baseConfig(), { providers, subscriptions: subs, now: () => clock.value });

  const created = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'usdt' });
  chain.transfers = [{ txId: 'tx1', to: 'TADDR', from: 'f', valueMicro: created.order.amount, timestampMs: clock.value, confirmed: true }];
  await container.usdtWatcher!.reconcileOnce();

  const refund = await container.refunds.refundOrder(created.order.id);
  assert.equal(refund.status, RefundStatus.MANUAL);
  const o = await container.payments.getOrder(created.order.id);
  assert.equal(o?.status, OrderStatus.REFUNDED);
});
