import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig, WebhookConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { PaymentMethod, OrderStatus, Order } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { formatReconciliationAlert } from '../src/alerting/alertFormatter';
import { FakeProvider, MockHttpClient } from './_helpers';

const WEBHOOK: WebhookConfig = { url: 'https://merchant.example/hook', secret: 'shh', maxAttempts: 3 };

function cfg(): AppConfig {
  return {
    port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7, shutdownTimeoutMs: 10000,
    rateLimit: { enabled: false, max: 100, windowMs: 60000 },
    security: { corsOrigins: [], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
    webhook: WEBHOOK,
  };
}

function badOrder(): Order {
  const now = Date.UTC(2026, 0, 1);
  // Over-refunded + ledger mismatch (refundedAmount > amount, no refunds recorded).
  return {
    id: 'bad1', outTradeNo: 'T-bad1', userId: 'u1', planId: 'monthly', method: 'wechat',
    currency: 'CNY', amount: 1000, status: OrderStatus.REFUNDED, refundedAmount: 5000,
    createdAt: now, updatedAt: now, expiresAt: now + 1000, paidAt: now, metadata: {},
  };
}

test('reconciliation discrepancies dispatch a critical alert to the webhook', async () => {
  const clock = { v: Date.UTC(2026, 0, 2) };
  const http = new MockHttpClient(() => ({ status: 200, body: 'ok' }));
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(cfg(), { providers, httpClient: http, now: () => clock.v });

  await container.orders.create(badOrder());

  const report = await container.reconciliation.run();
  const alert = formatReconciliationAlert(report);
  assert.ok(alert, 'expected an alert');
  assert.equal(alert!.severity, 'critical');

  await container.alertSink(alert!);
  const result = await container.webhooks!.processDue();
  assert.equal(result.delivered, 1);

  const sent = http.requests.find((r) => r.url === WEBHOOK.url)!;
  assert.equal(sent.headers!['X-Webhook-Event'], 'reconciliation.alert');
  assert.match(sent.body!, /over_refunded/);
});

test('alertSink is a no-op path (log only) when webhooks are not configured', async () => {
  const noWebhook = { ...cfg(), webhook: undefined };
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(noWebhook, { providers });
  // Should resolve without throwing even though there is no webhook dispatcher.
  await container.alertSink({ severity: 'warning', title: 't', summary: 's', details: [] });
  assert.equal(container.webhooks, undefined);
});
