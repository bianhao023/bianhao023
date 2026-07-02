import { Order, OrderStatus, Subscription } from '../domain/types';
import { Refund, RefundStatus } from '../domain/refund';
import { User } from '../domain/user';
import { DepositAddress, SweepJob } from '../domain/deposit';

/** Filter for paginated order queries (all fields optional / AND-combined). */
export interface OrderQueryFilter {
  status?: OrderStatus;
  method?: string;
  /** Inclusive lower bound on createdAt (epoch millis). */
  from?: number;
  /** Exclusive upper bound on createdAt (epoch millis). */
  to?: number;
}

/** Filter for paginated refund queries. */
export interface RefundQueryFilter {
  status?: RefundStatus;
  from?: number;
  to?: number;
}

/** Aggregated order metrics, pushed down to the store (SQL GROUP BY). */
export interface OrderSummary {
  ordersTotal: number;
  byStatus: Record<string, number>;
  /** Paid orders (paidAt set and status PAID/FULFILLED/REFUNDED) grouped by method+currency. */
  paid: Array<{ method: string; currency: string; paidCount: number; grossMinor: number }>;
}

export interface OrderRepository {
  create(order: Order): Promise<Order>;
  findById(id: string): Promise<Order | undefined>;
  findByOutTradeNo(outTradeNo: string): Promise<Order | undefined>;
  findByIdempotencyKey(key: string): Promise<Order | undefined>;
  /** Pending orders whose unique USDT amount is being watched. */
  findPendingByMethod(method: string): Promise<Order[]>;
  update(order: Order): Promise<Order>;
  /**
   * Paginated, filtered query (newest-first). The store pushes filtering and
   * pagination down (SQL WHERE + LIMIT/OFFSET) instead of loading every row.
   */
  query(filter: OrderQueryFilter, limit: number, offset: number): Promise<{ total: number; items: Order[] }>;
  /** Aggregated metrics (counts + paid gross), pushed down as SQL GROUP BY. */
  summarize(filter: OrderQueryFilter): Promise<OrderSummary>;
  /** All orders (test/admin helper; avoid on large datasets). */
  all(): Promise<Order[]>;
}

export interface RefundRepository {
  create(refund: Refund): Promise<Refund>;
  findById(id: string): Promise<Refund | undefined>;
  findByOutRefundNo(outRefundNo: string): Promise<Refund | undefined>;
  findByOrder(orderId: string): Promise<Refund[]>;
  update(refund: Refund): Promise<Refund>;
  /** Paginated, filtered query (newest-first), pushed down to the store. */
  query(filter: RefundQueryFilter, limit: number, offset: number): Promise<{ total: number; items: Refund[] }>;
  /** All refunds (reporting/admin helper; avoid on large datasets). */
  all(): Promise<Refund[]>;
}

export interface UserRepository {
  create(user: User): Promise<User>;
  findById(id: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  findByApiKey(apiKey: string): Promise<User | undefined>;
  update(user: User): Promise<User>;
}

export interface SubscriptionRepository {
  findActiveByUser(userId: string): Promise<Subscription | undefined>;
  create(sub: Subscription): Promise<Subscription>;
  update(sub: Subscription): Promise<Subscription>;
  /** All currently-active subscriptions (expiry processing/reporting). */
  listActive(): Promise<Subscription[]>;
}

/**
 * Stores processed webhook/event ids so a replayed callback is only acted on
 * once. `markIfNew` returns true the first time an eventId is seen, false
 * afterwards (atomic check-and-set).
 */
export interface ProcessedEventStore {
  markIfNew(eventId: string): Promise<boolean>;
  /**
   * Delete processed-event records older than `olderThanMs` (relative to now),
   * bounding memory/table growth. Returns the number removed. Safe to run
   * periodically; the dedupe window need only exceed a provider's retry window.
   */
  sweep(olderThanMs: number): Promise<number>;
}

/**
 * Provides mutual exclusion keyed by a string (e.g. order id) so concurrent
 * callbacks for the same order are serialised.
 */
export interface Locker {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Stores per-order TRON deposit addresses (used in `per-order` USDT mode).
 * `nextIndex` MUST be atomic across concurrent allocations so two orders never
 * derive the same HD index / address.
 */
export interface DepositAddressRepository {
  /** Atomically reserve and return the next monotonic HD derivation index. */
  nextIndex(): Promise<number>;
  /** Persist a derived deposit address record. */
  save(record: DepositAddress): Promise<DepositAddress>;
  findByOrderId(orderId: string): Promise<DepositAddress | undefined>;
  findByAddress(address: string): Promise<DepositAddress | undefined>;
}

/** Stores sweep ("二次归集") jobs and exposes the watcher's work queue. */
export interface SweepJobRepository {
  create(job: SweepJob): Promise<SweepJob>;
  findById(id: string): Promise<SweepJob | undefined>;
  findByOrderId(orderId: string): Promise<SweepJob | undefined>;
  update(job: SweepJob): Promise<SweepJob>;
  /**
   * Non-terminal jobs due for processing (`nextAttemptAt <= now`), oldest
   * first. The sweep watcher drains this queue each tick.
   */
  due(now: number, limit: number): Promise<SweepJob[]>;
  /** All jobs (admin/reporting helper; avoid on large datasets). */
  all(): Promise<SweepJob[]>;
}
