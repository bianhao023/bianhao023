process.env.LOG_LEVEL = 'silent';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryDepositAddressRepository,
  MemorySweepJobRepository,
} from '../src/storage/memoryStore';
import {
  rowToDepositAddress,
  rowToSweepJob,
  SqlDepositAddressRepository,
  SqlSweepJobRepository,
} from '../src/storage/sql/sqlDepositStore';
import { SqlClient } from '../src/storage/sql/sqlStore';
import { DepositAddress, SweepJob, SweepStatus } from '../src/domain/deposit';

function depositAddr(overrides: Partial<DepositAddress> = {}): DepositAddress {
  return { index: 1, address: 'Taddr1', orderId: 'o1', createdAt: 1000, ...overrides };
}

function sweepJob(overrides: Partial<SweepJob> = {}): SweepJob {
  return {
    id: 'j1', orderId: 'o1', depositIndex: 1, depositAddress: 'Taddr1',
    collectionAddress: 'Tcollect', amountMicro: 0, status: SweepStatus.PENDING,
    attempts: 0, createdAt: 1000, updatedAt: 1000, nextAttemptAt: 1000, ...overrides,
  };
}

/** A hand-written fake SqlClient: queue results and record the last SQL + params. */
class FakeSqlClient implements SqlClient {
  lastSql = '';
  lastParams: unknown[] | undefined;
  private queue: Array<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> = [];

  enqueue(rows: Array<Record<string, unknown>>, rowCount: number | null = rows.length): this {
    this.queue.push({ rows, rowCount });
    return this;
  }

