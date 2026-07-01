import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowToAuditEvent, SqlAuditLog } from '../src/storage/sql/sqlAuditLog';
import { SqlClient } from '../src/storage/sql/sqlStore';

/** Records every query and returns canned rows per call (in order). */
class FakeSqlClient implements SqlClient {
  public readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  private readonly responses: Array<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;

  constructor(responses: Array<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> = []) {
    this.responses = responses;
  }

  async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
    this.calls.push({ sql, params });
    return this.responses[this.calls.length - 1] ?? { rows: [], rowCount: 0 };
  }
}

test('rowToAuditEvent maps bigint-as-string at, null actor, metadata object', () => {
  const e = rowToAuditEvent({
    id: 'a1',
    at: '1700000000000',
    action: 'order.paid',
    actor: null,
    subject_id: 'o1',
    metadata: { k: 'v', n: 3 },
  });
  assert.equal(e.id, 'a1');
  assert.equal(e.at, 1700000000000);
  assert.equal(typeof e.at, 'number');
  assert.equal(e.action, 'order.paid');
  assert.equal(e.actor, undefined);
  assert.equal(e.subjectId, 'o1');
  assert.deepEqual(e.metadata, { k: 'v', n: 3 });
});

test('rowToAuditEvent parses metadata supplied as a JSON string; missing metadata → undefined', () => {
  const e = rowToAuditEvent({
    id: 'a2',
    at: '5',
    action: 'user.login',
    actor: 'admin',
    subject_id: null,
    metadata: '{"ip":"1.2.3.4"}',
  });
  assert.equal(e.actor, 'admin');
  assert.equal(e.subjectId, undefined);
  assert.deepEqual(e.metadata, { ip: '1.2.3.4' });

  const e2 = rowToAuditEvent({ id: 'a3', at: '1', action: 'noop', metadata: null });
  assert.equal(e2.metadata, undefined);
});

test('record() issues an INSERT with the input fields plus a generated id and at', async () => {
  const db = new FakeSqlClient([{ rows: [], rowCount: 1 }]);
  const log = new SqlAuditLog(db, () => 4242);

  const event = await log.record({
    action: 'refund.created',
    actor: 'admin',
    subjectId: 'r1',
    metadata: { amount: 500 },
  });

  assert.equal(db.calls.length, 1);
  const { sql, params } = db.calls[0];
  assert.match(sql, /INSERT INTO audit_events/);

  // Generated id + at.
  assert.equal(typeof event.id, 'string');
  assert.ok(event.id.length > 0);
  assert.equal(event.at, 4242);
  assert.ok(params.includes(event.id));
  assert.ok(params.includes(4242));

  // Input fields carried into params.
  assert.ok(params.includes('refund.created'));
  assert.ok(params.includes('admin'));
  assert.ok(params.includes('r1'));
  assert.ok(params.includes(JSON.stringify({ amount: 500 })));

  // Returned event mirrors the input.
  assert.equal(event.action, 'refund.created');
  assert.equal(event.actor, 'admin');
  assert.equal(event.subjectId, 'r1');
  assert.deepEqual(event.metadata, { amount: 500 });
});

test('record() honours an explicit at and defaults metadata to {}', async () => {
  const db = new FakeSqlClient([{ rows: [], rowCount: 1 }]);
  const log = new SqlAuditLog(db, () => 999);

  const event = await log.record({ action: 'ping', at: 100 });
  assert.equal(event.at, 100);
  assert.equal(event.metadata, undefined);
  const { params } = db.calls[0];
  assert.ok(params.includes(100));
  assert.ok(params.includes(JSON.stringify({})));
  // Nullable columns passed as null, not undefined.
  assert.ok(params.includes(null));
});

test('query() runs a COUNT then a paginated ORDER BY at DESC SELECT with filter params', async () => {
  const db = new FakeSqlClient([
    { rows: [{ total: '2' }], rowCount: 1 },
    {
      rows: [
        { id: 'a1', at: '200', action: 'order.paid', actor: 'admin', subject_id: 'o1', metadata: {} },
        { id: 'a2', at: '150', action: 'order.paid', actor: 'admin', subject_id: 'o2', metadata: '{}' },
      ],
      rowCount: 2,
    },
  ]);
  const log = new SqlAuditLog(db);

  const res = await log.query({ action: 'order.paid', from: 100, to: 300, limit: 25, offset: 5 });

  assert.equal(res.total, 2);
  assert.equal(typeof res.total, 'number');
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].id, 'a1');
  assert.equal(res.items[1].subjectId, 'o2');

  assert.equal(db.calls.length, 2);

  // First query is a COUNT carrying the filter params (but not limit/offset).
  const countCall = db.calls[0];
  assert.match(countCall.sql, /COUNT\(\*\)/i);
  assert.ok(countCall.params.includes('order.paid'));
  assert.ok(countCall.params.includes(100));
  assert.ok(countCall.params.includes(300));
  assert.ok(!countCall.params.includes(25));

  // Second query is the paginated SELECT.
  const selectCall = db.calls[1];
  assert.match(selectCall.sql, /ORDER BY\s+at\s+DESC/i);
  assert.match(selectCall.sql, /LIMIT/i);
  assert.match(selectCall.sql, /OFFSET/i);
  assert.ok(selectCall.params.includes('order.paid'));
  assert.ok(selectCall.params.includes(100));
  assert.ok(selectCall.params.includes(300));
  assert.ok(selectCall.params.includes(25));
  assert.ok(selectCall.params.includes(5));
});

test('query() with no filter uses default LIMIT 50 / OFFSET 0 and no WHERE', async () => {
  const db = new FakeSqlClient([
    { rows: [{ total: '0' }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  const log = new SqlAuditLog(db);

  const res = await log.query();
  assert.equal(res.total, 0);
  assert.deepEqual(res.items, []);

  assert.ok(!/WHERE/i.test(db.calls[0].sql));
  const selectCall = db.calls[1];
  assert.ok(selectCall.params.includes(50));
  assert.ok(selectCall.params.includes(0));
});
