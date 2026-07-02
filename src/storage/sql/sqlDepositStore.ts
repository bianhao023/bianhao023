import { DepositAddress, SweepJob, SweepStatus } from '../../domain/deposit';
import { DepositAddressRepository, SweepJobRepository } from '../repository';
import { SqlClient } from './sqlStore';

const num = (v: unknown): number => Number(v);
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

/** Map a DB row to a DepositAddress. Exported for unit testing without a live DB. */
export function rowToDepositAddress(r: Record<string, unknown>): DepositAddress {
  return {
    index: num(r.index),
    address: str(r.address),
    orderId: str(r.order_id),
    createdAt: num(r.created_at),
  };
}

/** Map a DB row to a SweepJob. Exported for unit testing without a live DB. */
export function rowToSweepJob(r: Record<string, unknown>): SweepJob {
  return {
    id: str(r.id),
    orderId: str(r.order_id),
    depositIndex: num(r.deposit_index),
    depositAddress: str(r.deposit_address),
    collectionAddress: str(r.collection_address),
    amountMicro: num(r.amount_micro),
    status: str(r.status) as SweepStatus,
    gasTxId: optStr(r.gas_tx_id),
    sweepTxId: optStr(r.sweep_tx_id),
    attempts: num(r.attempts),
    lastError: optStr(r.last_error),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    nextAttemptAt: num(r.next_attempt_at),
  };
}

export class SqlDepositAddressRepository implements DepositAddressRepository {
  constructor(private readonly db: SqlClient) {}

  async nextIndex(): Promise<number> {
    const res = await this.db.query("SELECT nextval('deposit_address_index_seq') AS idx", []);
    return Number(res.rows[0].idx);
  }

  async save(record: DepositAddress): Promise<DepositAddress> {
    await this.db.query(
      `INSERT INTO deposit_addresses (index, address, order_id, created_at) VALUES ($1,$2,$3,$4)`,
      [record.index, record.address, record.orderId, record.createdAt],
    );
    return record;
  }

  async findByOrderId(orderId: string): Promise<DepositAddress | undefined> {
    const res = await this.db.query('SELECT * FROM deposit_addresses WHERE order_id = $1', [orderId]);
    return res.rows[0] ? rowToDepositAddress(res.rows[0]) : undefined;
  }

  async findByAddress(address: string): Promise<DepositAddress | undefined> {
    const res = await this.db.query('SELECT * FROM deposit_addresses WHERE address = $1', [address]);
    return res.rows[0] ? rowToDepositAddress(res.rows[0]) : undefined;
  }
}

export class SqlSweepJobRepository implements SweepJobRepository {
  constructor(private readonly db: SqlClient) {}

  async create(job: SweepJob): Promise<SweepJob> {
    await this.db.query(
      `INSERT INTO sweep_jobs
        (id, order_id, deposit_index, deposit_address, collection_address, amount_micro, status,
         gas_tx_id, sweep_tx_id, attempts, last_error, created_at, updated_at, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [job.id, job.orderId, job.depositIndex, job.depositAddress, job.collectionAddress,
        job.amountMicro, job.status, job.gasTxId ?? null, job.sweepTxId ?? null, job.attempts,
        job.lastError ?? null, job.createdAt, job.updatedAt, job.nextAttemptAt],
    );
    return job;
  }

  async findById(id: string): Promise<SweepJob | undefined> {
    const res = await this.db.query('SELECT * FROM sweep_jobs WHERE id = $1', [id]);
    return res.rows[0] ? rowToSweepJob(res.rows[0]) : undefined;
  }

  async findByOrderId(orderId: string): Promise<SweepJob | undefined> {
    const res = await this.db.query('SELECT * FROM sweep_jobs WHERE order_id = $1', [orderId]);
    return res.rows[0] ? rowToSweepJob(res.rows[0]) : undefined;
  }

  async update(job: SweepJob): Promise<SweepJob> {
    await this.db.query(
      `UPDATE sweep_jobs SET deposit_index=$2, deposit_address=$3, collection_address=$4,
         amount_micro=$5, status=$6, gas_tx_id=$7, sweep_tx_id=$8, attempts=$9, last_error=$10,
         updated_at=$11, next_attempt_at=$12 WHERE id=$1`,
      [job.id, job.depositIndex, job.depositAddress, job.collectionAddress, job.amountMicro,
        job.status, job.gasTxId ?? null, job.sweepTxId ?? null, job.attempts, job.lastError ?? null,
        job.updatedAt, job.nextAttemptAt],
    );
    return job;
  }

  async due(now: number, limit: number): Promise<SweepJob[]> {
    const res = await this.db.query(
      `SELECT * FROM sweep_jobs WHERE status IN ('PENDING','GAS_FUELING','SWEEPING')
         AND next_attempt_at <= $1 ORDER BY created_at ASC LIMIT $2`,
      [now, limit],
    );
    return res.rows.map(rowToSweepJob);
  }

  async all(): Promise<SweepJob[]> {
    const res = await this.db.query('SELECT * FROM sweep_jobs ORDER BY created_at ASC', []);
    return res.rows.map(rowToSweepJob);
  }
}
