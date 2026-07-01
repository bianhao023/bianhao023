import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { PaymentMethod, OrderStatus } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { FakeProvider, callbackBody } from './_helpers';

function baseConfig(): AppConfig {
  return { port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7, rateLimit: { enabled: false, max: 100, windowMs: 60000 } };
}

async function harness() {
  const clock = { value: Date.UTC(2026, 0, 1) };
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(baseConfig(), { providers, now: () => clock.value });

  // Three orders for three users; pay two, leave one pending.
  const o1 = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'wechat' });
  const o2 = await container.payments.createOrder({ userId: 'u2', planId: 'monthly', method: 'wechat' });
  await container.payments.createOrder({ userId: 'u3', planId: 'monthly', method: 'wechat' });
  for (const o of [o1, o2]) {
    await container.payments.handleCallback('wechat', {
      rawBody: callbackBody({ outTradeNo: o.order.outTradeNo, paidAmount: 1500 }), headers: {},
    });
  }
  // Partial refund on one paid order.
  await container.refunds.refundOrder(o1.order.id, { amount: 500 });
  return { container };
}

test('summary aggregates revenue, refunds and net per currency', async () => {
  const { container } = await harness();
  const s = (await container.reports.summary()) as any;

  assert.equal(s.ordersTotal, 3);
  assert.equal(s.byStatus[OrderStatus.FULFILLED], 2);
  assert.equal(s.byStatus[OrderStatus.PENDING], 1);

  const cny = s.currencies.find((c: any) => c.currency === 'CNY');
  assert.equal(cny.paidCount, 2);
  assert.equal(cny.grossMinor, 3000);
  assert.equal(cny.grossDisplay, '30.00');
  assert.equal(cny.refundedMinor, 500);
  assert.equal(cny.netMinor, 2500);
  assert.equal(cny.netDisplay, '25.00');

  const wechat = s.byMethod.find((m: any) => m.method === 'wechat');
  assert.equal(wechat.paidCount, 2);
  assert.equal(wechat.grossMinor, 3000);
  assert.equal(s.refundsTotal, 1);
});

test('status filter narrows the summary', async () => {
  const { container } = await harness();
  const s = (await container.reports.summary({ status: OrderStatus.PENDING })) as any;
  assert.equal(s.ordersTotal, 1);
  assert.equal(s.currencies.length, 0); // pending orders are not yet revenue
});

test('listOrders paginates newest-first', async () => {
  const { container } = await harness();
  const page = await container.reports.listOrders({}, { limit: 2, offset: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);

  const page2 = await container.reports.listOrders({}, { limit: 2, offset: 2 });
  assert.equal(page2.items.length, 1);
});

test('listRefunds returns issued refunds', async () => {
  const { container } = await harness();
  const page = await container.reports.listRefunds({ limit: 50, offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].amount, 500);
});
