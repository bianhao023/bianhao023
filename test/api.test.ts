import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { createHttpServer } from '../src/api/server';
import { PaymentMethod } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { FakeProvider, callbackBody } from './_helpers';

/** Await a fetch and parse JSON as `any` (Response.json() is typed unknown). */
async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function startServer(): Promise<{ base: string; server: Server }> {
  const config: AppConfig = { port: 0, orderTtlMinutes: 15, enabledMethods: [] };
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(config, { providers });
  const server = createHttpServer(container);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, server });
    });
  });
}

test('full HTTP flow: plans -> create -> notify -> fulfilled', async () => {
  const { base, server } = await startServer();
  try {
    const health = await getJson(await fetch(`${base}/healthz`));
    assert.equal(health.status, 'ok');
    assert.deepEqual(health.methods, ['wechat']);

    const plans = await getJson(await fetch(`${base}/api/plans`));
    assert.ok(Array.isArray(plans.plans) && plans.plans.length >= 1);
    assert.equal(plans.plans[0].priceCnyDisplay, '15.00');

    const createRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' }),
    });
    assert.equal(createRes.status, 201);
    const created = await getJson(createRes);
    assert.equal(created.status, 'PENDING');
    assert.equal(created.amountDisplay, '15.00');
    assert.ok(created.payInfo.payTarget);

    const got = await getJson(await fetch(`${base}/api/orders/${created.orderId}`));
    assert.equal(got.status, 'PENDING');

    const notifyRes = await fetch(`${base}/api/notify/wechat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: callbackBody({ outTradeNo: created.outTradeNo, paidAmount: 1500 }),
    });
    assert.equal(notifyRes.status, 200);
    assert.equal(await notifyRes.text(), 'ok');

    const fulfilled = await getJson(await fetch(`${base}/api/orders/${created.orderId}`));
    assert.equal(fulfilled.status, 'FULFILLED');
  } finally {
    server.close();
  }
});

test('validation and routing errors return proper status codes', async () => {
  const { base, server } = await startServer();
  try {
    const badMethod = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'paypal' }),
    });
    assert.equal(badMethod.status, 400);

    const missing = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'monthly', method: 'wechat' }),
    });
    assert.equal(missing.status, 400);

    const unknownOrder = await fetch(`${base}/api/orders/does-not-exist`);
    assert.equal(unknownOrder.status, 404);

    const noRoute = await fetch(`${base}/nope`);
    assert.equal(noRoute.status, 404);
  } finally {
    server.close();
  }
});

test('HTTP refund flow: create -> pay -> refund -> REFUNDED', async () => {
  const { base, server } = await startServer();
  try {
    const created = await getJson(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' }),
    }));
    await fetch(`${base}/api/notify/wechat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: callbackBody({ outTradeNo: created.outTradeNo, paidAmount: 1500 }),
    });

    const refundRes = await fetch(`${base}/api/orders/${created.orderId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'customer request' }),
    });
    assert.equal(refundRes.status, 201);
    const refund = await getJson(refundRes);
    assert.equal(refund.status, 'SUCCESS');
    assert.equal(refund.amount, 1500);

    const refunds = await getJson(await fetch(`${base}/api/orders/${created.orderId}/refunds`));
    assert.equal(refunds.refunds.length, 1);

    const order = await getJson(await fetch(`${base}/api/orders/${created.orderId}`));
    assert.equal(order.status, 'REFUNDED');
  } finally {
    server.close();
  }
});

test('idempotency-key header dedupes order creation over HTTP', async () => {
  const { base, server } = await startServer();
  try {
    const body = JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'abc-123' };
    const a = await getJson(await fetch(`${base}/api/orders`, { method: 'POST', headers, body }));
    const b = await getJson(await fetch(`${base}/api/orders`, { method: 'POST', headers, body }));
    assert.equal(a.orderId, b.orderId);
  } finally {
    server.close();
  }
});
