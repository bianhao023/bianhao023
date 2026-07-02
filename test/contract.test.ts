import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { buildContainerRouter } from '../src/api/server';
import { buildOpenApiSpec } from '../src/api/openapi';
import { PaymentMethod } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { FakeProvider } from './_helpers';

function config(): AppConfig {
  return {
    port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7,
    adminToken: 'x',
    rateLimit: { enabled: false, max: 100, windowMs: 60000 },
    security: { corsOrigins: [], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
  };
}

/** Normalize a router pattern (`:id`) to the OpenAPI style (`{id}`). */
const norm = (p: string) => p.replace(/:([^/]+)/g, '{$1}');

function routerOps(): Set<string> {
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const router = buildContainerRouter(buildContainer(config(), { providers }));
  const ops = new Set<string>();
  for (const r of router.listRoutes()) {
    if (r.pattern.startsWith('/api/v1/')) continue; // the v1 mirror is checked separately
    ops.add(`${r.method} ${norm(r.pattern)}`);
  }
  return ops;
}

function specOps(): { base: Set<string>; hasV1: (p: string) => boolean } {
  const spec = buildOpenApiSpec(['wechat', 'alipay', 'usdt']) as { paths: Record<string, Record<string, unknown>> };
  const base = new Set<string>();
  const v1 = new Set<string>();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) {
      const entry = `${method.toUpperCase()} ${path}`;
      if (path.startsWith('/api/v1/')) v1.add(entry);
      else base.add(entry);
    }
  }
  return { base, hasV1: (p) => v1.has(p) };
}

test('OpenAPI spec documents exactly the routes the router registers (no drift)', () => {
  const router = routerOps();
  const { base: spec } = specOps();

  const undocumented = [...router].filter((op) => !spec.has(op)).sort();
  const phantom = [...spec].filter((op) => !router.has(op)).sort();

  assert.deepEqual(undocumented, [], `routes missing from the OpenAPI spec: ${undocumented.join(', ')}`);
  assert.deepEqual(phantom, [], `spec documents routes that are not registered: ${phantom.join(', ')}`);
});

test('every /api/* operation is also documented under /api/v1/*', () => {
  const { base, hasV1 } = specOps();
  for (const op of base) {
    const [method, path] = op.split(' ');
    if (!path.startsWith('/api/')) continue;
    const v1 = `${method} ${path.replace('/api/', '/api/v1/')}`;
    assert.ok(hasV1(v1), `missing v1 mirror for ${op}`);
  }
});
