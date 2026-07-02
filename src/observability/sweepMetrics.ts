/**
 * Prometheus gauges for the USDT sweep ("二次归集") pipeline.
 *
 * The sweep pipeline collects settled per-order deposits into a central wallet
 * (see {@link SweepJob} / {@link SweepStatus}). This module registers a single
 * scrape-time collector on the shared {@link Metrics} registry that recomputes
 * every gauge from the current job set. It mirrors the collector style used in
 * `src/container.ts` (build the {@link Gauge} objects once, then register ONE
 * async collector that `.reset()`s and re-`.set()`s each series per scrape).
 *
 * All metric names are prefixed `vpn_` to match the rest of the registry.
 *
 * Registered gauges:
 *  - `vpn_sweep_jobs{status}`      — job count per {@link SweepStatus}. Every
 *    status value is emitted each scrape (0 when absent) so dashboards never see
 *    a series silently vanish.
 *  - `vpn_sweep_pending`           — count of NON-terminal jobs (see
 *    {@link isSweepTerminal}); i.e. work still queued for the watcher.
 *  - `vpn_sweep_failed`            — count of jobs in {@link SweepStatus.FAILED}.
 *  - `vpn_sweep_amount_micro_total`— sum of `amountMicro` over jobs that reached
 *    {@link SweepStatus.SWEPT} (total value collected, in micro-USDT).
 *  - `vpn_fee_wallet_trx_sun`      — fee-wallet TRX balance in sun, for
 *    gas-exhaustion monitoring. Only emitted when `feeBalanceSun` is supplied
 *    AND resolves to a number.
 *
 * The whole collector body is defensive: any error from the repository or the
 * fee-balance provider is caught and logged at `warn` rather than thrown out of
 * the scrape (a failing collector would otherwise break the entire `/metrics`
 * response).
 */

import { Metrics } from './metrics';
import { SweepJobRepository } from '../storage/repository';
import { SweepJob, SweepStatus, isSweepTerminal } from '../domain/deposit';
import { logger } from '../utils/logger';

/** Dependencies for {@link registerSweepMetrics}. */
export interface SweepMetricsDeps {
  /** The shared metrics registry to register gauges + the collector on. */
  metrics: Metrics;
  /** Source of sweep jobs; `all()` is read once per scrape. */
  sweepJobs: SweepJobRepository;
  /** Optional: fee-wallet TRX balance (sun) for gas-exhaustion monitoring. */
  feeBalanceSun?: () => Promise<number | undefined>;
}

/**
 * Register the sweep-pipeline gauges and their scrape-time collector on
 * `deps.metrics`. Call once at wiring time (e.g. from the DI container).
 *
 * @param deps See {@link SweepMetricsDeps}.
 */
export function registerSweepMetrics(deps: SweepMetricsDeps): void {
  const { metrics, sweepJobs, feeBalanceSun } = deps;

  // Build the gauge objects once; the collector recomputes their series.
  const jobsGauge = metrics.gauge('vpn_sweep_jobs', 'Sweep job count by status', ['status']);
  const pendingGauge = metrics.gauge('vpn_sweep_pending', 'Non-terminal (pending) sweep jobs');
  const failedGauge = metrics.gauge('vpn_sweep_failed', 'Failed sweep jobs');
  const amountGauge = metrics.gauge(
    'vpn_sweep_amount_micro_total',
    'Total swept amount in micro-USDT (jobs in SWEPT status)',
  );
  const feeWalletGauge = metrics.gauge('vpn_fee_wallet_trx_sun', 'Fee-wallet TRX balance in sun');

  metrics.addCollector(async () => {
    try {
      const jobs: SweepJob[] = await sweepJobs.all();

      // Per-status counts. Seed every enum value with 0 so absent statuses are
      // still reported (and stale series cleared via reset()).
      const counts: Record<string, number> = {};
      for (const status of Object.values(SweepStatus)) counts[status] = 0;

      let pending = 0;
      let failed = 0;
      let sweptAmountMicro = 0;
      for (const job of jobs) {
        counts[job.status] = (counts[job.status] ?? 0) + 1;
        if (!isSweepTerminal(job.status)) pending += 1;
        if (job.status === SweepStatus.FAILED) failed += 1;
        if (job.status === SweepStatus.SWEPT) sweptAmountMicro += job.amountMicro;
      }

      jobsGauge.reset();
      for (const status of Object.values(SweepStatus)) jobsGauge.set({ status }, counts[status]);
      pendingGauge.set({}, pending);
      failedGauge.set({}, failed);
      amountGauge.set({}, sweptAmountMicro);
    } catch (err) {
      // A failing collector would break the entire /metrics scrape — swallow.
      logger.warn('sweep metrics collector failed', { err: String(err) });
    }

    // Fee-wallet balance is independent of the repo and may be absent; guard it
    // separately so a balance-provider failure never masks the job gauges.
    if (feeBalanceSun) {
      try {
        const sun = await feeBalanceSun();
        if (typeof sun === 'number') feeWalletGauge.set({}, sun);
      } catch (err) {
        logger.warn('fee-wallet balance collector failed', { err: String(err) });
      }
    }
  });
}
