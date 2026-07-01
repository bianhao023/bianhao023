import {
  CreatePaymentResult,
  Currency,
  Order,
  OrderStatus,
  PaymentMethod,
} from '../domain/types';
import {
  AmountMismatchError,
  NotFoundError,
  ProviderError,
  ValidationError,
} from '../domain/errors';
import { PaymentProvider, RawCallback } from '../providers/provider';
import {
  Locker,
  OrderRepository,
  ProcessedEventStore,
} from '../storage/repository';
import { assertTransition, isTerminal } from '../core/orderStateMachine';
import { allocateUniqueAmount } from '../providers/usdt/usdtTron';
import { SubscriptionService } from './subscriptionService';
import { PlanCatalog } from './plans';
import { AuditLog } from '../audit/auditLog';
import { newOutTradeNo, uuid } from '../utils/ids';
import { logger } from '../utils/logger';

export interface CreateOrderInput {
  userId: string;
  planId: string;
  method: PaymentMethod;
  idempotencyKey?: string;
}

export interface CreateOrderOutput {
  order: Order;
  payInfo: CreatePaymentResult;
}

export interface PaymentServiceDeps {
  providers: Map<PaymentMethod, PaymentProvider>;
  orders: OrderRepository;
  processedEvents: ProcessedEventStore;
  locker: Locker;
  subscriptions: SubscriptionService;
  plans: PlanCatalog;
  orderTtlMinutes: number;
  usdtUniqueDeltaMax: number;
  audit?: AuditLog;
  now?: () => number;
}

/**
 * The heart of the system. Coordinates providers, the order state machine,
 * idempotency, locking and fulfilment. Designed so the same `applyPayment`
 * path is used whether settlement arrives via webhook (WeChat/Alipay) or via
 * polling/reconciliation (USDT), which guarantees consistent behaviour.
 */
export class PaymentService {
  private readonly now: () => number;

  constructor(private readonly deps: PaymentServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private provider(method: PaymentMethod): PaymentProvider {
    const p = this.deps.providers.get(method);
    if (!p) throw new ValidationError(`payment method not enabled: ${method}`);
    return p;
  }

  /** Create an order and a provider payment intent. Idempotent by idempotencyKey. */
  async createOrder(input: CreateOrderInput): Promise<CreateOrderOutput> {
    if (input.idempotencyKey) {
      const existing = await this.deps.orders.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const payInfo = existing.metadata['payInfo']
          ? (JSON.parse(existing.metadata['payInfo']) as CreatePaymentResult)
          : await this.provider(existing.method).createPayment(existing);
        return { order: existing, payInfo };
      }
    }

    const plan = this.deps.plans.getPlan(input.planId);
    if (!plan) throw new NotFoundError(`plan not found: ${input.planId}`);
    const provider = this.provider(input.method);

    const currency: Currency = input.method === 'usdt' ? 'USDT' : 'CNY';
    const amount = await this.resolveAmount(input.method, plan.priceCnyFen, plan.priceUsdtMicro);

    const now = this.now();
    const order: Order = {
      id: uuid(),
      outTradeNo: newOutTradeNo(),
      userId: input.userId,
      planId: plan.id,
      method: input.method,
      currency,
      amount,
      status: OrderStatus.PENDING,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.deps.orderTtlMinutes * 60_000,
      metadata: {},
    };

    await this.deps.orders.create(order);

    let payInfo: CreatePaymentResult;
    try {
      payInfo = await provider.createPayment(order);
    } catch (err) {
      // The provider rejected; mark the order failed so it is not left dangling.
      order.status = assertTransition(order.status, OrderStatus.FAILED);
      order.updatedAt = this.now();
      await this.deps.orders.update(order);
      throw err;
    }

    order.metadata['payInfo'] = JSON.stringify(payInfo);
    order.updatedAt = this.now();
    const saved = await this.deps.orders.update(order);
    logger.info('order created', {
      orderId: saved.id,
      method: saved.method,
      amount: saved.amount,
      currency: saved.currency,
    });
    await this.deps.audit?.record({
      action: 'order.created',
      actor: saved.userId,
      subjectId: saved.id,
      metadata: { method: saved.method, amount: saved.amount, currency: saved.currency },
    });
    return { order: saved, payInfo };
  }

  /** Compute the amount due, allocating a unique USDT amount when needed. */
  private async resolveAmount(
    method: PaymentMethod,
    priceCnyFen: number,
    priceUsdtMicro: number,
  ): Promise<number> {
    if (method !== 'usdt') return priceCnyFen;
    const pending = await this.deps.orders.findPendingByMethod('usdt');
    const taken = pending.map((o) => o.amount);
    return allocateUniqueAmount(priceUsdtMicro, taken, this.deps.usdtUniqueDeltaMax);
  }

