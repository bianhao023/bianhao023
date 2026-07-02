import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowToUser, SqlUserRepository } from '../src/storage/sql/sqlUserStore';
import { SqlClient } from '../src/storage/sql/sqlStore';
import { User } from '../src/domain/user';

/**
 * Minimal fake SqlClient: each test queues the `{ rows, rowCount }` result the
 * next query should return, and the fake records the last SQL + params so the
 * test can assert on them. No mocking library.
 */
class FakeClient implements SqlClient {
  results: Array<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> = [];
  lastSql = '';
  lastParams: unknown[] = [];

  queue(res: { rows: Array<Record<string, unknown>>; rowCount: number | null }): void {
    this.results.push(res);
  }

  async query(sql: string, params?: unknown[]) {
    this.lastSql = sql;
    this.lastParams = params ?? [];
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

const sampleUser = (over: Partial<User> = {}): User => ({
  id: 'u1',
  email: 'Alice@Example.com',
  locale: 'en',
  name: 'Alice',
  passwordHash: 'salt:hash',
  apiKey: 'key-1',
  createdAt: 1000,
  updatedAt: 2000,
  ...over,
});

test('rowToUser maps DB columns (NULL name -> undefined, numeric timestamps)', () => {
  const u = rowToUser({
    id: 'u1', email: 'alice@example.com', locale: 'en', name: null,
    password_hash: 'salt:hash', api_key: 'key-1', created_at: '1000', updated_at: '2000',
  });
  assert.equal(u.name, undefined);
  assert.equal(u.email, 'alice@example.com');
  assert.equal(u.passwordHash, 'salt:hash');
  assert.equal(u.apiKey, 'key-1');
  assert.equal(u.createdAt, 1000);
  assert.equal(typeof u.createdAt, 'number');
  assert.equal(u.updatedAt, 2000);
  assert.equal(typeof u.updatedAt, 'number');
});

test('create inserts and returns the user with a lower-cased email', async () => {
  const db = new FakeClient();
  db.queue({ rows: [], rowCount: 1 });
  const repo = new SqlUserRepository(db);
  const stored = await repo.create(sampleUser());
  assert.equal(stored.email, 'alice@example.com');
  assert.match(db.lastSql, /INSERT INTO users/);
  assert.match(db.lastSql, /ON CONFLICT \(email\) DO NOTHING/);
  assert.equal(db.lastParams[1], 'alice@example.com');
});

test('create throws when the conflicting insert reports rowCount 0', async () => {
  const db = new FakeClient();
  db.queue({ rows: [], rowCount: 0 });
  const repo = new SqlUserRepository(db);
  await assert.rejects(
    repo.create(sampleUser()),
    /email already registered: alice@example.com/,
  );
});

test('findById maps a canned row via rowToUser', async () => {
  const db = new FakeClient();
  db.queue({
    rows: [{
      id: 'u1', email: 'alice@example.com', locale: 'en', name: null,
      password_hash: 'salt:hash', api_key: 'key-1', created_at: '1000', updated_at: '2000',
    }],
    rowCount: 1,
  });
  const repo = new SqlUserRepository(db);
  const u = await repo.findById('u1');
  assert.match(db.lastSql, /SELECT \* FROM users WHERE id = \$1/);
  assert.equal(db.lastParams[0], 'u1');
  assert.equal(u?.id, 'u1');
  assert.equal(u?.name, undefined);
  assert.equal(u?.createdAt, 1000);
});

test('findByEmail lower-cases its argument', async () => {
  const db = new FakeClient();
  db.queue({
    rows: [{
      id: 'u1', email: 'alice@example.com', locale: 'en', name: 'Alice',
      password_hash: 'salt:hash', api_key: 'key-1', created_at: '1000', updated_at: '2000',
    }],
    rowCount: 1,
  });
  const repo = new SqlUserRepository(db);
  const u = await repo.findByEmail('Alice@Example.com');
  assert.match(db.lastSql, /SELECT \* FROM users WHERE email = \$1/);
  assert.equal(db.lastParams[0], 'alice@example.com');
  assert.equal(u?.name, 'Alice');
});

test('findByApiKey queries by api_key and maps the row', async () => {
  const db = new FakeClient();
  db.queue({
    rows: [{
      id: 'u1', email: 'alice@example.com', locale: 'en', name: 'Alice',
      password_hash: 'salt:hash', api_key: 'key-1', created_at: '1000', updated_at: '2000',
    }],
    rowCount: 1,
  });
  const repo = new SqlUserRepository(db);
  const u = await repo.findByApiKey('key-1');
  assert.match(db.lastSql, /SELECT \* FROM users WHERE api_key = \$1/);
  assert.equal(db.lastParams[0], 'key-1');
  assert.equal(u?.apiKey, 'key-1');
});

test('update issues the UPDATE and returns the user with lower-cased email', async () => {
  const db = new FakeClient();
  db.queue({ rows: [], rowCount: 1 });
  const repo = new SqlUserRepository(db);
  const stored = await repo.update(sampleUser({ apiKey: 'key-2', updatedAt: 3000 }));
  assert.match(db.lastSql, /UPDATE users SET email=\$2/);
  assert.equal(db.lastParams[0], 'u1');
  assert.equal(db.lastParams[1], 'alice@example.com');
  assert.equal(db.lastParams[5], 'key-2');
  assert.equal(db.lastParams[6], 3000);
  assert.equal(stored.email, 'alice@example.com');
  assert.equal(stored.apiKey, 'key-2');
});

test('update throws "unknown user" when rowCount is 0', async () => {
  const db = new FakeClient();
  db.queue({ rows: [], rowCount: 0 });
  const repo = new SqlUserRepository(db);
  await assert.rejects(repo.update(sampleUser()), /unknown user: u1/);
});
