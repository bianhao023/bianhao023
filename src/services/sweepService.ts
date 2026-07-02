import { SweepJob, SweepStatus } from '../domain/deposit';
import { SweepJobRepository } from '../storage/repository';
import { TronTreasury } from '../providers/usdt/tronTreasury';
import { AuditLog } from '../audit/auditLog';
import { uuid } from '../utils/ids';
import { logger } from '../utils/logger';

/** Tunables for the sweep ("二次归集") pipeline. */
export interface SweepPolicy {
  /** Destination (central collection) address. */
  collectionAddress: string;
  /** Skip sweeping balances below this dust threshold (micro-USDT). */
  minSweepMicro: number;
  /** TRX (sun) to send when a deposit address lacks gas for its own transfer. */
  gasTopupSun: number;
  /** Skip gas fueling when the deposit address already holds >= this TRX (sun). */
  gasMinSun: number;
  /** Max processing attempts (errors) before a job is marked FAILED. */
  maxAttempts: number;
  /** Base backoff / confirmation-poll interval (ms). */
  backoffMs: number;
}

export interface SweepServiceDeps {
  jobs: SweepJobRepository;
  treasury: TronTreasury;
  policy: SweepPolicy;
  audit?: AuditLog;
  now?: () => number;
}

/**
 * Drives collection of settled per-order deposits into the central wallet.
 *
 * The pipeline is a state machine advanced one step per call so it tolerates
 * real on-chain confirmation latency (see {@link SweepStatus}):
 *
 *   PENDING → (fuel gas) → GAS_FUELING → (confirm) → SWEEPING → (confirm) → SWEPT
 *
 * A freshly-funded deposit address holds USDT but no TRX, so it cannot pay for
 * its own TRC20 transfer; we top it up with gas from a fee wallet first, wait
 * for that to confirm, then transfer the USDT out. Everything is idempotent and
 * persisted, so a crash/restart resumes each job from its last durable state.
 */
export class SweepService {
  private readonly now: () => number;

