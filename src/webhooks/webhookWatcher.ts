import { WebhookDispatcher } from './outbound';
import { logger } from '../utils/logger';

/**
 * Periodically drains due webhook deliveries (retries with backoff happen
 * inside the dispatcher). In production you might instead trigger
 * POST /internal/webhooks/process from a cron; this self-contained watcher
 * works for single-process runs.
 */
export class WebhookWatcher {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly intervalMs = 15_000,
  ) {}

  async runOnce(): Promise<void> {
    const result = await this.dispatcher.processDue();
    if (result.delivered || result.dead) {
      logger.info('webhook deliveries processed', result);
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
