import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics, Counter, Gauge, Histogram } from '../src/observability/metrics';

test('counter accumulates per label set and renders Prometheus format', () => {
  const c = new Counter('vpn_http_requests_total', 'help', ['method', 'code']);
  c.inc({ method: 'GET', code: '200' });
  c.inc({ method: 'GET', code: '200' }, 3);
  c.inc({ method: 'POST', code: '201' });
  const out = c.render();
  assert.match(out, /# TYPE vpn_http_requests_total counter/);
  assert.match(out, /vpn_http_requests_total\{method="GET",code="200"\} 4/);
  assert.match(out, /vpn_http_requests_total\{method="POST",code="201"\} 1/);
});

test('gauge set and reset', () => {
  const g = new Gauge('vpn_orders', 'help', ['status']);
  g.set({ status: 'PENDING' }, 5);
  g.set({ status: 'PENDING' }, 2); // overwrite
  assert.match(g.render(), /vpn_orders\{status="PENDING"\} 2/);
  g.reset();
  assert.ok(!/vpn_orders\{/.test(g.render()));
});

test('histogram renders cumulative buckets, sum and count', () => {
  const h = new Histogram('vpn_req_ms', 'help', ['route'], [10, 100]);
  h.observe({ route: '/x' }, 5); // <=10 and <=100
  h.observe({ route: '/x' }, 50); // <=100 only
  const out = h.render();
  assert.match(out, /vpn_req_ms_bucket\{route="\/x",le="10"\} 1/);
  assert.match(out, /vpn_req_ms_bucket\{route="\/x",le="100"\} 2/);
  assert.match(out, /vpn_req_ms_bucket\{route="\/x",le="\+Inf"\} 2/);
  assert.match(out, /vpn_req_ms_sum\{route="\/x"\} 55/);
  assert.match(out, /vpn_req_ms_count\{route="\/x"\} 2/);
});

test('Metrics.render invokes collectors and includes all series', async () => {
  const m = new Metrics();
  const reqs = m.counter('vpn_http_requests_total', 'requests', ['code']);
  const g = m.gauge('vpn_subscriptions_active', 'active subs');
  reqs.inc({ code: '200' });
  let collectorCalls = 0;
  m.addCollector(() => {
    collectorCalls++;
    g.set({}, 7);
  });
  const out = await m.render();
  assert.equal(collectorCalls, 1);
  assert.match(out, /vpn_http_requests_total\{code="200"\} 1/);
  assert.match(out, /vpn_subscriptions_active 7/);
  assert.ok(out.endsWith('\n'));
});

test('label values are escaped', () => {
  const c = new Counter('m', 'h', ['path']);
  c.inc({ path: 'a"b\\c' });
  assert.match(c.render(), /path="a\\"b\\\\c"/);
});
