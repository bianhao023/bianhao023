import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Router, sendJson } from '../src/api/http';

async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function serve(build: (r: Router) => void): Promise<{ base: string; server: Server }> {
  const router = new Router({
    security: { corsOrigins: [], requestTimeoutMs: 5000, maxBodyBytes: 1_000_000, securityHeaders: true },
  });
  build(router);
  const server = createServer((req, res) => router.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}

test('aliasPrefix mirrors routes (including path params) under a new prefix', async () => {
  const { base, server } = await serve((r) => {
    r.get('/api/thing/:id', (ctx, res) => sendJson(res, 200, { id: ctx.params['id'] }));
    r.aliasPrefix('/api', '/api/v1');
  });
  try {
    assert.deepEqual(await getJson(await fetch(`${base}/api/thing/42`)), { id: '42' });
    assert.deepEqual(await getJson(await fetch(`${base}/api/v1/thing/42`)), { id: '42' });
  } finally {
    server.close();
  }
});

test('markDeprecated adds Deprecation and Sunset headers', async () => {
  const { base, server } = await serve((r) => {
    r.get('/api/old', (_ctx, res) => sendJson(res, 200, { ok: true }));
    r.get('/api/new', (_ctx, res) => sendJson(res, 200, { ok: true }));
    r.markDeprecated('/api/old', 'Wed, 01 Jan 2027 00:00:00 GMT');
  });
  try {
    const oldRes = await fetch(`${base}/api/old`);
    assert.equal(oldRes.headers.get('deprecation'), 'true');
    assert.equal(oldRes.headers.get('sunset'), 'Wed, 01 Jan 2027 00:00:00 GMT');

    const newRes = await fetch(`${base}/api/new`);
    assert.equal(newRes.headers.get('deprecation'), null);
  } finally {
    server.close();
  }
});
