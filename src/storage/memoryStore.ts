import { Order, Subscription } from '../domain/types';
import {
  OrderRepository,
  SubscriptionRepository,
  ProcessedEventStore,
  Locker,
} from './repository';

/**
 * In-memory implementations of the storage interfaces. They are intentionally
 * simple but correct (atomic check-and-set, real per-key locking) so the same
 * service code can be exercised in tests and swapped for a SQL/Redis-backed
 * implementation in production without changing business logic.
 */

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export class MemoryOrderRepository implements OrderRepository {
  private byId = new Map<string, Order>();
  private byOutTradeNo = new Map<string, string>();
  private byIdem = new Map<string, string>();

  async create(order: Order): Promise<Order> {
    if (this.byOutTradeNo.has(order.outTradeNo)) {
      throw new Error(`duplicate outTradeNo: ${order.outTradeNo}`);
    }
    this.byId.set(order.id, clone(order));
    this.byOutTradeNo.set(order.outTradeNo, order.id);
    if (order.idempotencyKey) this.byIdem.set(order.idempotencyKey, order.id);
    return clone(order);
  }

  async findById(id: string): Promise<Order | undefined> {
    const o = this.byId.get(id);
    return o ? clone(o) : undefined;
  }

  async findByOutTradeNo(outTradeNo: string): Promise<Order | undefined> {
    const id = this.byOutTradeNo.get(outTradeNo);
    return id ? this.findById(id) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<Order | undefined> {
    const id = this.byIdem.get(key);
    return id ? this.findById(id) : undefined;
  }

  async findPendingByMethod(method: string): Promise<Order[]> {
    return [...this.byId.values()]
      .filter((o) => o.method === method && o.status === 'PENDING')
      .map(clone);
  }

  async update(order: Order): Promise<Order> {
    if (!this.byId.has(order.id)) throw new Error(`unknown order: ${order.id}`);
    this.byId.set(order.id, clone(order));
    return clone(order);
  }

  async all(): Promise<Order[]> {
    return [...this.byId.values()].map(clone);
  }
}

export class MemorySubscriptionRepository implements SubscriptionRepository {
  private byId = new Map<string, Subscription>();
  private activeByUser = new Map<string, string>();

  async findActiveByUser(userId: string): Promise<Subscription | undefined> {
    const id = this.activeByUser.get(userId);
    if (!id) return undefined;
    const s = this.byId.get(id);
    return s ? clone(s) : undefined;
  }

  async create(sub: Subscription): Promise<Subscription> {
    this.byId.set(sub.id, clone(sub));
    if (sub.active) this.activeByUser.set(sub.userId, sub.id);
    return clone(sub);
  }

  async update(sub: Subscription): Promise<Subscription> {
    this.byId.set(sub.id, clone(sub));
    if (sub.active) this.activeByUser.set(sub.userId, sub.id);
    return clone(sub);
  }
}

export class MemoryProcessedEventStore implements ProcessedEventStore {
  private seen = new Set<string>();

  async markIfNew(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}

/**
 * Promise-chaining locker: each key owns a tail promise; new work is appended
 * to it, guaranteeing serial execution per key within a single process.
 */
export class InProcessLocker implements Locker {
  private tails = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const mine = prev.then(() => gate);
    this.tails.set(key, mine);
    await prev.catch(() => undefined); // wait our turn; ignore prior errors
    try {
      return await fn();
    } finally {
      release();
      // Best-effort cleanup so the map does not grow unbounded.
      if (this.tails.get(key) === mine) this.tails.delete(key);
    }
  }
}
