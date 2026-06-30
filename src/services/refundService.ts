import { Order, OrderStatus, PaymentMethod } from '../domain/types';
import { Refund, RefundStatus } from '../domain/refund';
import {
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import { PaymentProvider } from '../providers/provider';
import { Locker, OrderRepository, RefundRepository } from '../storage/repository';
import { assertTransition } from '../core/orderStateMachine';
import { newOutTradeNo, uuid } from '../utils/ids';
import { logger } from '../utils/logger';

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
  locker: Locker;
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

      // Only count settled/processing/manual refunds toward the order total;
      // a hard FAILED refund leaves the order untouched.
      if (result.status !== RefundStatus.FAILED) {
        await this.applyRefundToOrder(order, alreadyRefunded + amount);
      }

      logger.info('refund issued', {
        orderId: order.id,
        refundId: refund.id,
        amount,
        status: refund.status,
      });
      return refund;
    });
  }

  private async applyRefundToOrder(order: Order, newRefundedTotal: number): Promise<void> {
    const now = this.now();
    const updated: Order = { ...order, refundedAmount: newRefundedTotal, updatedAt: now };
    // A full refund moves the order to REFUNDED; partial refunds keep it as-is.
    if (newRefundedTotal >= order.amount) {
      updated.status = assertTransition(order.status, OrderStatus.REFUNDED);
    }
    await this.deps.orders.update(updated);
  }

  listOrderRefunds(orderId: string): Promise<Refund[]> {
    return this.deps.refunds.findByOrder(orderId);
  }
}
