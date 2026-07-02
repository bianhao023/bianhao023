import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { createHttpServer } from '../src/api/server';
import { PaymentMethod } from '../src/domain/types';
import { PaymentProvider } from '../src/providers/provider';
import { FakeProvider } from './_helpers';

async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function start(): Promise<{ base: string; server: Server }> {
  const config: AppConfig = { port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7, shutdownTimeoutMs: 10000, rateLimit: { enabled: false, max: 100, windowMs: 60000 }, security: { corsOrigins: [], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true } };
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new FakeProvider('wechat')]]);
  const container = buildContainer(config, { providers });
  const server = createHttpServer(container);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}

const json = { 'Content-Type': 'application/json' };

test('register -> login -> me happy path', async () => {
  const { base, server } = await start();
  try {
    const reg = await fetch(`${base}/api/users/register`, {
      method: 'POST', headers: json, body: JSON.stringify({ email: 'u@y.com', password: 'password1', name: 'U' }),
    });
    assert.equal(reg.status, 201);
    const created = await getJson(reg);
    assert.equal(created.user.email, 'u@y.com');
    assert.ok(created.apiKey.startsWith('vpk_'));

    const login = await getJson(await fetch(`${base}/api/users/login`, {
      method: 'POST', headers: json, body: JSON.stringify({ email: 'u@y.com', password: 'password1' }),
    }));
    assert.equal(login.apiKey, created.apiKey);

    const me = await fetch(`${base}/api/users/me`, { headers: { Authorization: `Bearer ${login.apiKey}` } });
    assert.equal(me.status, 200);
    assert.equal((await getJson(me)).email, 'u@y.com');
  } finally {
    server.close();
  }
});

test('unauthenticated and wrong-key access to /me is 401', async () => {
  const { base, server } = await start();
  try {
    assert.equal((await fetch(`${base}/api/users/me`)).status, 401);
    assert.equal((await fetch(`${base}/api/users/me`, { headers: { Authorization: 'Bearer vpk_bad' } })).status, 401);
  } finally {
    server.close();
  }
});

test('duplicate registration and bad login return proper codes', async () => {
  const { base, server } = await start();
  try {
    const body = JSON.stringify({ email: 'd@y.com', password: 'password1' });
    assert.equal((await fetch(`${base}/api/users/register`, { method: 'POST', headers: json, body })).status, 201);
    assert.equal((await fetch(`${base}/api/users/register`, { method: 'POST', headers: json, body })).status, 400);
    const badLogin = await fetch(`${base}/api/users/login`, {
      method: 'POST', headers: json, body: JSON.stringify({ email: 'd@y.com', password: 'nope1234' }),
    });
    assert.equal(badLogin.status, 401);
  } finally {
    server.close();
  }
});

test('rotate-key invalidates the previous key', async () => {
  const { base, server } = await start();
  try {
    const reg = await getJson(await fetch(`${base}/api/users/register`, {
      method: 'POST', headers: json, body: JSON.stringify({ email: 'r@y.com', password: 'password1' }),
    }));
    const auth = { Authorization: `Bearer ${reg.apiKey}` };
    const rotated = await getJson(await fetch(`${base}/api/users/me/rotate-key`, { method: 'POST', headers: auth }));
    assert.notEqual(rotated.apiKey, reg.apiKey);

    assert.equal((await fetch(`${base}/api/users/me`, { headers: auth })).status, 401); // old key dead
    assert.equal((await fetch(`${base}/api/users/me`, { headers: { Authorization: `Bearer ${rotated.apiKey}` } })).status, 200);
  } finally {
    server.close();
  }
});
