import { Order, OrderStatus, Subscription, Currency, PaymentMethod } from '../../domain/types';
import { Refund, RefundStatus } from '../../domain/refund';
import {
  OrderRepository,
  OrderQueryFilter,
  OrderSummary,
  RefundRepository,
  RefundQueryFilter,
  SubscriptionRepository,
  ProcessedEventStore,
} from '../repository';

/**
 * Minimal SQL client interface. It is intentionally compatible with the
 * `node-postgres` (`pg`) Pool/Client `query` method, so you can do:
 *
 *   import { Pool } from 'pg';
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const orders = new SqlOrderRepository(pool);
 *
 * Keeping it as an interface means this package has NO hard dependency on `pg`.
 */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

const num = (v: unknown): number => Number(v);
const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

/** Map a DB row to an Order. Exported for unit testing without a live DB. */
export function rowToOrder(r: Record<string, unknown>): Order {
  return {
    id: str(r.id),
    merchantId: optStr(r.merchant_id) ?? 'default',
    outTradeNo: str(r.out_trade_no),
    userId: str(r.user_id),
    planId: str(r.plan_id),
    method: str(r.method) as PaymentMethod,
    currency: str(r.currency) as Currency,
    amount: num(r.amount),
    status: str(r.status) as OrderStatus,
    providerTxnId: optStr(r.provider_txn_id),
    idempotencyKey: optStr(r.idempotency_key),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    expiresAt: num(r.expires_at),
    paidAt: optNum(r.paid_at),
    refundedAmount: r.refunded_amount === null || r.refunded_amount === undefined ? 0 : num(r.refunded_amount),
    metadata: (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {})) as Record<string, string>,
  };
}

