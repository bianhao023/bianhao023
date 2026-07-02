process.env.LOG_LEVEL = 'silent';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Secret } from '../src/secrets/secretProvider';
import { CachingSecretProvider, RemoteSecretSource } from '../src/secrets/cachingSecretProvider';

/** Let fire-and-forget background refreshes settle. */
const tick = () => new Promise((r) => setImmediate(r));

/** Fake remote source with a call counter and a mutable value table. */
class FakeSource implements RemoteSecretSource {
  calls = 0;
  constructor(private values: Record<string, Secret | undefined> = {}) {}
  set(name: string, value: Secret | undefined): void {
    this.values[name] = value;
  }
  async fetch(name: string): Promise<Secret | undefined> {
    this.calls += 1;
    return this.values[name];
  }
}

/** A source that always rejects, counting attempts. */
class RejectingSource implements RemoteSecretSource {
  calls = 0;
  async fetch(_name: string): Promise<Secret | undefined> {
    this.calls += 1;
    throw new Error('boom');
  }
}

test('prime populates the cache so get/getRotating are synchronous hits', async () => {
  const source = new FakeSource({
    API_KEY: { current: 'a1' },
    JWT: { current: 'j1', previous: 'j0' },
  });
  const provider = new CachingSecretProvider(source);

  await provider.prime(['API_KEY', 'JWT', 'MISSING']);

  assert.equal(provider.get('API_KEY'), 'a1');
  assert.deepEqual(provider.getRotating('JWT'), { current: 'j1', previous: 'j0' });
  // Missing names are skipped, not cached.
  assert.equal(provider.get('MISSING'), undefined);
});

test('cache miss returns undefined synchronously but triggers a background fetch', async () => {
  const source = new FakeSource({ API_KEY: { current: 'a1' } });
  const provider = new CachingSecretProvider(source);

  // First read: not cached yet.
  assert.equal(provider.get('API_KEY'), undefined);

  // After the fire-and-forget settles, the value is present.
  await tick();
  assert.equal(provider.get('API_KEY'), 'a1');
  assert.equal(source.calls, 1);
});

test('concurrent misses for the same name cause exactly one fetch (dedupe)', async () => {
  const source = new FakeSource({ API_KEY: { current: 'a1' } });
  const provider = new CachingSecretProvider(source);

  // Fire many synchronous misses before any fetch resolves.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(provider.get('API_KEY'), undefined);
  }

  await tick();
  assert.equal(source.calls, 1);
  assert.equal(provider.get('API_KEY'), 'a1');
});

test('TTL expiry serves stale value immediately then refreshes for next call', async () => {
  let clock = 1_000;
  const source = new FakeSource({ API_KEY: { current: 'v1' } });
  const provider = new CachingSecretProvider(source, { ttlMs: 100, now: () => clock });

  await provider.prime(['API_KEY']);
  assert.equal(provider.get('API_KEY'), 'v1');
  assert.equal(source.calls, 1);

  // Rotate the underlying value and advance past the TTL.
  source.set('API_KEY', { current: 'v2' });
  clock += 200;

  // Stale-while-revalidate: OLD value served immediately, refresh kicked off.
  assert.equal(provider.get('API_KEY'), 'v1');
  await tick();
  assert.equal(source.calls, 2);

  // Next call sees the refreshed value.
  assert.equal(provider.get('API_KEY'), 'v2');
});

test('getRotating returns previous when the source provides it', async () => {
  const source = new FakeSource({ JWT: { current: 'j1', previous: 'j0' } });
  const provider = new CachingSecretProvider(source);

  await provider.prime(['JWT']);
  assert.deepEqual(provider.getRotating('JWT'), { current: 'j1', previous: 'j0' });
});

test('a rejecting source does not throw to the caller and leaves the cache absent', async () => {
  const source = new RejectingSource();
  const provider = new CachingSecretProvider(source);

  // Background path swallows the rejection.
  assert.equal(provider.get('API_KEY'), undefined);
  await tick();
  assert.equal(provider.get('API_KEY'), undefined);

  // prime must not reject even though the source rejects.
  await assert.doesNotReject(() => provider.prime(['API_KEY']));

  // Repeated concurrent failing refreshes are deduped: fire several, expect one fetch.
  const before = source.calls;
  const results = await Promise.all([
    provider.prime(['API_KEY']),
    provider.prime(['API_KEY']),
    provider.prime(['API_KEY']),
  ]);
  assert.deepEqual(results, [undefined, undefined, undefined]);
  assert.equal(source.calls - before, 1);
  assert.equal(provider.get('API_KEY'), undefined);
});
