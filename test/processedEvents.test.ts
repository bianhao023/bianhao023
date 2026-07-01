import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryProcessedEventStore } from '../src/storage/memoryStore';
import { SqlProcessedEventStore, SqlClient } from '../src/storage/sql/sqlStore';

test('memory store dedupes and sweeps expired records', async () => {
  const clock = { v: 1000 };
  const store = new MemoryProcessedEventStore(() => clock.v);

  assert.equal(await store.markIfNew('e1'), true);
  assert.equal(await store.markIfNew('e1'), false); // deduped

  // Nothing is old enough yet (record at t=1000, cutoff = 1000-500 = 500).
  assert.equal(await store.sweep(500), 0);

  clock.v = 2000; // advance; cutoff = 2000-500 = 1500, record at 1000 < 1500
  assert.equal(await store.sweep(500), 1);

  // After sweeping, the same event id can be processed again.
  assert.equal(await store.markIfNew('e1'), true);
});

test('SQL store records created_at on insert and sweeps by cutoff', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const fake: SqlClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/DELETE/i.test(sql)) return { rows: [], rowCount: 3 };
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new SqlProcessedEventStore(fake, () => 10_000);

  await store.markIfNew('evt-1');
  const insert = calls[0];
  assert.match(insert.sql, /INSERT INTO processed_events/);
  assert.deepEqual(insert.params, ['evt-1', 10_000]);

  const removed = await store.sweep(4_000);
  assert.equal(removed, 3);
  const del = calls[1];
  assert.match(del.sql, /DELETE FROM processed_events WHERE created_at < \$1/);
  assert.deepEqual(del.params, [10_000 - 4_000]); // cutoff = now - olderThanMs
});