/** Map a DB row to a Refund. Exported for unit testing. */
export function rowToRefund(r: Record<string, unknown>): Refund {
  return {
    id: str(r.id),
    orderId: str(r.order_id),
    outRefundNo: str(r.out_refund_no),
    amount: num(r.amount),
    currency: str(r.currency) as Currency,
    reason: optStr(r.reason),
    status: str(r.status) as RefundStatus,
    providerRefundId: optStr(r.provider_refund_id),
    rawStatus: str(r.raw_status),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

/** Map a DB row to a Subscription. Exported for unit testing. */
export function rowToSubscription(r: Record<string, unknown>): Subscription {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    planId: str(r.plan_id),
    startsAt: num(r.starts_at),
    expiresAt: num(r.expires_at),
    trafficGb: num(r.traffic_gb),
    deviceLimit: num(r.device_limit),
    active: Boolean(r.active),
    orderIds: (typeof r.order_ids === 'string' ? JSON.parse(r.order_ids) : (r.order_ids ?? [])) as string[],
    expiryNotifiedAt: optNum(r.expiry_notified_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

export class SqlOrderRepository implements OrderRepository {
  constructor(private readonly db: SqlClient) {}

  async create(o: Order): Promise<Order> {
    await this.db.query(
      `INSERT INTO orders
        (id, merchant_id, out_trade_no, user_id, plan_id, method, currency, amount, status,
         provider_txn_id, idempotency_key, created_at, updated_at, expires_at, paid_at, refunded_amount, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [o.id, o.merchantId ?? 'default', o.outTradeNo, o.userId, o.planId, o.method, o.currency, o.amount, o.status,
        o.providerTxnId ?? null, o.idempotencyKey ?? null, o.createdAt, o.updatedAt, o.expiresAt,
        o.paidAt ?? null, o.refundedAmount ?? 0, JSON.stringify(o.metadata)],
    );
    return o;
  }

  private async one(sql: string, params: unknown[]): Promise<Order | undefined> {
    const res = await this.db.query(sql, params);
    return res.rows[0] ? rowToOrder(res.rows[0]) : undefined;
  }

  findById(id: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE id = $1', [id]);
  }
  findByOutTradeNo(outTradeNo: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE out_trade_no = $1', [outTradeNo]);
  }
  findByIdempotencyKey(key: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE idempotency_key = $1', [key]);
  }

  async findPendingByMethod(method: string): Promise<Order[]> {
    const res = await this.db.query(
      `SELECT * FROM orders WHERE status = '${OrderStatus.PENDING}' AND method = $1`,
      [method],
    );
    return res.rows.map(rowToOrder);
  }

  async update(o: Order): Promise<Order> {
    await this.db.query(
      `UPDATE orders SET status=$2, provider_txn_id=$3, updated_at=$4, paid_at=$5,
         refunded_amount=$6, metadata=$7 WHERE id=$1`,
      [o.id, o.status, o.providerTxnId ?? null, o.updatedAt, o.paidAt ?? null,
        o.refundedAmount ?? 0, JSON.stringify(o.metadata)],
    );
    return o;
  }

  async query(filter: OrderQueryFilter, limit: number, offset: number): Promise<{ total: number; items: Order[] }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.merchantId) add('merchant_id = ?', filter.merchantId);
    if (filter.status) add('status = ?', filter.status);
    if (filter.method) add('method = ?', filter.method);
    if (filter.from !== undefined) add('created_at >= ?', filter.from);
    if (filter.to !== undefined) add('created_at < ?', filter.to);
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

    const countRes = await this.db.query(`SELECT COUNT(*) AS total FROM orders${where}`, params);
    const total = Number(countRes.rows[0]?.total ?? 0);

    const pageParams = [...params, limit, offset];
    const listRes = await this.db.query(
      `SELECT * FROM orders${where} ORDER BY created_at DESC LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );
    return { total, items: listRes.rows.map(rowToOrder) };
  }

  async summarize(filter: OrderQueryFilter): Promise<OrderSummary> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.merchantId) add('merchant_id = ?', filter.merchantId);
    if (filter.status) add('status = ?', filter.status);
    if (filter.method) add('method = ?', filter.method);
    if (filter.from !== undefined) add('created_at >= ?', filter.from);
    if (filter.to !== undefined) add('created_at < ?', filter.to);
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

    const totalRes = await this.db.query(`SELECT COUNT(*) AS total FROM orders${where}`, params);
    const ordersTotal = Number(totalRes.rows[0]?.total ?? 0);

    const statusRes = await this.db.query(
      `SELECT status, COUNT(*) AS c FROM orders${where} GROUP BY status`,
      params,
    );
    const byStatus: Record<string, number> = {};
    for (const r of statusRes.rows) byStatus[str(r.status)] = num(r.c);

    // Paid = paidAt present and a settled status; grouped by method + currency.
    const paidStatuses = `('${OrderStatus.PAID}','${OrderStatus.FULFILLED}','${OrderStatus.REFUNDED}')`;
    const paidWhere = `${where ? where + ' AND' : ' WHERE'} paid_at IS NOT NULL AND status IN ${paidStatuses}`;
    const paidRes = await this.db.query(
      `SELECT method, currency, COUNT(*) AS c, COALESCE(SUM(amount),0) AS g FROM orders${paidWhere} GROUP BY method, currency`,
      params,
    );
    const paid = paidRes.rows.map((r) => ({
      method: str(r.method),
      currency: str(r.currency),
      paidCount: num(r.c),
      grossMinor: num(r.g),
    }));

    return { ordersTotal, byStatus, paid };
  }

  async all(): Promise<Order[]> {
    const res = await this.db.query('SELECT * FROM orders', []);
    return res.rows.map(rowToOrder);
  }
}

export class SqlRefundRepository implements RefundRepository {
  constructor(private readonly db: SqlClient) {}

  async create(rf: Refund): Promise<Refund> {
    await this.db.query(
      `INSERT INTO refunds
        (id, order_id, out_refund_no, amount, currency, reason, status, provider_refund_id, raw_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [rf.id, rf.orderId, rf.outRefundNo, rf.amount, rf.currency, rf.reason ?? null,
        rf.status, rf.providerRefundId ?? null, rf.rawStatus, rf.createdAt, rf.updatedAt],
    );
    return rf;
  }

  async findById(id: string): Promise<Refund | undefined> {
    const res = await this.db.query('SELECT * FROM refunds WHERE id = $1', [id]);
    return res.rows[0] ? rowToRefund(res.rows[0]) : undefined;
  }
  async findByOutRefundNo(outRefundNo: string): Promise<Refund | undefined> {
    const res = await this.db.query('SELECT * FROM refunds WHERE out_refund_no = $1', [outRefundNo]);
    return res.rows[0] ? rowToRefund(res.rows[0]) : undefined;
  }
  async findByOrder(orderId: string): Promise<Refund[]> {
    const res = await this.db.query('SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at', [orderId]);
    return res.rows.map(rowToRefund);
  }
  async update(rf: Refund): Promise<Refund> {
    await this.db.query(
      'UPDATE refunds SET status=$2, provider_refund_id=$3, raw_status=$4, updated_at=$5 WHERE id=$1',
      [rf.id, rf.status, rf.providerRefundId ?? null, rf.rawStatus, rf.updatedAt],
    );
    return rf;
  }

  async query(filter: RefundQueryFilter, limit: number, offset: number): Promise<{ total: number; items: Refund[] }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.status) add('status = ?', filter.status);
    if (filter.from !== undefined) add('created_at >= ?', filter.from);
    if (filter.to !== undefined) add('created_at < ?', filter.to);
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

    const countRes = await this.db.query(`SELECT COUNT(*) AS total FROM refunds${where}`, params);
    const total = Number(countRes.rows[0]?.total ?? 0);

    const pageParams = [...params, limit, offset];
    const listRes = await this.db.query(
      `SELECT * FROM refunds${where} ORDER BY created_at DESC LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );
    return { total, items: listRes.rows.map(rowToRefund) };
  }

  async all(): Promise<Refund[]> {
    const res = await this.db.query('SELECT * FROM refunds', []);
    return res.rows.map(rowToRefund);
  }
}

export class SqlSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveByUser(userId: string): Promise<Subscription | undefined> {
    const res = await this.db.query('SELECT * FROM subscriptions WHERE user_id = $1 AND active = true', [userId]);
    return res.rows[0] ? rowToSubscription(res.rows[0]) : undefined;
  }

  async create(s: Subscription): Promise<Subscription> {
    await this.db.query(
      `INSERT INTO subscriptions
        (id, user_id, plan_id, starts_at, expires_at, traffic_gb, device_limit, active, order_ids, expiry_notified_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [s.id, s.userId, s.planId, s.startsAt, s.expiresAt, s.trafficGb, s.deviceLimit, s.active,
        JSON.stringify(s.orderIds), s.expiryNotifiedAt ?? null, s.createdAt, s.updatedAt],
    );
    return s;
  }

  async update(s: Subscription): Promise<Subscription> {
    await this.db.query(
      `UPDATE subscriptions SET plan_id=$2, starts_at=$3, expires_at=$4, traffic_gb=$5,
         device_limit=$6, active=$7, order_ids=$8, expiry_notified_at=$9, updated_at=$10 WHERE id=$1`,
      [s.id, s.planId, s.startsAt, s.expiresAt, s.trafficGb, s.deviceLimit, s.active,
        JSON.stringify(s.orderIds), s.expiryNotifiedAt ?? null, s.updatedAt],
    );
    return s;
  }

  async listActive(): Promise<Subscription[]> {
    const res = await this.db.query('SELECT * FROM subscriptions WHERE active = true', []);
    return res.rows.map(rowToSubscription);
  }
}

/**
 * Cross-instance dedupe backed by the processed_events primary key.
 * INSERT ... ON CONFLICT DO NOTHING is atomic, so even across multiple
 * application instances an event is processed exactly once.
 */
export class SqlProcessedEventStore implements ProcessedEventStore {
  constructor(
    private readonly db: SqlClient,
    private readonly now: () => number = Date.now,
  ) {}

  async markIfNew(eventId: string): Promise<boolean> {
    const res = await this.db.query(
      'INSERT INTO processed_events (event_id, created_at) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING',
      [eventId, this.now()],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async sweep(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    const res = await this.db.query('DELETE FROM processed_events WHERE created_at < $1', [cutoff]);
    return res.rowCount ?? 0;
  }
}
