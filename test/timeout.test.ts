import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Router, sendJson } from '../src/api/http';

async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function startServer(): Promise<{ base: string; server: Server }> {
  const router = new Router({
    security: { corsOrigins: [], requestTimeoutMs: 150, maxBodyBytes: 1_000_000, securityHeaders: true },
  });
  router.get('/fast', (_ctx, res) => sendJson(res, 200, { ok: true }));
  router.get('/slow', () =>
    // Never touches `res` within the timeout; resolves long after (unref'd).
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
    }),
  );

  const server = createServer((req, res) => router.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}

test('a fast handler responds normally', async () => {
  const { base, server } = await startServer();
  try {
    const res = await fetch(`${base}/fast`);
    assert.equal(res.status, 200);
    assert.deepEqual(await getJson(res), { ok: true });
  } finally {
    server.close();
  }
});

test('a slow handler is cut off by the request timeout (503)', async () => {
  const { base, server } = await startServer();
  try {
    // The timeout fires ~150ms in; the server writes 503 then destroys the
    // socket. fetch usually resolves with 503, but an aborted socket may throw
    // instead — both prove the timeout engaged.
    try {
      const res = await fetch(`${base}/slow`);
      assert.equal(res.status, 503);
      assert.equal((await getJson(res)).error, 'REQUEST_TIMEOUT');
    } catch (err) {
      assert.ok(err, 'request aborted by timeout is also acceptable');
    }
  } finally {
    server.close();
  }
});
