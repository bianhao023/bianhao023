import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAuditLog } from '../src/audit/auditLog';

/** A controllable clock whose value can be advanced explicitly. */
function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (d: number) => {
      t += d;
    },
  };
}

test('query returns all events newest-first with correct total', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now);

  c.set(100);
  await log.record({ action: 'login', actor: 'alice', subjectId: 'u1' });
  c.set(200);
  await log.record({ action: 'logout', actor: 'bob', subjectId: 'u2' });
  c.set(300);
  await log.record({ action: 'pay', actor: 'alice', subjectId: 'o1' });

  const { total, items } = await log.query();
  assert.equal(total, 3);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((e) => e.at),
    [300, 200, 100],
  );
});

test('tie-break on equal timestamps is insertion order desc', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now);

  c.set(500);
  await log.record({ action: 'a', actor: 'first' });
  await log.record({ action: 'b', actor: 'second' });
  await log.record({ action: 'c', actor: 'third' });

  const { items } = await log.query();
  assert.deepEqual(
    items.map((e) => e.actor),
    ['third', 'second', 'first'],
  );
});

test('filter by action, actor, subjectId each returns only matches', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now);

  c.set(10);
  await log.record({ action: 'login', actor: 'alice', subjectId: 'u1' });
  c.set(20);
  await log.record({ action: 'login', actor: 'bob', subjectId: 'u2' });
  c.set(30);
  await log.record({ action: 'pay', actor: 'alice', subjectId: 'o1' });

  const byAction = await log.query({ action: 'login' });
  assert.equal(byAction.total, 2);
  assert.ok(byAction.items.every((e) => e.action === 'login'));

  const byActor = await log.query({ actor: 'alice' });
  assert.equal(byActor.total, 2);
  assert.ok(byActor.items.every((e) => e.actor === 'alice'));

  const bySubject = await log.query({ subjectId: 'o1' });
  assert.equal(bySubject.total, 1);
  assert.equal(bySubject.items[0].action, 'pay');

  const combined = await log.query({ action: 'login', actor: 'alice' });
  assert.equal(combined.total, 1);
  assert.equal(combined.items[0].subjectId, 'u1');
});

test('time range [from, to) is inclusive of from, exclusive of to', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now);

  for (const at of [100, 200, 300, 400]) {
    await log.record({ action: 'evt', at });
  }

  const { total, items } = await log.query({ from: 200, to: 400 });
  assert.equal(total, 2);
  assert.deepEqual(
    items.map((e) => e.at),
    [300, 200],
  );

  // from is inclusive
  const fromOnly = await log.query({ from: 300 });
  assert.deepEqual(
    fromOnly.items.map((e) => e.at),
    [400, 300],
  );

  // to is exclusive
  const toOnly = await log.query({ to: 300 });
  assert.deepEqual(
    toOnly.items.map((e) => e.at),
    [200, 100],
  );
});

test('pagination slices correctly and total reflects full filtered count', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now);

  for (let i = 1; i <= 5; i++) {
    await log.record({ action: 'evt', at: i * 100 });
  }

  // Newest-first order of `at` is [500, 400, 300, 200, 100].
  const page1 = await log.query({ limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.deepEqual(
    page1.items.map((e) => e.at),
    [500, 400],
  );

  const page2 = await log.query({ limit: 2, offset: 2 });
  assert.equal(page2.total, 5);
  assert.deepEqual(
    page2.items.map((e) => e.at),
    [300, 200],
  );

  const page3 = await log.query({ limit: 2, offset: 4 });
  assert.equal(page3.total, 5);
  assert.deepEqual(
    page3.items.map((e) => e.at),
    [100],
  );
});

test('returned events are independent copies', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now);

  await log.record({ action: 'evt', actor: 'alice', at: 100, metadata: { count: 1 } });

  const first = await log.query();
  // Mutate the returned event and its nested metadata.
  first.items[0].actor = 'MUTATED';
  (first.items[0].metadata as Record<string, unknown>).count = 999;

  const second = await log.query();
  assert.equal(second.items[0].actor, 'alice');
  assert.deepEqual(second.items[0].metadata, { count: 1 });
});

test('record returns a copy that does not leak into stored state', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now);

  const meta: Record<string, unknown> = { n: 1 };
  const returned = await log.record({ action: 'evt', at: 50, metadata: meta });
  // Mutate both the caller's metadata object and the returned event.
  meta.n = 42;
  returned.action = 'CHANGED';

  const { items } = await log.query();
  assert.equal(items[0].action, 'evt');
  assert.deepEqual(items[0].metadata, { n: 1 });
});

test('maxEntries drops the oldest events', async () => {
  const c = clock();
  const log = new InMemoryAuditLog(c.now, 2);

  await log.record({ action: 'a', at: 1 });
  await log.record({ action: 'b', at: 2 });
  await log.record({ action: 'c', at: 3 });

  const { total, items } = await log.query();
  assert.equal(total, 2);
  assert.deepEqual(
    items.map((e) => e.action),
    ['c', 'b'],
  );
});