  constructor(private readonly deps: SweepServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Enqueue a sweep for a settled order's deposit. Idempotent per order — a
   * second call returns the existing job rather than creating a duplicate.
   */
  async enqueue(input: {
    orderId: string;
    depositIndex: number;
    depositAddress: string;
  }): Promise<SweepJob> {
    const existing = await this.deps.jobs.findByOrderId(input.orderId);
    if (existing) return existing;

    const now = this.now();
    const job: SweepJob = {
      id: uuid(),
      orderId: input.orderId,
      depositIndex: input.depositIndex,
      depositAddress: input.depositAddress,
      collectionAddress: this.deps.policy.collectionAddress,
      amountMicro: 0,
      status: SweepStatus.PENDING,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    };
    logger.info('sweep enqueued', { orderId: job.orderId, depositAddress: job.depositAddress });
    return this.deps.jobs.create(job);
  }

  /**
   * Requeue a FAILED sweep for another attempt (manual operator recovery, e.g.
   * after topping up the fee wallet). Resets it to PENDING, due immediately.
   * Returns the job, or undefined if it does not exist or is not FAILED.
   */
  async retry(orderId: string): Promise<SweepJob | undefined> {
    const job = await this.deps.jobs.findByOrderId(orderId);
    if (!job || job.status !== SweepStatus.FAILED) return undefined;
    const now = this.now();
    Object.assign(job, {
      status: SweepStatus.PENDING,
      attempts: 0,
      lastError: undefined,
      updatedAt: now,
      nextAttemptAt: now,
    });
    logger.info('sweep manually requeued', { orderId });
    return this.deps.jobs.update(job);
  }

  /** Advance every due job by one step. Returns the number processed. */
  async processDue(limit = 50): Promise<number> {
    const due = await this.deps.jobs.due(this.now(), limit);
    for (const job of due) {
      try {
        await this.step(job);
      } catch (err) {
        await this.onError(job, err as Error);
      }
    }
    return due.length;
  }

  /** Advance a single job by one state transition (public for testing). */
  async step(job: SweepJob): Promise<SweepJob> {
    switch (job.status) {
      case SweepStatus.PENDING:
        return this.stepPending(job);
      case SweepStatus.GAS_FUELING:
        return this.stepGasFueling(job);
      case SweepStatus.SWEEPING:
        return this.stepSweeping(job);
      default:
        return job; // terminal — nothing to do
    }
  }

  /** Inspect the deposit, then either fuel gas or sweep directly. */
  private async stepPending(job: SweepJob): Promise<SweepJob> {
    const balance = await this.deps.treasury.trc20BalanceMicro(job.depositAddress);
    if (balance < this.deps.policy.minSweepMicro) {
      logger.info('sweep: nothing to collect', { orderId: job.orderId, balance });
      return this.finish(job, SweepStatus.EMPTY, { amountMicro: balance });
    }
    job.amountMicro = balance;

    const trx = await this.deps.treasury.trxBalanceSun(job.depositAddress);
    if (trx < this.deps.policy.gasMinSun) {
      const gasTxId = await this.deps.treasury.fuelGas(job.depositAddress, this.deps.policy.gasTopupSun);
      logger.info('sweep: fueling gas', { orderId: job.orderId, gasTxId });
      return this.advance(job, SweepStatus.GAS_FUELING, { gasTxId, amountMicro: balance });
    }

    // Already has gas — sweep straight away.
    const sweepTxId = await this.deps.treasury.sweepTrc20(
      job.depositIndex, job.depositAddress, job.collectionAddress, balance,
    );
    logger.info('sweep: transferring', { orderId: job.orderId, sweepTxId, amountMicro: balance });
    return this.advance(job, SweepStatus.SWEEPING, { sweepTxId, amountMicro: balance });
  }

  /** Wait for gas to confirm, then broadcast the TRC20 sweep. */
  private async stepGasFueling(job: SweepJob): Promise<SweepJob> {
    if (!job.gasTxId || !(await this.deps.treasury.isConfirmed(job.gasTxId))) {
      return this.defer(job); // still waiting for gas confirmation
    }
    const sweepTxId = await this.deps.treasury.sweepTrc20(
      job.depositIndex, job.depositAddress, job.collectionAddress, job.amountMicro,
    );
    logger.info('sweep: transferring', { orderId: job.orderId, sweepTxId, amountMicro: job.amountMicro });
    return this.advance(job, SweepStatus.SWEEPING, { sweepTxId });
  }

  /** Wait for the sweep to confirm, then mark the job collected. */
  private async stepSweeping(job: SweepJob): Promise<SweepJob> {
    if (!job.sweepTxId || !(await this.deps.treasury.isConfirmed(job.sweepTxId))) {
      return this.defer(job); // still waiting for sweep confirmation
    }
    await this.deps.audit?.record({
      action: 'usdt.swept',
      subjectId: job.orderId,
      metadata: {
        amountMicro: job.amountMicro,
        depositAddress: job.depositAddress,
        collectionAddress: job.collectionAddress,
        sweepTxId: job.sweepTxId,
      },
    });
    logger.info('sweep: collected', { orderId: job.orderId, amountMicro: job.amountMicro, sweepTxId: job.sweepTxId });
    return this.finish(job, SweepStatus.SWEPT, {});
  }

  /** Move to a new status, clearing the error state and scheduling the next poll. */
  private advance(job: SweepJob, status: SweepStatus, patch: Partial<SweepJob>): Promise<SweepJob> {
    const now = this.now();
    Object.assign(job, patch, {
      status,
      attempts: 0,
      lastError: undefined,
      updatedAt: now,
      nextAttemptAt: now + this.deps.policy.backoffMs,
    });
    return this.deps.jobs.update(job);
  }

  /** Keep the current status but poll again later (normal confirmation wait). */
  private defer(job: SweepJob): Promise<SweepJob> {
    const now = this.now();
    job.updatedAt = now;
    job.nextAttemptAt = now + this.deps.policy.backoffMs;
    return this.deps.jobs.update(job);
  }

  /** Reach a terminal status. */
  private finish(job: SweepJob, status: SweepStatus, patch: Partial<SweepJob>): Promise<SweepJob> {
    const now = this.now();
    Object.assign(job, patch, { status, updatedAt: now, nextAttemptAt: now });
    return this.deps.jobs.update(job);
  }

  /** Record a processing error, backing off and failing after maxAttempts. */
  private async onError(job: SweepJob, err: Error): Promise<void> {
    const now = this.now();
    job.attempts += 1;
    job.lastError = err.message;
    job.updatedAt = now;
    if (job.attempts >= this.deps.policy.maxAttempts) {
      job.status = SweepStatus.FAILED;
      job.nextAttemptAt = now;
      logger.error('sweep failed (retries exhausted)', { orderId: job.orderId, error: err.message });
    } else {
      // Linear backoff on the base interval.
      job.nextAttemptAt = now + this.deps.policy.backoffMs * job.attempts;
      logger.warn('sweep step error; will retry', { orderId: job.orderId, attempts: job.attempts, error: err.message });
    }
    await this.deps.jobs.update(job);
  }
}
