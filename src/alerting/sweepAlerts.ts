/**
 * Alerting for the USDT sweep ("二次归集") pipeline.
 *
 * The sweep pipeline moves each order's settled USDT from its per-order deposit
 * address into the central collection wallet (see {@link SweepJob}). Two
 * conditions need a human:
 *
 *   1. Jobs that reached {@link SweepStatus.FAILED} — retries are exhausted and
 *      real money is stuck at a deposit address until someone intervenes.
 *   2. A low fee (gas) wallet — every sweep first fuels the deposit address with
 *      a little TRX for the TRC20 transfer, so an empty fee wallet silently
 *      stalls *all* sweeps.
 *
 * This module exposes pure formatters (easy to unit-test) plus a
 * {@link SweepAlertWatcher} that periodically scans the job store and emits
 * alerts, mirroring the structure of the webhook watcher.
 */

import { Alert } from './alertFormatter';
import { SweepJob, SweepStatus } from '../domain/deposit';
import { SweepJobRepository } from '../storage/repository';
import { logger } from '../utils/logger';

/** Cap on detail lines per alert, matching {@link ./alertFormatter}. */
const MAX_DETAIL_LINES = 50;

/** Micro-USDT (1e-6 USDT) → USDT string with 6 decimals. */
function formatMicroUsdt(micro: number): string {
  return (micro / 1e6).toFixed(6);
}

/** TRON sun (1e-6 TRX) → TRX string with 6 decimals. */
function formatSun(sun: number): string {
  return (sun / 1e6).toFixed(6);
}

/**
 * Alert for sweep jobs that have exhausted retries and sit in
 * {@link SweepStatus.FAILED}. Returns `undefined` when nothing has failed.
 *
 * Severity is always `critical`: a failed sweep means an order's USDT is stuck
 * at its deposit address and will not reach the collection wallet without
 * operator action. The summary reports the failure count and the total stuck
 * amount (micro-USDT); details list up to {@link MAX_DETAIL_LINES} jobs, each
 * as `order <orderId> (<depositAddress>): <lastError>`.
 */
export function formatFailedSweepsAlert(failed: SweepJob[]): Alert | undefined {
  if (failed.length === 0) return undefined;

  const totalMicro = failed.reduce((sum, job) => sum + job.amountMicro, 0);
  const summary =
    `${failed.length} sweep job(s) FAILED — ${formatMicroUsdt(totalMicro)} USDT stuck ` +
    `(${totalMicro} micro-USDT)`;

  const details = failed
    .slice(0, MAX_DETAIL_LINES)
    .map((job) => `order ${job.orderId} (${job.depositAddress}): ${job.lastError ?? 'unknown error'}`);
  if (failed.length > MAX_DETAIL_LINES) {
    details.push(`… and ${failed.length - MAX_DETAIL_LINES} more`);
  }

  return { severity: 'critical', title: 'USDT sweep failures', summary, details };
}

/**
 * Alert for a fee (gas) wallet whose balance has dropped below the operating
 * threshold. Returns `undefined` while `balanceSun >= thresholdSun`.
 *
 * Severity is `warning` when low but non-empty, escalating to `critical` when
 * the wallet is exactly empty (`balanceSun === 0`) — at zero, no sweep can be
 * fueled and the whole pipeline is stalled. Amounts are shown in TRX
 * (sun / 1e6).
 *
 * @param balanceSun   Current fee-wallet balance, in sun.
 * @param thresholdSun Minimum balance (sun) at which we still consider healthy.
 */
export function formatFeeWalletLowAlert(balanceSun: number, thresholdSun: number): Alert | undefined {
  if (balanceSun >= thresholdSun) return undefined;

  const severity: Alert['severity'] = balanceSun === 0 ? 'critical' : 'warning';
  const summary =
    `fee wallet balance ${formatSun(balanceSun)} TRX is below the ${formatSun(thresholdSun)} TRX threshold`;

  return {
    severity,
    title: 'USDT fee wallet low',
    summary,
    details: ['top up the fee wallet to keep sweeps flowing'],
  };
}

