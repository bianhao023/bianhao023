import { Order, Subscription } from '../domain/types';

export interface OrderRepository {
  create(order: Order): Promise<Order>;
  findById(id: string): Promise<Order | undefined>;
  findByOutTradeNo(outTradeNo: string): Promise<Order | undefined>;
  findByIdempotencyKey(key: string): Promise<Order | undefined>;
  /** Pending orders whose unique USDT amount is being watched. */
  findPendingByMethod(method: string): Promise<Order[]>;
  update(order: Order): Promise<Order>;
  /** All orders (test/admin helper). */
  all(): Promise<Order[]>;
}

export interface SubscriptionRepository {
  findActiveByUser(userId: string): Promise<Subscription | undefined>;
  create(sub: Subscription): Promise<Subscription>;
  update(sub: Subscription): Promise<Subscription>;
}

/**
 * Stores processed webhook/event ids so a replayed callback is only acted on
 * once. `markIfNew` returns true the first time an eventId is seen, false
 * afterwards (atomic check-and-set).
 */
export interface ProcessedEventStore {
  markIfNew(eventId: string): Promise<boolean>;
}

/**
 * Provides mutual exclusion keyed by a string (e.g. order id) so concurrent
 * callbacks for the same order are serialised.
 */
export interface Locker {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
