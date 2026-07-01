import { Order, OrderStatus, Subscription } from '../domain/types';
import { Refund } from '../domain/refund';
import { User } from '../domain/user';

/** Filter for paginated order queries (all fields optional / AND-combined). */
export interface OrderQueryFilter {
  status?: OrderStatus;
  method?: string;
  /** Inclusive lower bound on createdAt (epoch millis). */
  from?: number;
  /** Exclusive upper bound on createdAt (epoch millis). */
  to?: number;
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
  /** All orders (test/admin helper; avoid on large datasets). */
  all(): Promise<Order[]>;
}

export interface RefundRepository {
  create(refund: Refund): Promise<Refund>;
  findById(id: string): Promise<Refund | undefined>;
  findByOutRefundNo(outRefundNo: string): Promise<Refund | undefined>;
  findByOrder(orderId: string): Promise<Refund[]>;
  update(refund: Refund): Promise<Refund>;
  /** All refunds (reporting/admin helper). */
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