  async query(sql: string, params?: unknown[]) {
    this.lastSql = sql;
    this.lastParams = params;
    return this.queue.shift() ?? { rows: [], rowCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Memory repositories
// ---------------------------------------------------------------------------

test('memory nextIndex increments 1,2,3', async () => {
  const repo = new MemoryDepositAddressRepository();
  assert.equal(await repo.nextIndex(), 1);
  assert.equal(await repo.nextIndex(), 2);
  assert.equal(await repo.nextIndex(), 3);
});

test('memory deposit save + findByOrderId + findByAddress round-trip', async () => {
  const repo = new MemoryDepositAddressRepository();
  const rec = depositAddr();
  const saved = await repo.save(rec);
  assert.deepEqual(saved, rec);

  const byOrder = await repo.findByOrderId('o1');
  assert.deepEqual(byOrder, rec);
  const byAddr = await repo.findByAddress('Taddr1');
  assert.deepEqual(byAddr, rec);
  assert.equal(await repo.findByOrderId('missing'), undefined);
  assert.equal(await repo.findByAddress('missing'), undefined);
});

test('memory deposit save deep-clones (no aliasing)', async () => {
  const repo = new MemoryDepositAddressRepository();
  const rec = depositAddr();
  await repo.save(rec);
  rec.address = 'mutated';
  const fetched = await repo.findByOrderId('o1');
  assert.equal(fetched?.address, 'Taddr1');
});

test('memory duplicate-order and duplicate-address save throws', async () => {
  const repo = new MemoryDepositAddressRepository();
  await repo.save(depositAddr({ orderId: 'o1', address: 'Taddr1' }));
  await assert.rejects(() => repo.save(depositAddr({ orderId: 'o1', address: 'TaddrX' })));
  await assert.rejects(() => repo.save(depositAddr({ orderId: 'oX', address: 'Taddr1' })));
});

test('memory sweep create/findById/findByOrderId/update round-trip', async () => {
  const repo = new MemorySweepJobRepository();
  const job = sweepJob();
  const created = await repo.create(job);
  assert.deepEqual(created, job);

  assert.deepEqual(await repo.findById('j1'), job);
  assert.deepEqual(await repo.findByOrderId('o1'), job);
  assert.equal(await repo.findById('nope'), undefined);

  const updated = sweepJob({ status: SweepStatus.SWEPT, sweepTxId: 'tx9', attempts: 2, updatedAt: 2000 });
  await repo.update(updated);
  const fetched = await repo.findById('j1');
  assert.equal(fetched?.status, SweepStatus.SWEPT);
  assert.equal(fetched?.sweepTxId, 'tx9');
  assert.equal(fetched?.attempts, 2);

  await assert.rejects(() => repo.update(sweepJob({ id: 'unknown' })));
});

test('memory due returns non-terminal, nextAttemptAt<=now, oldest-first, respects limit', async () => {
  const repo = new MemorySweepJobRepository();
  await repo.create(sweepJob({ id: 'a', orderId: 'oa', status: SweepStatus.PENDING, createdAt: 100, nextAttemptAt: 50 }));
  await repo.create(sweepJob({ id: 'b', orderId: 'ob', status: SweepStatus.GAS_FUELING, createdAt: 50, nextAttemptAt: 50 }));
  await repo.create(sweepJob({ id: 'c', orderId: 'oc', status: SweepStatus.SWEPT, createdAt: 10, nextAttemptAt: 50 }));
  await repo.create(sweepJob({ id: 'd', orderId: 'od', status: SweepStatus.PENDING, createdAt: 20, nextAttemptAt: 999 }));

  const due = await repo.due(100, 10);
  assert.deepEqual(due.map((j) => j.id), ['b', 'a']); // c terminal, d not yet due; oldest first

  const limited = await repo.due(100, 1);
  assert.deepEqual(limited.map((j) => j.id), ['b']);
});

// ---------------------------------------------------------------------------
// SQL repositories
// ---------------------------------------------------------------------------

test('SQL nextIndex reads nextval sequence', async () => {
  const db = new FakeSqlClient().enqueue([{ idx: '7' }]);
  const repo = new SqlDepositAddressRepository(db);
  const idx = await repo.nextIndex();
  assert.equal(idx, 7);
  assert.equal(typeof idx, 'number');
  assert.match(db.lastSql, /nextval\('deposit_address_index_seq'\)/);
});

test('SQL deposit save issues INSERT with positional params and returns record', async () => {
  const db = new FakeSqlClient().enqueue([]);
  const repo = new SqlDepositAddressRepository(db);
  const rec = depositAddr({ index: 5, address: 'Tabc', orderId: 'o5', createdAt: 42 });
  const saved = await repo.save(rec);
  assert.deepEqual(saved, rec);
  assert.match(db.lastSql, /INSERT INTO deposit_addresses/);
  assert.deepEqual(db.lastParams, [5, 'Tabc', 'o5', 42]);
});

test('SQL deposit findByOrderId / findByAddress map rows', async () => {
  const row = { index: '3', address: 'Tzz', order_id: 'o3', created_at: '99' };
  const db = new FakeSqlClient().enqueue([row]).enqueue([row]).enqueue([]);
  const repo = new SqlDepositAddressRepository(db);

  const byOrder = await repo.findByOrderId('o3');
  assert.deepEqual(byOrder, { index: 3, address: 'Tzz', orderId: 'o3', createdAt: 99 });
  assert.deepEqual(db.lastParams, ['o3']);

  const byAddr = await repo.findByAddress('Tzz');
  assert.equal(byAddr?.index, 3);

  assert.equal(await repo.findByOrderId('none'), undefined);
});

test('SQL sweep create/findById/findByOrderId/update round-trip', async () => {
  const job = sweepJob({ gasTxId: 'g1', sweepTxId: undefined, lastError: undefined });
  const row = {
    id: 'j1', order_id: 'o1', deposit_index: '1', deposit_address: 'Taddr1',
    collection_address: 'Tcollect', amount_micro: '0', status: 'PENDING',
    gas_tx_id: 'g1', sweep_tx_id: null, attempts: '0', last_error: null,
    created_at: '1000', updated_at: '1000', next_attempt_at: '1000',
  };
  const db = new FakeSqlClient().enqueue([]).enqueue([row]).enqueue([row]).enqueue([]);
  const repo = new SqlSweepJobRepository(db);

  const created = await repo.create(job);
  assert.deepEqual(created, job);
  assert.match(db.lastSql, /INSERT INTO sweep_jobs/);
  assert.equal((db.lastParams ?? [])[7], 'g1'); // gas_tx_id
  assert.equal((db.lastParams ?? [])[8], null); // sweep_tx_id -> null

  const byId = await repo.findById('j1');
  assert.equal(byId?.gasTxId, 'g1');
  assert.equal(byId?.sweepTxId, undefined);

  const byOrder = await repo.findByOrderId('o1');
  assert.equal(byOrder?.orderId, 'o1');

  const updated = sweepJob({ status: SweepStatus.SWEEPING, sweepTxId: 'sx', attempts: 1, updatedAt: 2000, nextAttemptAt: 3000 });
  await repo.update(updated);
  assert.match(db.lastSql, /UPDATE sweep_jobs SET/);
  assert.equal((db.lastParams ?? [])[0], 'j1'); // WHERE id=$1
  assert.equal((db.lastParams ?? [])[10], 2000); // updated_at=$11
  assert.equal((db.lastParams ?? [])[11], 3000); // next_attempt_at=$12
});

test('SQL due filters by status/next_attempt_at and passes limit', async () => {
  const row = {
    id: 'a', order_id: 'oa', deposit_index: '1', deposit_address: 'Taddr1',
    collection_address: 'Tcollect', amount_micro: '0', status: 'PENDING',
    gas_tx_id: null, sweep_tx_id: null, attempts: '0', last_error: null,
    created_at: '10', updated_at: '10', next_attempt_at: '5',
  };
  const db = new FakeSqlClient().enqueue([row]);
  const repo = new SqlSweepJobRepository(db);
  const due = await repo.due(100, 25);
  assert.equal(due.length, 1);
  assert.match(db.lastSql, /status IN \('PENDING','GAS_FUELING','SWEEPING'\)/);
  assert.match(db.lastSql, /ORDER BY created_at ASC/);
  assert.deepEqual(db.lastParams, [100, 25]);
});

test('SQL all orders by created_at ASC', async () => {
  const db = new FakeSqlClient().enqueue([]);
  const repo = new SqlSweepJobRepository(db);
  await repo.all();
  assert.match(db.lastSql, /SELECT \* FROM sweep_jobs ORDER BY created_at ASC/);
});

test('rowToDepositAddress coerces numeric columns', () => {
  const d = rowToDepositAddress({ index: '12', address: 'Tx', order_id: 'o1', created_at: '345' });
  assert.equal(d.index, 12);
  assert.equal(typeof d.index, 'number');
  assert.equal(d.createdAt, 345);
});

test('rowToSweepJob maps NULL optionals to undefined and coerces numerics', () => {
  const j = rowToSweepJob({
    id: 'j1', order_id: 'o1', deposit_index: '4', deposit_address: 'Taddr1',
    collection_address: 'Tcollect', amount_micro: '2000000', status: 'GAS_FUELING',
    gas_tx_id: null, sweep_tx_id: null, attempts: '3', last_error: null,
    created_at: '1000', updated_at: '2000', next_attempt_at: '3000',
  });
  assert.equal(j.gasTxId, undefined);
  assert.equal(j.sweepTxId, undefined);
  assert.equal(j.lastError, undefined);
  assert.equal(j.depositIndex, 4);
  assert.equal(j.amountMicro, 2000000);
  assert.equal(j.attempts, 3);
  assert.equal(typeof j.attempts, 'number');
  assert.equal(j.nextAttemptAt, 3000);
  assert.equal(j.status, SweepStatus.GAS_FUELING);
});