  /**
   * Handle an inbound WeChat/Alipay webhook. Returns the body the provider
   * expects in the HTTP response. Throws SignatureError on a bad signature.
   */
  async handleCallback(
    method: PaymentMethod,
    raw: RawCallback,
  ): Promise<{ status: number; contentType: string; body: string }> {
    const provider = this.provider(method);
    const result = await provider.verifyCallback(raw); // throws on bad signature

    if (!result.paid) {
      logger.warn('callback reported non-success', {
        outTradeNo: result.outTradeNo,
        status: result.rawStatus,
      });
      return provider.callbackAck(true); // acknowledge; nothing to fulfil
    }

    // Deduplicate replays before doing any work.
    const isNew = await this.deps.processedEvents.markIfNew(`cb:${method}:${result.eventId}`);
    if (!isNew) {
      logger.info('duplicate callback ignored', { eventId: result.eventId, method });
      return provider.callbackAck(true);
    }

    const order = await this.deps.orders.findByOutTradeNo(result.outTradeNo);
    if (!order) {
      logger.error('callback for unknown order', { outTradeNo: result.outTradeNo });
      return provider.callbackAck(false);
    }

    try {
      await this.applyPayment(order.id, {
        providerTxnId: result.providerTxnId,
        paidAmount: result.paidAmount,
        currency: result.currency,
      });
      return provider.callbackAck(true);
    } catch (err) {
      logger.error('callback fulfilment failed', {
        orderId: order.id,
        error: (err as Error).message,
      });
      // Tell the provider to retry on transient errors; ack on permanent ones.
      if (err instanceof AmountMismatchError) return provider.callbackAck(true);
      return provider.callbackAck(false);
    }
  }

  /**
   * Actively query a provider (used for manual polling and USDT
   * reconciliation) and apply payment if settled. Returns the latest order.
   */
  async syncOrder(orderId: string): Promise<Order> {
    const order = await this.deps.orders.findById(orderId);
    if (!order) throw new NotFoundError(`order not found: ${orderId}`);
    if (order.status !== OrderStatus.PENDING) return order;

    const provider = this.provider(order.method);
    const q = await provider.queryPayment(order);
    if (!q.paid || !q.providerTxnId) return order;

    // For polling-based methods the txn id is the dedupe key.
    const isNew = await this.deps.processedEvents.markIfNew(`txn:${order.method}:${q.providerTxnId}`);
    if (!isNew) return (await this.deps.orders.findById(orderId)) ?? order;

    return this.applyPayment(order.id, {
      providerTxnId: q.providerTxnId,
      paidAmount: q.paidAmount ?? order.amount,
      currency: order.currency,
    });
  }

  /**
   * Core settlement routine — runs under a per-order lock so concurrent
   * callbacks/syncs cannot double-fulfil. Validates currency and amount, marks
   * the order PAID, then fulfils it (FULFILLED + subscription).
   */
  private async applyPayment(
    orderId: string,
    paid: { providerTxnId: string; paidAmount: number; currency: Currency },
  ): Promise<Order> {
    return this.deps.locker.withLock(orderId, async () => {
      const order = await this.deps.orders.findById(orderId);
      if (!order) throw new NotFoundError(`order not found: ${orderId}`);

      // Idempotent: already settled -> return as-is.
      if (order.status === OrderStatus.PAID || order.status === OrderStatus.FULFILLED) {
        return order;
      }
      if (isTerminal(order.status)) {
        throw new ProviderError(`order ${orderId} is ${order.status}; cannot accept payment`);
      }

      if (paid.currency !== order.currency) {
        throw new AmountMismatchError(
          `currency mismatch: paid ${paid.currency}, expected ${order.currency}`,
        );
      }
      // Reject underpayment; overpayment is accepted (and logged).
      if (paid.paidAmount < order.amount) {
        throw new AmountMismatchError(
          `underpayment: paid ${paid.paidAmount}, expected ${order.amount}`,
        );
      }
      if (paid.paidAmount > order.amount) {
        logger.warn('overpayment accepted', {
          orderId,
          paid: paid.paidAmount,
          expected: order.amount,
        });
      }

      const now = this.now();
      const paidOrder: Order = {
        ...order,
        status: assertTransition(order.status, OrderStatus.PAID),
        providerTxnId: paid.providerTxnId,
        paidAt: now,
        updatedAt: now,
      };
      await this.deps.orders.update(paidOrder);

      const { order: fulfilled } = await this.deps.subscriptions.fulfillOrder(paidOrder);
      const finalOrder = await this.deps.orders.update(fulfilled);
      await this.deps.audit?.record({
        action: 'order.fulfilled',
        actor: finalOrder.userId,
        subjectId: finalOrder.id,
        metadata: { providerTxnId: paid.providerTxnId, amount: paid.paidAmount, currency: paid.currency },
      });
      return finalOrder;
    });
  }

  /** Expire pending orders whose payment window has elapsed. Returns count. */
  async expireStaleOrders(): Promise<number> {
    const now = this.now();
    const all = await this.deps.orders.all();
    let count = 0;
    for (const o of all) {
      if (o.status === OrderStatus.PENDING && o.expiresAt <= now) {
        await this.deps.locker.withLock(o.id, async () => {
          const fresh = await this.deps.orders.findById(o.id);
          if (!fresh || fresh.status !== OrderStatus.PENDING) return;
          fresh.status = assertTransition(fresh.status, OrderStatus.EXPIRED);
          fresh.updatedAt = this.now();
          await this.deps.orders.update(fresh);
          count++;
        });
      }
    }
    if (count) logger.info('expired stale orders', { count });
    return count;
  }

  getOrder(orderId: string): Promise<Order | undefined> {
    return this.deps.orders.findById(orderId);
  }
}
