import { WebhookDispatcher } from './outbound';
import { Alert, formatDeadLetterAlert } from '../alerting/alertFormatter';
import { logger } from '../utils/logger';

/**
 * Periodically drains due webhook deliveries (retries with backoff happen
 * inside the dispatcher) and raises an alert when the dead-letter queue grows.
 * In production you might instead trigger POST /internal/webhooks/process from
 * a cron; this self-contained watcher works for single-process runs.
 */
export class WebhookWatcher {
  private timer?: ReturnType<typeof setInterval>;
  /** Depth at which we last alerted, so we don't re-alert every tick. */
  private lastAlertedDead = 0;

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly intervalMs = 15_000,
    /** Deliver an alert (log-only — we must NOT push a webhook about webhook failures). */
    private readonly onAlert: (alert: Alert) => void = defaultLogAlert,
  ) {}

  async runOnce(): Promise<void> {
    const result = await this.dispatcher.processDue();
    if (result.delivered || result.dead) {
      logger.info('webhook deliveries processed', result);
    }
    // Alert on a growing dead-letter queue (only when the depth changes).
    const { count, sampleIds } = await this.dispatcher.deadLetterSummary();
    if (count > 0 && count !== this.lastAlertedDead) {
      const alert = formatDeadLetterAlert(count, sampleIds);
      if (alert) this.onAlert(alert);
      this.lastAlertedDead = count;
    } else if (count === 0) {
      this.lastAlertedDead = 0; // reset once drained/retried
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('webhook watcher started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function defaultLogAlert(alert: Alert): void {
  logger.warn('alert', { title: alert.title, summary: alert.summary, details: alert.details });
}
