import { Merchant, MerchantStatus } from '../../domain/merchant';
import { MerchantRepository } from '../repository';
import { SqlClient } from './sqlStore';

const num = (v: unknown): number => Number(v);
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

/** Map a DB row to a Merchant. Exported for unit testing without a live DB. */
export function rowToMerchant(r: Record<string, unknown>): Merchant {
  return {
    id: str(r.id),
    name: str(r.name),
    status: str(r.status) as MerchantStatus,
    apiKey: str(r.api_key),
    apiKeyPrevious: optStr(r.api_key_previous),
    usdtHdPath: optStr(r.usdt_hd_path),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

/** SQL-backed merchant/tenant store. */
export class SqlMerchantRepository implements MerchantRepository {
  constructor(private readonly db: SqlClient) {}

  async create(m: Merchant): Promise<Merchant> {
    await this.db.query(
      `INSERT INTO merchants
        (id, name, status, api_key, api_key_previous, usdt_hd_path, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.id, m.name, m.status, m.apiKey, m.apiKeyPrevious ?? null, m.usdtHdPath ?? null, m.createdAt, m.updatedAt],
    );
    return m;
  }

  async findById(id: string): Promise<Merchant | undefined> {
    const res = await this.db.query('SELECT * FROM merchants WHERE id = $1', [id]);
    return res.rows[0] ? rowToMerchant(res.rows[0]) : undefined;
  }

  async findByApiKey(apiKey: string): Promise<Merchant | undefined> {
    const res = await this.db.query(
      'SELECT * FROM merchants WHERE api_key = $1 OR api_key_previous = $1',
      [apiKey],
    );
    return res.rows[0] ? rowToMerchant(res.rows[0]) : undefined;
  }

  async update(m: Merchant): Promise<Merchant> {
    await this.db.query(
      `UPDATE merchants SET name=$2, status=$3, api_key=$4, api_key_previous=$5,
         usdt_hd_path=$6, updated_at=$7 WHERE id=$1`,
      [m.id, m.name, m.status, m.apiKey, m.apiKeyPrevious ?? null, m.usdtHdPath ?? null, m.updatedAt],
    );
    return m;
  }

  async list(): Promise<Merchant[]> {
    const res = await this.db.query('SELECT * FROM merchants ORDER BY created_at ASC', []);
    return res.rows.map(rowToMerchant);
  }
}
