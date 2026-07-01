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

const TOKEN = 'secret-admin-token';

async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function start(adminToken?: string): Promise<{ base: string; server: Server }> {
  const config: AppConfig = { port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, adminToken };
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(config, { providers });
  const server = createHttpServer(container);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}

async function seedPaidOrder(base: string) {
  const created = await getJson(await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' }),
  }));
  await fetch(`${base}/api/notify/wechat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: callbackBody({ outTradeNo: created.outTradeNo, paidAmount: 1500 }),
  });
  return created;
}

test('admin endpoints reject missing and wrong tokens', async () => {
  const { base, server } = await start(TOKEN);
  try {
    assert.equal((await fetch(`${base}/admin/reports/summary`)).status, 401);
    assert.equal((await fetch(`${base}/admin/reports/summary`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  } finally {
    server.close();
  }
});

test('admin endpoints are disabled (403) when no token is configured', async () => {
  const { base, server } = await start(undefined);
  try {
    assert.equal((await fetch(`${base}/admin/reports/summary`, { headers: { Authorization: 'Bearer anything' } })).status, 403);
  } finally {
    server.close();
  }
});

test('admin reports + listings work with a valid token', async () => {
  const { base, server } = await start(TOKEN);
  try {
    await seedPaidOrder(base);
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const summary = await getJson(await fetch(`${base}/admin/reports/summary`, { headers: auth }));
    assert.equal(summary.ordersTotal, 1);
    assert.equal(summary.currencies.find((c: any) => c.currency === 'CNY').grossMinor, 1500);

    const orders = await getJson(await fetch(`${base}/admin/orders?limit=10`, { headers: auth }));
    assert.equal(orders.total, 1);
    assert.equal(orders.items[0].status, 'FULFILLED');

    const refunds = await getJson(await fetch(`${base}/admin/refunds`, { headers: auth }));
    assert.equal(refunds.total, 0);

    const expiry = await getJson(await fetch(`${base}/admin/expiry/run`, { method: 'POST', headers: auth }));
    assert.equal(typeof expiry.reminders, 'number');
    assert.equal(typeof expiry.deactivated, 'number');
  } finally {
    server.close();
  }
});

test('admin order filter validates enum params', async () => {
  const { base, server } = await start(TOKEN);
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${base}/admin/orders?status=BOGUS`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/admin/orders?method=paypal`, { headers: auth })).status, 400);
  } finally {
    server.close();
  }
});
