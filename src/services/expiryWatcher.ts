import { ExpiryService } from './expiryService';
import { logger } from '../utils/logger';

/**
 * Periodically runs the subscription expiry passes (reminders + deactivation).
 * In production you might instead drive ExpiryService from a cron job hitting an
 * internal endpoint; this self-contained watcher works for single-process runs.
 */
export class ExpiryWatcher {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly expiry: ExpiryService,
    private readonly intervalMs = 3_600_000, // hourly
  ) {}

  async runOnce(): Promise<{ reminders: number; deactivated: number }> {
    const reminders = await this.expiry.sendExpiryReminders();
    const deactivated = await this.expiry.deactivateExpired();
    return { reminders, deactivated };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('expiry watcher started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
