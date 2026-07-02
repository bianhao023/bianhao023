import { User } from '../../domain/user';
import { UserRepository } from '../repository';
import { SqlClient } from './sqlStore';

const num = (v: unknown): number => Number(v);
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

/** Map a DB row to a User. Exported for unit testing without a live DB. */
export function rowToUser(r: Record<string, unknown>): User {
  return {
    id: str(r.id),
    email: str(r.email),
    locale: str(r.locale),
    name: optStr(r.name),
    passwordHash: str(r.password_hash),
    apiKey: str(r.api_key),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

/**
 * SQL-backed user store. Mirrors `MemoryUserRepository`: emails are stored
 * lower-cased and unique, and a rotated API key stops resolving because
 * `api_key` is a plain column (the UPDATE overwrites it in place).
 */
export class SqlUserRepository implements UserRepository {
  constructor(private readonly db: SqlClient) {}

  async create(user: User): Promise<User> {
    const email = user.email.toLowerCase();
    const stored = { ...user, email };
    // ON CONFLICT (email) DO NOTHING is driver-agnostic: a duplicate email
    // yields rowCount === 0, which we surface as the same error the memory
    // store throws (no reliance on a Postgres-specific error code).
    const res = await this.db.query(
      `INSERT INTO users
        (id, email, locale, name, password_hash, api_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (email) DO NOTHING`,
      [stored.id, stored.email, stored.locale, stored.name ?? null,
        stored.passwordHash, stored.apiKey, stored.createdAt, stored.updatedAt],
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`email already registered: ${email}`);
    return stored;
  }

  private async one(sql: string, params: unknown[]): Promise<User | undefined> {
    const res = await this.db.query(sql, params);
    return res.rows[0] ? rowToUser(res.rows[0]) : undefined;
  }

  findById(id: string): Promise<User | undefined> {
    return this.one('SELECT * FROM users WHERE id = $1', [id]);
  }
  findByEmail(email: string): Promise<User | undefined> {
    return this.one('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  }
  findByApiKey(apiKey: string): Promise<User | undefined> {
    return this.one('SELECT * FROM users WHERE api_key = $1', [apiKey]);
  }

  async update(user: User): Promise<User> {
    const email = user.email.toLowerCase();
    const stored = { ...user, email };
    // api_key is a column, so a rotated key is overwritten here and the old
    // one stops resolving via findByApiKey with no extra bookkeeping.
    const res = await this.db.query(
      `UPDATE users SET email=$2, locale=$3, name=$4, password_hash=$5, api_key=$6, updated_at=$7 WHERE id=$1`,
      [stored.id, stored.email, stored.locale, stored.name ?? null,
        stored.passwordHash, stored.apiKey, stored.updatedAt],
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`unknown user: ${stored.id}`);
    return stored;
  }
}
