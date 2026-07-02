import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlHealthCheck, redisHealthCheck, PingableRedis } from '../src/health/dependencyChecks';
import type { SqlClient } from '../src/storage/sql/sqlStore';

// A SQL client whose query resolves with a single `{ ok: 1 }` row.
const okSql: SqlClient = {
  query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }),
};

// A SQL client whose query always rejects.
const failingSql: SqlClient = {
  query: async () => {
    throw new Error('connection refused');
  },
};

test('sqlHealthCheck: ok path reports reachable', async () => {
  const check = sqlHealthCheck(okSql);
  const result = await check.run();

  assert.equal(result.ok, true);
  assert.match(result.detail ?? '', /^reachable/);
});

test('sqlHealthCheck: failure path returns error message as detail (no throw)', async () => {
  const check = sqlHealthCheck(failingSql);
  const result = await check.run();

  assert.equal(result.ok, false);
  assert.equal(result.detail, 'connection refused');
});

test('sqlHealthCheck: default name and critical', () => {
  const check = sqlHealthCheck(okSql);

  assert.equal(check.name, 'sql');
  assert.equal(check.critical, true);
});

test('sqlHealthCheck: custom opts override name and critical', () => {
  const check = sqlHealthCheck(okSql, { name: 'primary-db', critical: false });

  assert.equal(check.name, 'primary-db');
  assert.equal(check.critical, false);
});

test('redisHealthCheck: ok path (PONG) reports reachable', async () => {
  const client: PingableRedis = { ping: async () => 'PONG' };
  const check = redisHealthCheck(client);
  const result = await check.run();

  assert.equal(result.ok, true);
  assert.equal(result.detail, 'reachable');
});

test('redisHealthCheck: failure path returns error message as detail (no throw)', async () => {
  const client: PingableRedis = {
    ping: async () => {
      throw new Error('redis down');
    },
  };
  const check = redisHealthCheck(client);
  const result = await check.run();

  assert.equal(result.ok, false);
  assert.equal(result.detail, 'redis down');
});

test('redisHealthCheck: default name and critical', () => {
  const client: PingableRedis = { ping: async () => 'PONG' };
  const check = redisHealthCheck(client);

  assert.equal(check.name, 'redis');
  assert.equal(check.critical, false);
});

test('redisHealthCheck: custom opts override name and critical', () => {
  const client: PingableRedis = { ping: async () => 'PONG' };
  const check = redisHealthCheck(client, { name: 'cache', critical: true });

  assert.equal(check.name, 'cache');
  assert.equal(check.critical, true);
});
