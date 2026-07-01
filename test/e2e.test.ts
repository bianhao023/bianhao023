import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';

import { AppConfig } from '../src/config';
import { PaymentMethod } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { buildContainer } from '../src/container';
import { createHttpServer } from '../src/api/server';
import { FakeProvider, callbackBody } from './_helpers';

/** Response.json() is typed `unknown`; wrap so callers get a usable value. */
async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

/** A full AppConfig with rate limiting off and admin enabled. */
function buildConfig(): AppConfig {
  return {
    port: 0,
    orderTtlMinutes: 15,
    enabledMethods: ['wechat'],
    adminToken: 'e2e-admin',
    expiryReminderDays: 3, processedEventTtlDays: 7,
    rateLimit: { enabled: false, max: 100, windowMs: 60_000 },
    security: { corsOrigins: [], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
  };
}

let server: Server;
let base: string;

before(async () => {
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(buildConfig(), { providers });
  server = createHttpServer(container);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

test('full user journey over HTTP', async () => {
  const email = 'e2e@example.com';
  const password = 'supersecret1';

  // 1. Health check.
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await getJson(health);
  assert.equal(healthBody.status, 'ok');

  // 2. Register.
  const registerRes = await fetch(`${base}/api/users/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(registerRes.status, 201);
  const registered = await getJson(registerRes);
  const apiKey: string = registered.apiKey;
  assert.ok(apiKey.startsWith('vpk_'), 'apiKey should start with vpk_');
  const userId: string = registered.user.id;

  // 3. Login.
  const loginRes = await fetch(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200);
  const login = await getJson(loginRes);
  assert.equal(login.apiKey, apiKey);

  // 4. Who am I.
  const meRes = await fetch(`${base}/api/users/me`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(meRes.status, 200);
  const me = await getJson(meRes);
  assert.equal(me.email, email);

  // 5. Plans.
  const plansRes = await fetch(`${base}/api/plans`);
  assert.equal(plansRes.status, 200);
  const plansBody = await getJson(plansRes);
  const monthly = plansBody.plans.find((p: any) => p.id === 'monthly');
  assert.ok(monthly, 'monthly plan should be present');

  // 6. Create order.
  const orderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, planId: 'monthly', method: 'wechat' }),
  });
  assert.equal(orderRes.status, 201);
  const order = await getJson(orderRes);
  const orderId: string = order.orderId;
  const outTradeNo: string = order.outTradeNo;
  const amount: number = order.amount;
  assert.equal(order.status, 'PENDING');

  // 7. Order is pending.
  const pendingRes = await fetch(`${base}/api/orders/${orderId}`);
  assert.equal(pendingRes.status, 200);
  assert.equal((await getJson(pendingRes)).status, 'PENDING');

  // 8. Provider callback (payment succeeded).
  const notifyRes = await fetch(`${base}/api/notify/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: callbackBody({ outTradeNo, paidAmount: amount }),
  });
  assert.equal(notifyRes.status, 200);
  assert.equal(await notifyRes.text(), 'ok');

  // 9. Order fulfilled.
  const fulfilledRes = await fetch(`${base}/api/orders/${orderId}`);
  assert.equal(fulfilledRes.status, 200);
  assert.equal((await getJson(fulfilledRes)).status, 'FULFILLED');

  // 10. Refund.
  const refundRes = await fetch(`${base}/api/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'customer request' }),
  });
  assert.equal(refundRes.status, 201);
  assert.equal((await getJson(refundRes)).status, 'SUCCESS');

  // 11. Order refunded.
  const refundedRes = await fetch(`${base}/api/orders/${orderId}`);
  assert.equal(refundedRes.status, 200);
  assert.equal((await getJson(refundedRes)).status, 'REFUNDED');

  // 12. Admin summary.
  const summaryRes = await fetch(`${base}/admin/reports/summary`, {
    headers: { authorization: 'Bearer e2e-admin' },
  });
  assert.equal(summaryRes.status, 200);
  const summary = await getJson(summaryRes);
  assert.ok(summary.ordersTotal >= 1, 'ordersTotal should be at least 1');

  // 13. Audit log contains the expected actions.
  const auditRes = await fetch(`${base}/admin/audit`, {
    headers: { authorization: 'Bearer e2e-admin' },
  });
  assert.equal(auditRes.status, 200);
  const audit = await getJson(auditRes);
  const actions = new Set<string>((audit.items as any[]).map((i: any) => i.action));
  assert.ok(actions.has('order.created'), 'audit should include order.created');
  assert.ok(actions.has('order.fulfilled'), 'audit should include order.fulfilled');
  assert.ok(actions.has('refund.issued'), 'audit should include refund.issued');

  // 14. Metrics.
  const metricsRes = await fetch(`${base}/metrics`);
  assert.equal(metricsRes.status, 200);
  assert.ok((await metricsRes.text()).includes('vpn_http_requests_total'));

  // 15. OpenAPI spec.
  const openapiRes = await fetch(`${base}/openapi.json`);
  assert.equal(openapiRes.status, 200);
  assert.equal((await getJson(openapiRes)).openapi, '3.0.3');
});
