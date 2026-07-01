import { Order, OrderStatus, Subscription } from '../domain/types';
import { SubscriptionRepository } from '../storage/repository';
import { PlanCatalog } from './plans';
import { assertTransition } from '../core/orderStateMachine';
import { NotFoundError } from '../domain/errors';
import { uuid } from '../utils/ids';
import { logger } from '../utils/logger';

/**
 * Turns a PAID order into VPN access. Fulfilment is idempotent: a re-run for an
 * already-FULFILLED order is a no-op, and extending an existing subscription
 * stacks duration from whichever is later (now or current expiry).
 */
export class SubscriptionService {
  constructor(
    private readonly subs: SubscriptionRepository,
    private readonly plans: PlanCatalog,
    private readonly now: () => number = Date.now,
  ) {}

  async fulfillOrder(order: Order): Promise<{ order: Order; subscription: Subscription }> {
    if (order.status === OrderStatus.FULFILLED) {
      // Already fulfilled — return current subscription unchanged.
      const existing = await this.subs.findActiveByUser(order.userId);
      if (existing) return { order, subscription: existing };
    }

    const plan = this.plans.getPlan(order.planId);
    if (!plan) throw new NotFoundError(`plan not found: ${order.planId}`);

    const now = this.now();
    const existing = await this.subs.findActiveByUser(order.userId);

    let subscription: Subscription;
    const addMs = plan.durationDays * 24 * 60 * 60 * 1000;

    if (existing && existing.expiresAt > now) {
      // Extend the existing subscription from its current expiry.
      subscription = {
        ...existing,
        planId: plan.id,
        expiresAt: existing.expiresAt + addMs,
        trafficGb: plan.trafficGb,
        deviceLimit: plan.deviceLimit,
        orderIds: [...existing.orderIds, order.id],
        active: true,
        // Renewed: allow a fresh reminder for the new period.
        expiryNotifiedAt: undefined,
        updatedAt: now,
      };
      await this.subs.update(subscription);
    } else {
      subscription = {
        id: uuid(),
        userId: order.userId,
        planId: plan.id,
        startsAt: now,
        expiresAt: now + addMs,
        trafficGb: plan.trafficGb,
        deviceLimit: plan.deviceLimit,
        active: true,
        orderIds: [order.id],
        createdAt: now,
        updatedAt: now,
      };
      await this.subs.create(subscription);
    }

    const fulfilled: Order = {
      ...order,
      status: assertTransition(order.status, OrderStatus.FULFILLED),
      updatedAt: now,
    };
    logger.info('order fulfilled', {
      orderId: order.id,
      userId: order.userId,
      planId: plan.id,
      subscriptionExpiresAt: subscription.expiresAt,
    });
    return { order: fulfilled, subscription };
  }
}
