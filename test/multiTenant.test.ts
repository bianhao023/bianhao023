import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { createHttpServer } from '../src/api/server';
import { PaymentMethod } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { MerchantService } from '../src/services/merchantService';
import { MemoryMerchantRepository } from '../src/storage/memoryStore';
import { FakeProvider } from './_helpers';

process.env.LOG_LEVEL = 'silent';

async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

// ── MerchantService unit tests ──────────────────────────────────────────────

test('ensureDefault is idempotent and yields the default tenant', async () => {
  const svc = new MerchantService(new MemoryMerchantRepository());
  const a = await svc.ensureDefault();
  const b = await svc.ensureDefault();
  assert.equal(a.id, 'default');
  assert.equal(b.id, 'default');
  assert.equal(a.apiKey, b.apiKey); // not re-provisioned
});

test('authenticate accepts current + rotated (previous) key, rejects suspended', async () => {
  const svc = new MerchantService(new MemoryMerchantRepository());
  const m = await svc.create({ name: 'Acme' });
  assert.match(m.apiKey, /^mk_/);
  assert.equal((await svc.authenticate(m.apiKey))?.id, m.id);

  const rotated = await svc.rotateKey(m.id);
  assert.notEqual(rotated.apiKey, m.apiKey);
  assert.equal((await svc.authenticate(rotated.apiKey))?.id, m.id); // new key works
  assert.equal((await svc.authenticate(m.apiKey))?.id, m.id); // old key still in grace

  await svc.setStatus(m.id, 'suspended');
  assert.equal(await svc.authenticate(rotated.apiKey), undefined); // suspended → no auth
});

// ── End-to-end tenant isolation over HTTP ───────────────────────────────────

function startServer(): Promise<{ base: string; server: import('node:http').Server; container: ReturnType<typeof buildContainer> }> {
  const config: AppConfig = {
    port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7,
    shutdownTimeoutMs: 10000, adminToken: 'admin-secret',
    rateLimit: { enabled: false, max: 100, windowMs: 60_000 },
    security: { corsOrigins: ['*'], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
  };
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(config, { providers });
  const server = createHttpServer(container);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, container }));
  });
}

test('orders are isolated per tenant end-to-end', async () => {
  const { base, server, container } = await startServer();
  await container.merchants.ensureDefault();
  const admin = { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' };
  try {
    // Admin provisions two merchants and gets their keys.
    const a = await getJson(await fetch(`${base}/admin/merchants`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Merchant A' }) }));
    const b = await getJson(await fetch(`${base}/admin/merchants`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Merchant B' }) }));
    assert.match(a.apiKey, /^mk_/);
    assert.notEqual(a.id, b.id);

    const order = (headers: Record<string, string>) =>
      fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' }) });

    const oa = await getJson(await order({ 'X-Merchant-Key': a.apiKey }));
    const ob = await getJson(await order({ 'X-Merchant-Key': b.apiKey }));
    assert.equal(oa.status, 'PENDING');

    // Each merchant sees only its own order.
    const listA = await getJson(await fetch(`${base}/api/merchant/orders`, { headers: { 'X-Merchant-Key': a.apiKey } }));
    assert.equal(listA.total, 1);
    assert.equal(listA.items[0].orderId, oa.orderId);

    // Cross-tenant fetch is hidden (404), same-tenant works.
    assert.equal((await fetch(`${base}/api/orders/${oa.orderId}`, { headers: { 'X-Merchant-Key': b.apiKey } })).status, 404);
    assert.equal((await fetch(`${base}/api/orders/${oa.orderId}`, { headers: { 'X-Merchant-Key': a.apiKey } })).status, 200);

    // An invalid merchant key is rejected (no silent fallback to default).
    assert.equal((await order({ 'X-Merchant-Key': 'mk_bogus' })).status, 401);

    // Merchant-orders listing requires a key.
    assert.equal((await fetch(`${base}/api/merchant/orders`)).status, 401);

    // Suspending a merchant blocks its API access.
    await fetch(`${base}/admin/merchants/${a.id}/status`, { method: 'POST', headers: admin, body: JSON.stringify({ status: 'suspended' }) });
    assert.equal((await order({ 'X-Merchant-Key': a.apiKey })).status, 401);

    void ob;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('no merchant key → default tenant; admin can list merchants', async () => {
  const { base, server, container } = await startServer();
  await container.merchants.ensureDefault();
  const admin = { Authorization: 'Bearer admin-secret' };
  try {
    // Unscoped create still works (default tenant) — backward compatible.
    const created = await getJson(await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u1', planId: 'monthly', method: 'wechat' }) }));
    assert.equal(created.status, 'PENDING');

    const list = await getJson(await fetch(`${base}/admin/merchants`, { headers: admin }));
    assert.ok(list.items.some((m: any) => m.id === 'default'));
    // Public projection never leaks the API key.
    assert.ok(list.items.every((m: any) => m.apiKey === undefined));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
