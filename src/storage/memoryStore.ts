import { Order, Subscription } from '../domain/types';
import { Refund } from '../domain/refund';
import { User } from '../domain/user';
import {
  OrderRepository,
  OrderQueryFilter,
  OrderSummary,
  RefundRepository,
  RefundQueryFilter,
  SubscriptionRepository,
  UserRepository,
  ProcessedEventStore,
  Locker,
} from './repository';
import { OrderStatus } from '../domain/types';

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

  async query(filter: OrderQueryFilter, limit: number, offset: number): Promise<{ total: number; items: Order[] }> {
    const matched = [...this.byId.values()]
      .filter((o) => {
        if (filter.status && o.status !== filter.status) return false;
        if (filter.method && o.method !== filter.method) return false;
        if (filter.from !== undefined && o.createdAt < filter.from) return false;
        if (filter.to !== undefined && o.createdAt >= filter.to) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    return { total: matched.length, items: matched.slice(offset, offset + limit).map(clone) };
  }

  async summarize(filter: OrderQueryFilter): Promise<OrderSummary> {
    const paidStatuses = new Set<OrderStatus>([OrderStatus.PAID, OrderStatus.FULFILLED, OrderStatus.REFUNDED]);
    const matched = [...this.byId.values()].filter((o) => {
      if (filter.status && o.status !== filter.status) return false;
      if (filter.method && o.method !== filter.method) return false;
      if (filter.from !== undefined && o.createdAt < filter.from) return false;
      if (filter.to !== undefined && o.createdAt >= filter.to) return false;
      return true;
    });
    const byStatus: Record<string, number> = {};
    const paidMap = new Map<string, { method: string; currency: string; paidCount: number; grossMinor: number }>();
    for (const o of matched) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      if (o.paidAt !== undefined && paidStatuses.has(o.status)) {
        const key = `${o.method}|${o.currency}`;
        const row = paidMap.get(key) ?? { method: o.method, currency: o.currency, paidCount: 0, grossMinor: 0 };
        row.paidCount++;
        row.grossMinor += o.amount;
        paidMap.set(key, row);
      }
    }
    return { ordersTotal: matched.length, byStatus, paid: [...paidMap.values()] };
  }

  async all(): Promise<Order[]> {
    return [...this.byId.values()].map(clone);
  }
}

export class MemoryUserRepository implements UserRepository {
  private byId = new Map<string, User>();
  private byEmail = new Map<string, string>();
  private byApiKey = new Map<string, string>();

  async create(user: User): Promise<User> {
    const email = user.email.toLowerCase();
    if (this.byEmail.has(email)) throw new Error(`email already registered: ${email}`);
    const stored = { ...user, email };
    this.byId.set(user.id, clone(stored));
    this.byEmail.set(email, user.id);
    this.byApiKey.set(user.apiKey, user.id);
    return clone(stored);
  }

  async findById(id: string): Promise<User | undefined> {
    const u = this.byId.get(id);
    return u ? clone(u) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? this.findById(id) : undefined;
  }

  async findByApiKey(apiKey: string): Promise<User | undefined> {
    const id = this.byApiKey.get(apiKey);
    return id ? this.findById(id) : undefined;
  }

  async update(user: User): Promise<User> {
    const prev = this.byId.get(user.id);
    if (!prev) throw new Error(`unknown user: ${user.id}`);
    // Drop a rotated API key so the old one stops resolving.
    if (prev.apiKey !== user.apiKey) this.byApiKey.delete(prev.apiKey);
    this.byId.set(user.id, clone(user));
    this.byApiKey.set(user.apiKey, user.id);
    return clone(user);
  }
}

export class MemoryRefundRepository implements RefundRepository {
  private byId = new Map<string, Refund>();
  private byOutRefundNo = new Map<string, string>();

  async create(refund: Refund): Promise<Refund> {
    if (this.byOutRefundNo.has(refund.outRefundNo)) {
      throw new Error(`duplicate outRefundNo: ${refund.outRefundNo}`);
    }
    this.byId.set(refund.id, clone(refund));
    this.byOutRefundNo.set(refund.outRefundNo, refund.id);
    return clone(refund);
  }

  async findById(id: string): Promise<Refund | undefined> {
    const r = this.byId.get(id);
    return r ? clone(r) : undefined;
  }

  async findByOutRefundNo(outRefundNo: string): Promise<Refund | undefined> {
    const id = this.byOutRefundNo.get(outRefundNo);
    return id ? this.findById(id) : undefined;
  }

  async findByOrder(orderId: string): Promise<Refund[]> {
    return [...this.byId.values()].filter((r) => r.orderId === orderId).map(clone);
  }

  async update(refund: Refund): Promise<Refund> {
    this.byId.set(refund.id, clone(refund));
    return clone(refund);
  }

  async query(filter: RefundQueryFilter, limit: number, offset: number): Promise<{ total: number; items: Refund[] }> {
    const matched = [...this.byId.values()]
      .filter((r) => {
        if (filter.status && r.status !== filter.status) return false;
        if (filter.from !== undefined && r.createdAt < filter.from) return false;
        if (filter.to !== undefined && r.createdAt >= filter.to) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    return { total: matched.length, items: matched.slice(offset, offset + limit).map(clone) };
  }

  async all(): Promise<Refund[]> {
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
    else if (this.activeByUser.get(sub.userId) === sub.id) this.activeByUser.delete(sub.userId);
    return clone(sub);
  }

  async listActive(): Promise<Subscription[]> {
    return [...this.byId.values()].filter((s) => s.active).map(clone);
  }
}

export class MemoryProcessedEventStore implements ProcessedEventStore {
  private seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async markIfNew(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, this.now());
    return true;
  }

  async sweep(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const [id, at] of this.seen) {
      if (at < cutoff) {
        this.seen.delete(id);
        removed++;
      }
    }
    return removed;
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