/** Dependencies for {@link SweepAlertWatcher}. */
export interface SweepAlertWatcherDeps {
  /** Store to scan for FAILED sweep jobs. */
  sweepJobs: SweepJobRepository;
  /** Delivers a raised alert (log, email, page, …). */
  alertSink: (alert: Alert) => Promise<void>;
  /** Minimum healthy fee-wallet balance, in sun. */
  feeThresholdSun: number;
  /**
   * Optional fee-wallet balance probe (sun). When omitted the fee check is
   * skipped entirely. May return `undefined` (or reject) when the balance is
   * momentarily unavailable — the watcher then skips the fee check that tick.
   */
  feeBalanceSun?: () => Promise<number | undefined>;
  /** Poll interval in ms (default 60_000). */
  intervalMs?: number;
}

/**
 * Periodically scans the sweep job store for FAILED jobs and (when a balance
 * probe is supplied) checks the fee wallet, emitting alerts through
 * `alertSink`.
 *
 * Structure mirrors the webhook watcher: `runOnce()` does the work, `start()` /
 * `stop()` manage a self-unref-ing interval, and guard fields stop the same
 * condition re-alerting every tick. Re-alerting happens only when a condition
 * *newly appears or worsens*; the guard resets once the condition clears.
 *
 * `runOnce()` never throws — any monitoring failure is logged via
 * `logger.warn`, because a broken watcher must never take down the process.
 */
export class SweepAlertWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;

  /** FAILED count at which we last alerted; only re-alert when it grows. */
  private lastAlertedFailedCount = 0;
  /** Whether the fee wallet was low at the last alert, so we don't repeat. */
  private feeLowAlerted = false;

  constructor(private readonly deps: SweepAlertWatcherDeps) {
    this.intervalMs = deps.intervalMs ?? 60_000;
  }

  /**
   * Perform one monitoring pass: alert on newly-appeared/worsened FAILED sweeps
   * and, if a balance probe is configured, on a low fee wallet. Swallows and
   * logs any error so scheduling never breaks.
   */
  async runOnce(): Promise<void> {
    try {
      await this.checkFailedSweeps();
      await this.checkFeeWallet();
    } catch (err) {
      logger.warn('sweep alert watcher tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Alert on FAILED jobs, re-alerting only when their count grows. */
  private async checkFailedSweeps(): Promise<void> {
    const all = await this.deps.sweepJobs.all();
    const failed = all.filter((job) => job.status === SweepStatus.FAILED);

    if (failed.length === 0) {
      this.lastAlertedFailedCount = 0; // condition cleared — reset guard
      return;
    }
    if (failed.length <= this.lastAlertedFailedCount) return; // no new failures

    const alert = formatFailedSweepsAlert(failed);
    if (alert) await this.deps.alertSink(alert);
    this.lastAlertedFailedCount = failed.length;
  }

  /** Alert on a low fee wallet; gracefully skip when the probe is unavailable. */
  private async checkFeeWallet(): Promise<void> {
    const probe = this.deps.feeBalanceSun;
    if (!probe) return;

    let balanceSun: number | undefined;
    try {
      balanceSun = await probe();
    } catch (err) {
      logger.warn('fee wallet balance probe failed; skipping fee check', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (balanceSun === undefined) return; // balance unknown this tick — skip

    const alert = formatFeeWalletLowAlert(balanceSun, this.deps.feeThresholdSun);
    if (!alert) {
      this.feeLowAlerted = false; // healthy again — reset guard
      return;
    }
    if (this.feeLowAlerted) return; // already alerted while still low

    await this.deps.alertSink(alert);
    this.feeLowAlerted = true;
  }

  /** Begin polling on a self-unref-ing interval (idempotent). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('sweep alert watcher started', { intervalMs: this.intervalMs });
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
