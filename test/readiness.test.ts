import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessAggregator, HealthCheck, CheckResult } from '../src/health/readiness';

test('all checks ok -> status ok, all rows ok', async () => {
  const checks: HealthCheck[] = [
    { name: 'db', critical: true, run: () => ({ ok: true }) },
    { name: 'cache', run: async () => ({ ok: true, detail: 'warm' }) },
  ];
  const report = await new ReadinessAggregator(checks).run();

  assert.equal(report.status, 'ok');
  assert.equal(report.checks.length, 2);
  assert.ok(report.checks.every((c) => c.ok));
});

test('non-critical failing check keeps overall status ok', async () => {
  const checks: HealthCheck[] = [
    { name: 'db', critical: true, run: () => ({ ok: true }) },
    { name: 'metrics', run: () => ({ ok: false, detail: 'scrape failed' }) },
  ];
  const report = await new ReadinessAggregator(checks).run();

  assert.equal(report.status, 'ok');
  const metrics = report.checks.find((c) => c.name === 'metrics');
  assert.equal(metrics?.ok, false);
  assert.equal(metrics?.critical, false);
  assert.equal(metrics?.detail, 'scrape failed');
});

test('critical failing check (and a thrower) -> degraded with error message detail', async () => {
  const checks: HealthCheck[] = [
    { name: 'db', critical: true, run: () => ({ ok: false, detail: 'no connection' }) },
    {
      name: 'queue',
      critical: true,
      run: () => {
        throw new Error('boom');
      },
    },
  ];
  const report = await new ReadinessAggregator(checks).run();

  assert.equal(report.status, 'degraded');
  const queue = report.checks.find((c) => c.name === 'queue');
  assert.equal(queue?.ok, false);
  assert.equal(queue?.detail, 'boom');
});

test('check that never settles is reported as timeout', async () => {
  const checks: HealthCheck[] = [
    { name: 'stuck', critical: true, run: () => new Promise<CheckResult>(() => {}) },
  ];
  const report = await new ReadinessAggregator(checks, { timeoutMs: 20 }).run();

  assert.equal(report.status, 'degraded');
  const stuck = report.checks[0];
  assert.equal(stuck.ok, false);
  assert.equal(stuck.detail, 'timeout');
});

test('report rows preserve input order', async () => {
  const names = ['a', 'b', 'c', 'd'];
  const checks: HealthCheck[] = names.map((name) => ({ name, run: () => ({ ok: true }) }));
  const report = await new ReadinessAggregator(checks).run();

  assert.deepEqual(report.checks.map((c) => c.name), names);
});
