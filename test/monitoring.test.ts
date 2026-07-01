import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

test('grafana dashboard is valid JSON and references our metrics', () => {
  const raw = readFileSync(join(ROOT, 'monitoring', 'grafana-dashboard.json'), 'utf8');
  const dash = JSON.parse(raw);
  assert.equal(dash.uid, 'vpn-payment-backend');
  assert.ok(Array.isArray(dash.panels) && dash.panels.length >= 5);
  // Every panel must have at least one target expression.
  for (const p of dash.panels) {
    assert.ok(Array.isArray(p.targets) && p.targets.length >= 1, `panel ${p.title} has targets`);
  }
  for (const metric of [
    'vpn_http_requests_total',
    'vpn_http_request_duration_ms_bucket',
    'vpn_orders',
    'vpn_subscriptions_active',
    'vpn_rate_limited_total',
  ]) {
    assert.ok(raw.includes(metric), `dashboard references ${metric}`);
  }
});

test('prometheus alert rules reference our metrics and define alerts', () => {
  const raw = readFileSync(join(ROOT, 'monitoring', 'prometheus-alerts.yml'), 'utf8');
  for (const alert of ['HighHttp5xxRate', 'HighRequestLatencyP95', 'RateLimitingSpike', 'PendingOrdersBacklog']) {
    assert.ok(raw.includes(`alert: ${alert}`), `defines ${alert}`);
  }
  assert.ok(raw.includes('vpn_http_requests_total'));
  assert.ok(raw.includes('vpn_http_request_duration_ms_bucket'));
});
