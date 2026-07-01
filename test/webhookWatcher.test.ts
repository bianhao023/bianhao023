import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebhookConfig } from '../src/config';
import { MemoryWebhookRepository, WebhookDispatcher } from '../src/webhooks/outbound';
import { WebhookWatcher } from '../src/webhooks/webhookWatcher';
import { Alert } from '../src/alerting/alertFormatter';
import { MockHttpClient } from './_helpers';

// maxAttempts 1 so a single failed delivery dead-letters immediately.
const CFG: WebhookConfig = { url: 'https://merchant.example/hook', secret: 'shh', maxAttempts: 1 };

test('watcher raises a dead-letter alert when the DLQ grows, once per depth', async () => {
  const clock = { v: 1000 };
  const http = new MockHttpClient(() => ({ status: 500, body: 'err' }));
  const disp = new WebhookDispatcher(new MemoryWebhookRepository(), http, CFG, () => clock.v, () => 1000);
  const alerts: Alert[] = [];
  const watcher = new WebhookWatcher(disp, 15_000, (a) => alerts.push(a));

  await disp.enqueue('order.fulfilled', { orderId: 'o1' });

  await watcher.runOnce(); // delivers -> 500 -> dead; DLQ depth 1 -> alert
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
  assert.match(alerts[0].summary, /1 webhook/);

  await watcher.runOnce(); // depth still 1 -> no repeat alert
  assert.equal(alerts.length, 1);
});

test('no alert while the queue stays empty', async () => {
  const clock = { v: 1000 };
  const http = new MockHttpClient(() => ({ status: 200, body: 'ok' }));
  const disp = new WebhookDispatcher(new MemoryWebhookRepository(), http, CFG, () => clock.v, () => 1000);
  const alerts: Alert[] = [];
  const watcher = new WebhookWatcher(disp, 15_000, (a) => alerts.push(a));

  await disp.enqueue('order.fulfilled', { orderId: 'o1' }); // delivers 200 -> no DLQ
  await watcher.runOnce();
  assert.equal(alerts.length, 0);
});
