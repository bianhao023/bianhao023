import { logger } from '../utils/logger';

export type NotificationType = 'subscription_expiring' | 'subscription_expired';

export interface NotificationEvent {
  type: NotificationType;
  userId: string;
  subscriptionId: string;
  planId: string;
  /** Epoch millis the subscription expires (or expired). */
  expiresAt: number;
  /** When the notification was raised. */
  at: number;
}

/**
 * Delivers user notifications. Implement this with email / SMS / push / a
 * webhook in production; the default just logs, so the system runs out of the
 * box and is easy to test.
 */
export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

export class LoggerNotifier implements Notifier {
  async notify(event: NotificationEvent): Promise<void> {
    logger.info('notification', { ...event });
  }
}

/** Captures notifications in memory — handy for tests and audits. */
export class RecordingNotifier implements Notifier {
  readonly events: NotificationEvent[] = [];
  async notify(event: NotificationEvent): Promise<void> {
    this.events.push(event);
  }
}
