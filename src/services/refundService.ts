import { Order, OrderStatus, PaymentMethod } from '../domain/types';
import { Refund, RefundStatus } from '../domain/refund';
import {
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import { PaymentProvider, RawCallback } from '../providers/provider';
import {
  Locker,
  OrderRepository,
  ProcessedEventStore,
  RefundRepository,
} from '../storage/repository';
import { assertTransition } from '../core/orderStateMachine';
import { AuditLog } from '../audit/auditLog';
import { newOutTradeNo, uuid } from '../utils/ids';
import { logger } from '../utils/logger';

/** A refund whose funds have actually left us (vs. still PROCESSING). */
function isSettled(status: RefundStatus): boolean {
  return status === RefundStatus.SUCCESS || status === RefundStatus.MANUAL;
}

export interface RefundInput {
  /** Amount to refund in minor units. Defaults to the full remaining amount. */
  amount?: number;
  reason?: string;
  /** Optional idempotency key so a retried refund is not issued twice. */
  outRefundNo?: string;
}

export interface RefundServiceDeps {
  providers: Map<PaymentMethod, PaymentProvider>;
  orders: OrderRepository;
  refunds: RefundRepository;
  processedEvents: ProcessedEventStore;
  locker: Locker;
  audit?: AuditLog;
  now?: () => number;
}

/**
 * Issues refunds against paid orders. Supports partial refunds, prevents
 * over-refunding, is idempotent by outRefundNo, and falls back to a MANUAL
 * refund for methods without an automatic channel (USDT).
 */
export class RefundService {
  private readonly now: () => number;

  constructor(private readonly deps: RefundServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async refundOrder(orderId: string, input: RefundInput = {}): Promise<Refund> {
    // Idempotency: a repeated outRefundNo returns the existing refund.
    if (input.outRefundNo) {
      const existing = await this.deps.refunds.findByOutRefundNo(input.outRefundNo);
      if (existing) return existing;
    }

    return this.deps.locker.withLock(orderId, async () => {
      const order = await this.deps.orders.findById(orderId);
      if (!order) throw new NotFoundError(`order not found: ${orderId}`);

      if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.FULFILLED) {
        throw new InvalidStateError(`order ${orderId} is ${order.status}; only paid orders can be refunded`);
      }

      const alreadyRefunded = order.refundedAmount ?? 0;
      const remaining = order.amount - alreadyRefunded;
      const amount = input.amount ?? remaining;

      if (!Number.isInteger(amount) || amount <= 0) {
        throw new ValidationError(`invalid refund amount: ${amount}`);
      }
      if (amount > remaining) {
        throw new ValidationError(
          `refund amount ${amount} exceeds remaining refundable ${remaining}`,
        );
      }

      const provider = this.deps.providers.get(order.method);
      if (!provider) throw new ValidationError(`payment method not enabled: ${order.method}`);

      const outRefundNo = input.outRefundNo ?? newOutTradeNo('RF');
      const now = this.now();

      const result = provider.refund
        ? await provider.refund(order, {
            outRefundNo,
            amount,
            totalAmount: order.amount,
            currency: order.currency,
            reason: input.reason,
          })
        : // No automatic channel (e.g. USDT): record a manual refund for an operator.
          { status: RefundStatus.MANUAL, rawStatus: 'MANUAL_REQUIRED' };

      const refund: Refund = {
        id: uuid(),
        orderId: order.id,
        outRefundNo,
        amount,
        currency: order.currency,
        reason: input.reason,
        status: result.status,
        providerRefundId: result.providerRefundId,
        rawStatus: result.rawStatus,
        createdAt: now,
        updatedAt: now,
      };
      await this.deps.refunds.create(refund);

      // A hard FAILED refund leaves the order untouched. Otherwise we RESERVE
      // the amount (so it can't be double-refunded), but only transition the
      // order to REFUNDED once the refund is actually settled — a PENDING
      // (e.g. WeChat PROCESSING) refund waits for the async result callback.
      if (result.status !== RefundStatus.FAILED) {
        await this.reserveRefund(order, alreadyRefunded + amount, isSettled(result.status));
      }

      logger.info('refund issued', {
        orderId: order.id,
        refundId: refund.id,
        amount,
        status: refund.status,
      });
      await this.deps.audit?.record({
        action: 'refund.issued',
        actor: order.userId,
        subjectId: order.id,
        metadata: { refundId: refund.id, amount, status: refund.status },
      });
      return refund;
    });
  }

  /**
   * Verify and apply an async refund-result notification (WeChat). On SUCCESS
   * the refund (and order, if fully refunded) is finalised; on FAILED the
   * reserved amount is released. Idempotent and replay-protected.
   */
  async handleRefundCallback(
    method: PaymentMethod,
    raw: RawCallback,
  ): Promise<{ status: number; contentType: string; body: string }> {
    const provider = this.deps.providers.get(method);
    if (!provider || !provider.verifyRefundCallback) {
      throw new ValidationError(`refund callbacks not supported for method: ${method}`);
    }
    const result = await provider.verifyRefundCallback(raw); // throws on bad signature

    const isNew = await this.deps.processedEvents.markIfNew(`rfcb:${method}:${result.eventId}`);
    if (!isNew) {
      logger.info('duplicate refund callback ignored', { eventId: result.eventId, method });
      return provider.callbackAck(true);
    }

    const refund = await this.deps.refunds.findByOutRefundNo(result.outRefundNo);
    if (!refund) {
      logger.error('refund callback for unknown refund', { outRefundNo: result.outRefundNo });
      return provider.callbackAck(false);
    }

    await this.deps.locker.withLock(refund.orderId, async () => {
      const fresh = await this.deps.refunds.findByOutRefundNo(result.outRefundNo);
      if (!fresh) return;
      // Idempotent: only a PENDING refund is awaiting a result.
      if (fresh.status !== RefundStatus.PENDING) return;

      const now = this.now();
      fresh.status = result.status;
      fresh.providerRefundId = result.providerRefundId || fresh.providerRefundId;
      fresh.rawStatus = result.rawStatus;
      fresh.updatedAt = now;
      await this.deps.refunds.update(fresh);

      const order = await this.deps.orders.findById(fresh.orderId);
      if (!order) return;

      if (result.status === RefundStatus.SUCCESS) {
        // The reservation already counts this amount; settle the order if full.
        await this.reserveRefund(order, order.refundedAmount ?? 0, true);
      } else {
        // FAILED: release the previously reserved amount.
        const released = Math.max(0, (order.refundedAmount ?? 0) - fresh.amount);
        await this.deps.orders.update({ ...order, refundedAmount: released, updatedAt: now });
      }
      logger.info('refund callback applied', {
        orderId: order.id,
        refundId: fresh.id,
        status: fresh.status,
      });
    });

    return provider.callbackAck(true);
  }

  /**
   * Record the reserved refund total on the order, transitioning to REFUNDED
   * only when the order is fully refunded AND that refund is settled.
   */
  private async reserveRefund(order: Order, newRefundedTotal: number, settled: boolean): Promise<void> {
    const now = this.now();
    const updated: Order = { ...order, refundedAmount: newRefundedTotal, updatedAt: now };
    if (settled && newRefundedTotal >= order.amount && order.status !== OrderStatus.REFUNDED) {
      updated.status = assertTransition(order.status, OrderStatus.REFUNDED);
    }
    await this.deps.orders.update(updated);
  }

  listOrderRefunds(orderId: string): Promise<Refund[]> {
    return this.deps.refunds.findByOrder(orderId);
  }
}
