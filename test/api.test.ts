import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { createHttpServer } from '../src/api/server';
import { PaymentMethod } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { FakeProvider, callbackBody, refundCallbackBody } from './_helpers';
import { RefundStatus } from '../src/domain/refund';

/** Await a fetch and parse JSON as `any` (Response.json() is typed unknown). */
async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function startServer(
  rateLimit: AppConfig['rateLimit'] = { enabled: false, max: 100, windowMs: 60_000 },
): Promise<{ base: string; server: Server; wechat: FakeProvider }> {
  const config: AppConfig = { port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7, shutdownTimeoutMs: 10000, rateLimit, security: { corsOrigins: ['*'], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true } };
  const wechat = new FakeProvider('wechat');
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', wechat]]);
  const container = buildContainer(config, { providers });
  const server = createHttpServer(container);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, server, wechat });
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

test('HTTP async refund callback finalises a PROCESSING refund', async () => {
  const { base, server, wechat } = await startServer();
  try {
    wechat.refundResult = { providerRefundId: 'wxr', status: RefundStatus.PENDING, rawStatus: 'PROCESSING' };
    const created = await getJson(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' }),
    }));
    await fetch(`${base}/api/notify/wechat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: callbackBody({ outTradeNo: created.outTradeNo, paidAmount: 1500 }),
    });
    const refund = await getJson(await fetch(`${base}/api/orders/${created.orderId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    assert.equal(refund.status, 'PENDING');
    // Not yet REFUNDED.
    assert.equal((await getJson(await fetch(`${base}/api/orders/${created.orderId}`))).status, 'FULFILLED');

    const ack = await fetch(`${base}/api/notify/wechat/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: refundCallbackBody({ outRefundNo: refund.outRefundNo, status: RefundStatus.SUCCESS }),
    });
    assert.equal(ack.status, 200);
    assert.equal((await getJson(await fetch(`${base}/api/orders/${created.orderId}`))).status, 'REFUNDED');
  } finally {
    server.close();
  }
});

test('/metrics exposes Prometheus counters after requests', async () => {
  const { base, server } = await startServer();
  try {
    await fetch(`${base}/healthz`);
    await fetch(`${base}/api/plans`);
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const body = await res.text();
    assert.match(body, /# TYPE vpn_http_requests_total counter/);
    assert.match(body, /vpn_http_requests_total\{[^}]*route="\/healthz"[^}]*\} \d+/);
    assert.match(body, /# TYPE vpn_http_request_duration_ms histogram/);
    assert.match(body, /# TYPE vpn_subscriptions_active gauge/);
  } finally {
    server.close();
  }
});

test('rate limiting returns 429 with Retry-After after the limit', async () => {
  const { base, server } = await startServer({ enabled: true, max: 2, windowMs: 60_000 });
  try {
    assert.equal((await fetch(`${base}/api/plans`)).status, 200);
    assert.equal((await fetch(`${base}/api/plans`)).status, 200);
    const limited = await fetch(`${base}/api/plans`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(limited.headers.get('x-ratelimit-limit'), '2');

    // Exempt routes are never limited.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/metrics`)).status, 200);
  } finally {
    server.close();
  }
});

test('public routes are also served under the /api/v1 prefix', async () => {
  const { base, server } = await startServer();
  try {
    const v1 = await getJson(await fetch(`${base}/api/v1/plans`));
    assert.ok(Array.isArray(v1.plans) && v1.plans.length >= 1);

    // The full order flow works under /api/v1 too.
    const created = await getJson(await fetch(`${base}/api/v1/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' }),
    }));
    assert.equal(created.status, 'PENDING');
    const got = await getJson(await fetch(`${base}/api/v1/orders/${created.orderId}`));
    assert.equal(got.orderId, created.orderId);
  } finally {
    server.close();
  }
});

test('readiness probe reports ok with per-check detail', async () => {
  const { base, server } = await startServer();
  try {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 200);
    const body = await getJson(res);
    assert.equal(body.status, 'ok');
    assert.ok(Array.isArray(body.checks));
    assert.ok(body.checks.some((c: any) => c.name === 'core' && c.ok));
  } finally {
    server.close();
  }
});

test('version endpoint and X-API-Version header', async () => {
  const { base, server } = await startServer();
  try {
    const res = await fetch(`${base}/version`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-api-version'), 'v1');
    const body = await getJson(res);
    assert.equal(body.api, 'v1');
    assert.ok(typeof body.app === 'string');
    assert.deepEqual(body.supported, ['v1']);

    // The version header is applied to every response.
    assert.equal((await fetch(`${base}/healthz`)).headers.get('x-api-version'), 'v1');
  } finally {
    server.close();
  }
});

test('security headers and CORS are applied; OPTIONS is preflighted', async () => {
  const { base, server } = await startServer(); // default security has corsOrigins ['*']
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');

    const preflight = await fetch(`${base}/api/orders`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.ok(preflight.headers.get('access-control-allow-headers'));
  } finally {
    server.close();
  }
});

test('oversized request bodies are rejected with 413', async () => {
  const { base, server } = await startServer();
  try {
    const huge = 'x'.repeat(1_200_000); // exceeds the 1MB default limit
    const res = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat', pad: huge }),
    });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});

test('pricing quote converts between currencies and validates input', async () => {
  const { base, server } = await startServer();
  try {
    const q = await getJson(await fetch(`${base}/api/pricing/quote?amount=100000&from=CNY&to=USDT`));
    assert.equal(q.currency, 'USDT');
    assert.ok(Number.isInteger(q.amountMinor) && q.amountMinor > 0);
    assert.ok(typeof q.amountDisplay === 'string');
    assert.ok(q.rate > 0);

    assert.equal((await fetch(`${base}/api/pricing/quote?amount=-5&from=CNY&to=USDT`)).status, 400);
    assert.equal((await fetch(`${base}/api/pricing/quote?amount=100&from=CNY`)).status, 400);
    assert.equal((await fetch(`${base}/api/pricing/quote?amount=100&from=CNY&to=ZZZ`)).status, 400);
  } finally {
    server.close();
  }
});

test('maintenance sweep endpoint returns a removed count', async () => {
  const { base, server } = await startServer();
  try {
    const res = await fetch(`${base}/internal/maintenance/sweep`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(typeof (await getJson(res)).removed, 'number');
  } finally {
    server.close();
  }
});

test('serves the OpenAPI spec and Swagger UI docs', async () => {
  const { base, server } = await startServer();
  try {
    const spec = await getJson(await fetch(`${base}/openapi.json`));
    assert.equal(spec.openapi, '3.0.3');
    assert.ok(spec.paths['/api/orders']);
    assert.ok(spec.paths['/api/users/register']);

    const docs = await fetch(`${base}/docs`);
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get('content-type') ?? '', /text\/html/);
    const html = await docs.text();
    assert.match(html, /swagger-ui/);
    assert.match(html, /\/openapi\.json/);
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
