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

function start(adminToken?: string, adminTokenPrevious?: string): Promise<{ base: string; server: Server }> {
  const config: AppConfig = { port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7, shutdownTimeoutMs: 10000, adminToken, adminTokenPrevious, rateLimit: { enabled: false, max: 100, windowMs: 60000 }, security: { corsOrigins: [], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true } };
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

test('during rotation, both the current and previous admin tokens are accepted', async () => {
  const { base, server } = await start('new-token', 'old-token');
  try {
    const url = `${base}/admin/reports/summary`;
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer new-token' } })).status, 200);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer old-token' } })).status, 200);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer other' } })).status, 401);
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

test('business events are recorded and queryable via /admin/audit', async () => {
  const { base, server } = await start(TOKEN);
  try {
    await seedPaidOrder(base); // records order.created + order.fulfilled
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const all = await getJson(await fetch(`${base}/admin/audit`, { headers: auth }));
    const actions = all.items.map((e: any) => e.action);
    assert.ok(actions.includes('order.created'));
    assert.ok(actions.includes('order.fulfilled'));
    assert.ok(actions.includes('admin.access')); // this very request

    const filtered = await getJson(await fetch(`${base}/admin/audit?action=order.fulfilled`, { headers: auth }));
    assert.ok(filtered.total >= 1);
    assert.ok(filtered.items.every((e: any) => e.action === 'order.fulfilled'));
  } finally {
    server.close();
  }
});

test('orders-summary endpoint returns pushed-down aggregates', async () => {
  const { base, server } = await start(TOKEN);
  try {
    await seedPaidOrder(base);
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const s = await getJson(await fetch(`${base}/admin/reports/orders-summary`, { headers: auth }));
    assert.equal(s.ordersTotal, 1);
    assert.equal(s.byStatus.FULFILLED, 1);
    assert.equal(s.currencies.find((c: any) => c.currency === 'CNY').grossMinor, 1500);
    assert.equal((await fetch(`${base}/admin/reports/orders-summary`)).status, 401);
  } finally {
    server.close();
  }
});

test('refund listing accepts a status filter and validates it', async () => {
  const { base, server } = await start(TOKEN);
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const ok = await getJson(await fetch(`${base}/admin/refunds?status=SUCCESS`, { headers: auth }));
    assert.equal(typeof ok.total, 'number');
    assert.equal((await fetch(`${base}/admin/refunds?status=BOGUS`, { headers: auth })).status, 400);
  } finally {
    server.close();
  }
});

test('CSV exports return text/csv with headers and rows', async () => {
  const { base, server } = await start(TOKEN);
  try {
    await seedPaidOrder(base);
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const ordersRes = await fetch(`${base}/admin/orders.csv`, { headers: auth });
    assert.equal(ordersRes.status, 200);
    assert.match(ordersRes.headers.get('content-type') ?? '', /text\/csv/);
    const ordersCsv = await ordersRes.text();
    assert.match(ordersCsv.split('\r\n')[0], /^id,outTradeNo,userId/);
    assert.ok(ordersCsv.split('\r\n').length >= 2);

    const refundsRes = await fetch(`${base}/admin/refunds.csv`, { headers: auth });
    assert.equal(refundsRes.status, 200);
    assert.match((await refundsRes.text()).split('\r\n')[0], /^id,orderId,outRefundNo/);

    assert.equal((await fetch(`${base}/admin/orders.csv`)).status, 401); // still protected
  } finally {
    server.close();
  }
});

test('/admin/reconciliation returns a clean report for healthy data', async () => {
  const { base, server } = await start(TOKEN);
  try {
    await seedPaidOrder(base);
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const report = await getJson(await fetch(`${base}/admin/reconciliation`, { method: 'POST', headers: auth }));
    assert.equal(report.checkedOrders, 1);
    assert.deepEqual(report.discrepancies, []);
    assert.equal(typeof report.healedStaleOrders, 'number');
  } finally {
    server.close();
  }
});
