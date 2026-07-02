/**
 * Lazy PostgreSQL adapter. The core library keeps ZERO hard runtime
 * dependencies, so the `pg` driver is `require`d only here and only when a
 * `DATABASE_URL` is actually configured. `pg` is declared as an
 * optionalDependency; a normal `npm install` pulls it for production, while the
 * in-memory deployment and the test suite never touch this module.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlClient } from './sqlStore';
import { logger } from '../../utils/logger';

/** A live Postgres-backed {@link SqlClient} plus a close hook for shutdown. */
export interface PgClientHandle {
  /** SqlClient the repositories are constructed against. */
  client: SqlClient;
  /** Pingable surface for the `/readyz` SQL check (same underlying pool). */
  ping(): Promise<string>;
  /** Drain and close the connection pool (call on graceful shutdown). */
  end(): Promise<void>;
}

/**
 * Build a {@link SqlClient} backed by a `node-postgres` connection pool.
 * Throws a clear, actionable error if `DATABASE_URL` is set but `pg` is missing.
 */
export function createPgClient(
  connectionString: string,
  opts: { max?: number } = {},
): PgClientHandle {
  // Lazy load: no hard dependency on `pg` for the memory-backed deployment/tests.
  let Pool: new (config: unknown) => PgPool;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Pool = (require('pg') as { Pool: new (config: unknown) => PgPool }).Pool;
  } catch {
    throw new Error(
      "DATABASE_URL is set but the 'pg' package is not installed. " +
        'Run `npm install pg` (it is declared as an optional dependency).',
    );
  }

  const pool = new Pool({ connectionString, max: opts.max ?? 10 });
  pool.on('error', (err: Error) => logger.error('postgres pool error', { error: err.message }));

  const client: SqlClient = {
    query: async (sql, params) => {
      const res = await pool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    },
  };

  return {
    client,
    ping: async () => {
      await pool.query('SELECT 1');
      return 'PONG';
    },
    end: () => pool.end(),
  };
}

/** Minimal shape of the `pg` Pool we rely on (avoids a hard `@types/pg` dep). */
interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  on(event: 'error', handler: (err: Error) => void): void;
  end(): Promise<void>;
}

// schema.sql lives beside this file in the source tree. `tsc` does not copy
// non-.ts assets, so the build script copies it into dist next to the compiled
// module; we try that (compiled) location first, then fall back to the source
// tree for `ts-node`/dev runs.
const SCHEMA_CANDIDATES = [
  join(__dirname, 'schema.sql'),
  join(__dirname, '..', '..', '..', '..', 'src', 'storage', 'sql', 'schema.sql'),
];

/** Read the bundled `schema.sql`, trying the compiled then source locations. */
export function loadSchemaSql(): string {
  for (const path of SCHEMA_CANDIDATES) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`schema.sql not found (looked in: ${SCHEMA_CANDIDATES.join(', ')})`);
}

/**
 * Apply the database schema. `schema.sql` uses `CREATE TABLE/INDEX IF NOT
 * EXISTS` throughout, so migration is idempotent and safe to run on every boot.
 * Statements are additive only, which keeps app rollbacks safe.
 */
export async function runMigrations(client: SqlClient): Promise<void> {
  await client.query(loadSchemaSql());
  logger.info('database schema applied');
}
