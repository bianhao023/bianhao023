import { SweepService } from './sweepService';
import { logger } from './../utils/logger';

/**
 * Periodically advances due sweep jobs. Each tick drains the repository's work
 * queue (`SweepJobRepository.due`), stepping every job that is ready. Safe to
 * run repeatedly and across instances (jobs are persisted and each step is
 * idempotent); on error the service reschedules the job with backoff.
 */
export class SweepWatcher {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sweeps: SweepService,
    private readonly intervalMs = 30_000,
  ) {}

  /** Run a single pass. Returns the number of jobs advanced. */
  async runOnce(): Promise<number> {
    try {
      return await this.sweeps.processDue();
    } catch (err) {
      logger.warn('sweep watcher pass error', { error: (err as Error).message });
      return 0;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('sweep watcher started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
