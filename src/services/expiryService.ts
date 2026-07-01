import { Subscription } from '../domain/types';
import { SubscriptionRepository } from '../storage/repository';
import { Notifier } from '../notifications/notifier';
import { logger } from '../utils/logger';

export interface ExpiryServiceDeps {
  subscriptions: SubscriptionRepository;
  notifier: Notifier;
  /** How long before expiry to send a renewal reminder. */
  reminderWindowMs: number;
  now?: () => number;
}

/**
 * Manages the subscription lifecycle around expiry:
 *  - sends a one-time renewal reminder within the reminder window;
 *  - deactivates subscriptions once they have expired.
 * Both passes are idempotent and safe to run repeatedly.
 */
export class ExpiryService {
  private readonly now: () => number;

  constructor(private readonly deps: ExpiryServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Notify users whose subscription expires soon (once per period). Returns count. */
  async sendExpiryReminders(): Promise<number> {
    const now = this.now();
    const windowEnd = now + this.deps.reminderWindowMs;
    const active = await this.deps.subscriptions.listActive();
    let sent = 0;
    for (const sub of active) {
      const dueForReminder =
        sub.expiresAt > now &&
        sub.expiresAt <= windowEnd &&
        // Only remind once per period; SubscriptionService clears this on renewal.
        sub.expiryNotifiedAt === undefined;
      if (!dueForReminder) continue;

      await this.deps.notifier.notify({
        type: 'subscription_expiring',
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: sub.planId,
        expiresAt: sub.expiresAt,
        at: now,
      });
      await this.deps.subscriptions.update({ ...sub, expiryNotifiedAt: now });
      sent++;
    }
    if (sent) logger.info('expiry reminders sent', { sent });
    return sent;
  }

  /** Deactivate subscriptions that have passed their expiry. Returns count. */
  async deactivateExpired(): Promise<number> {
    const now = this.now();
    const active = await this.deps.subscriptions.listActive();
    let deactivated = 0;
    for (const sub of active) {
      if (sub.expiresAt > now) continue;
      const updated: Subscription = { ...sub, active: false, updatedAt: now };
      await this.deps.subscriptions.update(updated);
      await this.deps.notifier.notify({
        type: 'subscription_expired',
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: sub.planId,
        expiresAt: sub.expiresAt,
        at: now,
      });
      deactivated++;
    }
    if (deactivated) logger.info('subscriptions deactivated', { deactivated });
    return deactivated;
  }
}
