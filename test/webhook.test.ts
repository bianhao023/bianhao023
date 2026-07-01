import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig, WebhookConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { PaymentMethod, OrderStatus } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import {
  MemoryWebhookRepository,
  WebhookDispatcher,
  signPayload,
} from '../src/webhooks/outbound';
import { FakeProvider, MockHttpClient, callbackBody } from './_helpers';

const CFG: WebhookConfig = { url: 'https://merchant.example/hook', secret: 'shh', maxAttempts: 3 };

function dispatcher(responder: () => { status: number; body: string }, clock: { v: number }) {
  const http = new MockHttpClient(responder);
  const repo = new MemoryWebhookRepository();
  const disp = new WebhookDispatcher(repo, http, CFG, () => clock.v, () => 1000);
  return { http, repo, disp };
}

test('signPayload is stable and tamper-evident', () => {
  const a = signPayload('secret', '1000', '{"x":1}');
  assert.equal(a, signPayload('secret', '1000', '{"x":1}'));
  assert.match(a, /^sha256=[0-9a-f]{64}$/);
  assert.notEqual(a, signPayload('secret', '1000', '{"x":2}'));
  assert.notEqual(a, signPayload('other', '1000', '{"x":1}'));
});

test('successful delivery marks the record delivered and signs the request', async () => {
  const clock = { v: 1000 };
  const { http, disp } = dispatcher(() => ({ status: 200, body: 'ok' }), clock);
  const d = await disp.enqueue('order.fulfilled', { orderId: 'o1' });
  assert.equal(d.status, 'pending');

  const done = await disp.deliver(d);
  assert.equal(done.status, 'delivered');
  assert.equal(done.attempts, 1);

  const req = http.requests[0];
  assert.equal(req.url, CFG.url);
  assert.equal(req.headers!['X-Webhook-Event'], 'order.fulfilled');
  assert.match(req.headers!['X-Webhook-Signature'], /^sha256=/);
  // Signature must match the exact sent body + timestamp.
  const expected = signPayload(CFG.secret, req.headers!['X-Webhook-Timestamp'], req.body!);
  assert.equal(req.headers!['X-Webhook-Signature'], expected);
  assert.match(req.body!, /"orderId":"o1"/);
});

test('failures retry with backoff, then dead-letter after maxAttempts', async () => {
  const clock = { v: 1000 };
  const { disp, repo } = dispatcher(() => ({ status: 500, body: 'err' }), clock);
  const d = await disp.enqueue('order.fulfilled', { orderId: 'o1' });

  const a1 = await disp.deliver(d);
  assert.equal(a1.status, 'pending');
  assert.equal(a1.attempts, 1);
  assert.equal(a1.lastStatus, 500);
  assert.equal(a1.nextAttemptAt, 1000 + 1000); // now + injected backoff

  const a2 = await disp.deliver(await repo.findById(d.id) as never);
  assert.equal(a2.status, 'pending');
  assert.equal(a2.attempts, 2);

  const a3 = await disp.deliver(await repo.findById(d.id) as never);
  assert.equal(a3.status, 'dead'); // 3rd attempt == maxAttempts
  assert.equal(a3.attempts, 3);
});

test('processDue drains due deliveries and skips future ones', async () => {
  const clock = { v: 1000 };
  const { disp, repo } = dispatcher(() => ({ status: 200, body: 'ok' }), clock);
  const due = await disp.enqueue('order.fulfilled', { orderId: 'due' });
  const future = await disp.enqueue('order.fulfilled', { orderId: 'future' });
  // Push the second one into the future.
  await repo.update({ ...(await repo.findById(future.id))!, nextAttemptAt: clock.v + 60_000 });

  const result = await disp.processDue();
  assert.equal(result.delivered, 1);
  assert.equal((await repo.findById(due.id))!.status, 'delivered');
  assert.equal((await repo.findById(future.id))!.status, 'pending'); // untouched
});

test('retry requeues a dead delivery for immediate delivery', async () => {
  const clock = { v: 1000 };
  let fail = true;
  const { disp, repo } = dispatcher(() => (fail ? { status: 500, body: 'e' } : { status: 200, body: 'ok' }), clock);
  const d = await disp.enqueue('order.fulfilled', { orderId: 'o1' });
  for (let i = 0; i < 3; i++) await disp.deliver((await repo.findById(d.id))!);
  assert.equal((await repo.findById(d.id))!.status, 'dead');

  fail = false;
  const requeued = await disp.retry(d.id);
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.nextAttemptAt, clock.v);
  const result = await disp.processDue();
  assert.equal(result.delivered, 1);
});

// ── container integration ──────────────────────────────────────────────────

function cfg(): AppConfig {
  return {
    port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3,
    rateLimit: { enabled: false, max: 100, windowMs: 60000 }, webhook: CFG,
  };
}

test('fulfilling an order enqueues and delivers an outbound webhook', async () => {
  const clock = { v: Date.UTC(2026, 0, 1) };
  const http = new MockHttpClient(() => ({ status: 200, body: 'ok' }));
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(cfg(), { providers, httpClient: http, now: () => clock.v });

  const { order } = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  await container.payments.handleCallback('wechat', {
    rawBody: callbackBody({ outTradeNo: order.outTradeNo, paidAmount: 1500 }), headers: {},
  });
  assert.equal((await container.payments.getOrder(order.id))?.status, OrderStatus.FULFILLED);

  const result = await container.webhooks!.processDue();
  assert.equal(result.delivered, 1);
  const delivered = await container.webhooks!.list('delivered', 50, 0);
  assert.equal(delivered.total, 1);
  const sent = http.requests.find((r) => r.url === CFG.url)!;
  assert.match(sent.body!, new RegExp(`"orderId":"${order.id}"`));
  assert.equal(sent.headers!['X-Webhook-Event'], 'order.fulfilled');
});
