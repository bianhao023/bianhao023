import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { SqlClient } from '../src/storage/sql/sqlStore';
import { PingableRedis } from '../src/health/dependencyChecks';

const baseConfig: AppConfig = {
  port: 0,
  orderTtlMinutes: 15,
  enabledMethods: [],
  expiryReminderDays: 3,
  processedEventTtlDays: 7,
  shutdownTimeoutMs: 10000,
  rateLimit: { enabled: false, max: 100, windowMs: 60_000 },
  security: { corsOrigins: ['*'], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
};

/** A SQL client whose SELECT 1 succeeds or fails on demand. */
function fakeSql(fail = false): SqlClient {
  return {
    query: async () => {
      if (fail) throw new Error('connection refused');
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
  };
}

function fakeRedis(reply = 'PONG', fail = false): PingableRedis {
  return {
    ping: async () => {
      if (fail) throw new Error('redis down');
      return reply;
    },
  };
}

test('no injected clients -> readiness has only core (ok)', async () => {
  const container = buildContainer(baseConfig);
  const report = await container.readiness.run();
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.checks.map((c) => c.name), ['core']);
});

test('injected SQL + Redis clients add ping checks; all reachable -> ok', async () => {
  const container = buildContainer(baseConfig, {
    readinessSql: fakeSql(),
    readinessRedis: fakeRedis(),
  });
  const report = await container.readiness.run();
  assert.equal(report.status, 'ok');
  const names = report.checks.map((c) => c.name);
  assert.ok(names.includes('sql'));
  assert.ok(names.includes('redis'));
  const sql = report.checks.find((c) => c.name === 'sql');
  assert.equal(sql?.ok, true);
  assert.equal(sql?.critical, true);
  const redis = report.checks.find((c) => c.name === 'redis');
  assert.equal(redis?.ok, true);
  assert.equal(redis?.critical, false);
});

test('failing SQL ping degrades /readyz (critical)', async () => {
  const container = buildContainer(baseConfig, { readinessSql: fakeSql(true) });
  const report = await container.readiness.run();
  assert.equal(report.status, 'degraded');
  const sql = report.checks.find((c) => c.name === 'sql');
  assert.equal(sql?.ok, false);
  assert.equal(sql?.detail, 'connection refused');
});

test('failing Redis ping does NOT degrade /readyz (non-critical)', async () => {
  const container = buildContainer(baseConfig, { readinessRedis: fakeRedis('', true) });
  const report = await container.readiness.run();
  assert.equal(report.status, 'ok');
  const redis = report.checks.find((c) => c.name === 'redis');
  assert.equal(redis?.ok, false);
  assert.equal(redis?.detail, 'redis down');
});
