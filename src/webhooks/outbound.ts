import { createHmac } from 'node:crypto';
import { WebhookConfig } from '../config';
import { HttpClient } from '../providers/provider';
import { uuid } from '../utils/ids';
import { logger } from '../utils/logger';

/** Business events published to a merchant's webhook endpoint. */
export type OutboundEventType = 'order.fulfilled' | 'order.refunded' | 'refund.updated';

export interface OutboundEvent {
  id: string;
  type: OutboundEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** The narrow interface services depend on to publish events. */
export interface OutboundEmitter {
  emit(type: OutboundEventType, payload: Record<string, unknown>): Promise<void>;
}

export type DeliveryStatus = 'pending' | 'delivered' | 'dead';

/** A single delivery attempt record for an event to the merchant URL. */
export interface WebhookDelivery {
  id: string;
  event: OutboundEvent;
  url: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  lastStatus?: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

export interface WebhookRepository {
  create(d: WebhookDelivery): Promise<WebhookDelivery>;
  update(d: WebhookDelivery): Promise<WebhookDelivery>;
  findById(id: string): Promise<WebhookDelivery | undefined>;
  /** Pending deliveries whose nextAttemptAt has arrived. */
  findDue(now: number, limit: number): Promise<WebhookDelivery[]>;
  list(status: DeliveryStatus | undefined, limit: number, offset: number): Promise<{ total: number; items: WebhookDelivery[] }>;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export class MemoryWebhookRepository implements WebhookRepository {
  private byId = new Map<string, WebhookDelivery>();
  private order: string[] = [];

  async create(d: WebhookDelivery): Promise<WebhookDelivery> {
    this.byId.set(d.id, clone(d));
    this.order.push(d.id);
    return clone(d);
  }
  async update(d: WebhookDelivery): Promise<WebhookDelivery> {
    if (!this.byId.has(d.id)) throw new Error(`unknown delivery: ${d.id}`);
    this.byId.set(d.id, clone(d));
    return clone(d);
  }
  async findById(id: string): Promise<WebhookDelivery | undefined> {
    const d = this.byId.get(id);
    return d ? clone(d) : undefined;
  }
  async findDue(now: number, limit: number): Promise<WebhookDelivery[]> {
    return [...this.byId.values()]
      .filter((d) => d.status === 'pending' && d.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit)
      .map(clone);
  }
  async list(status: DeliveryStatus | undefined, limit: number, offset: number) {
    const all = this.order
      .map((id) => this.byId.get(id)!)
      .filter((d) => (status ? d.status === status : true))
      .reverse(); // newest first
    return { total: all.length, items: all.slice(offset, offset + limit).map(clone) };
  }
}

/** Compute the signature header value for a payload: `sha256=<hex hmac>`. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${mac}`;
}

/** Exponential backoff with a cap (deterministic; injectable for tests). */
export function defaultBackoff(attempts: number): number {
  const base = 30_000; // 30s
  const cap = 3_600_000; // 1h
  return Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
}

/**
 * Delivers business events to a merchant webhook with HMAC signatures, retries
 * with exponential backoff, and dead-letters after `maxAttempts`. Deliveries
 * are persisted so a crash never loses an event; a worker drains due deliveries.
 */
export class WebhookDispatcher implements OutboundEmitter {
  constructor(
    private readonly repo: WebhookRepository,
    private readonly http: HttpClient,
    private readonly cfg: WebhookConfig,
    private readonly now: () => number = Date.now,
    private readonly backoff: (attempts: number) => number = defaultBackoff,
  ) {}

  /** Publish an event: persist a pending delivery due immediately. */
  async emit(type: OutboundEventType, payload: Record<string, unknown>): Promise<void> {
    await this.enqueue(type, payload);
  }

  async enqueue(type: OutboundEventType, payload: Record<string, unknown>): Promise<WebhookDelivery> {
    const now = this.now();
    const delivery: WebhookDelivery = {
      id: uuid(),
      event: { id: uuid(), type, payload, createdAt: now },
      url: this.cfg.url,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    return this.repo.create(delivery);
  }

  /** Attempt a single delivery, updating its status/backoff. */
  async deliver(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    const now = this.now();
    const body = JSON.stringify({
      id: delivery.event.id,
      type: delivery.event.type,
      createdAt: delivery.event.createdAt,
      data: delivery.event.payload,
    });
    const timestamp = String(now);
    const attempts = delivery.attempts + 1;

    try {
      const res = await this.http.request({
        method: 'POST',
        url: delivery.url,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': delivery.event.id,
          'X-Webhook-Event': delivery.event.type,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': signPayload(this.cfg.secret, timestamp, body),
        },
        body,
      });
      if (res.status >= 200 && res.status < 300) {
        return this.repo.update({ ...delivery, status: 'delivered', attempts, lastStatus: res.status, deliveredAt: now, updatedAt: now, lastError: undefined });
      }
      return this.fail(delivery, attempts, now, `HTTP ${res.status}`, res.status);
    } catch (err) {
      return this.fail(delivery, attempts, now, (err as Error).message);
    }
  }

  private fail(delivery: WebhookDelivery, attempts: number, now: number, error: string, lastStatus?: number): Promise<WebhookDelivery> {
    const dead = attempts >= this.cfg.maxAttempts;
    const updated: WebhookDelivery = {
      ...delivery,
      status: dead ? 'dead' : 'pending',
      attempts,
      lastError: error,
      lastStatus,
      nextAttemptAt: dead ? delivery.nextAttemptAt : now + this.backoff(attempts),
      updatedAt: now,
    };
    if (dead) logger.error('webhook dead-lettered', { deliveryId: delivery.id, attempts, error });
    return this.repo.update(updated);
  }

  /** Drain all currently-due deliveries. Returns per-outcome counts. */
  async processDue(limit = 50): Promise<{ delivered: number; retried: number; dead: number }> {
    const due = await this.repo.findDue(this.now(), limit);
    let delivered = 0, retried = 0, dead = 0;
    for (const d of due) {
      const r = await this.deliver(d);
      if (r.status === 'delivered') delivered++;
      else if (r.status === 'dead') dead++;
      else retried++;
    }
    return { delivered, retried, dead };
  }

  /** Requeue a dead-lettered (or any) delivery for immediate retry. */
  async retry(id: string): Promise<WebhookDelivery> {
    const d = await this.repo.findById(id);
    if (!d) throw new Error(`unknown delivery: ${id}`);
    const now = this.now();
    return this.repo.update({ ...d, status: 'pending', nextAttemptAt: now, updatedAt: now });
  }

  list(status: DeliveryStatus | undefined, limit: number, offset: number) {
    return this.repo.list(status, limit, offset);
  }
}
