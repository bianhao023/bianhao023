process.env.LOG_LEVEL = 'silent';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/observability/metrics';
import { registerSweepMetrics } from '../src/observability/sweepMetrics';
import { SweepJobRepository } from '../src/storage/repository';
import { SweepJob, SweepStatus } from '../src/domain/deposit';

/** Build a SweepJob with only the fields the collector reads set meaningfully. */
function job(status: SweepStatus, amountMicro: number, id = String(Math.random())): SweepJob {
  return {
    id,
    orderId: 'o-' + id,
    depositIndex: 0,
    depositAddress: 'Tdep',
    collectionAddress: 'Tcol',
    amountMicro,
    status,
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    nextAttemptAt: 0,
  };
}

/** In-memory fake: only `all()` has real behaviour; the rest satisfy the interface. */
class FakeSweepRepo implements SweepJobRepository {
  constructor(private jobs: SweepJob[]) {}
  async all(): Promise<SweepJob[]> {
    return this.jobs;
  }
  async create(j: SweepJob): Promise<SweepJob> {
    return j;
  }
  async findById(): Promise<SweepJob | undefined> {
    return undefined;
  }
  async findByOrderId(): Promise<SweepJob | undefined> {
    return undefined;
  }
  async update(j: SweepJob): Promise<SweepJob> {
    return j;
  }
  async due(): Promise<SweepJob[]> {
    return [];
  }
}

/** Extract the value of a single (labelled or unlabelled) gauge series from render() output. */
function value(out: string, series: string): number | undefined {
  const line = out.split('\n').find((l) => l.startsWith(series + ' ') || l === series);
  if (!line) return undefined;
  const parts = line.split(' ');
  return Number(parts[parts.length - 1]);
}

test('per-status counts, pending, failed, and swept amount are derived from all()', async () => {
  const metrics = new Metrics();
  const repo = new FakeSweepRepo([
    job(SweepStatus.PENDING, 100),
    job(SweepStatus.PENDING, 200),
    job(SweepStatus.GAS_FUELING, 0),
    job(SweepStatus.SWEEPING, 0),
    job(SweepStatus.SWEPT, 1000),
    job(SweepStatus.SWEPT, 2500),
    job(SweepStatus.EMPTY, 0),
    job(SweepStatus.FAILED, 42),
  ]);
  registerSweepMetrics({ metrics, sweepJobs: repo });

  // render() runs all registered collectors, then serialises every metric.
  const out = await metrics.render();

  // Per-status counts (every status present each scrape).
  assert.equal(value(out, 'vpn_sweep_jobs{status="PENDING"}'), 2);
  assert.equal(value(out, 'vpn_sweep_jobs{status="GAS_FUELING"}'), 1);
  assert.equal(value(out, 'vpn_sweep_jobs{status="SWEEPING"}'), 1);
  assert.equal(value(out, 'vpn_sweep_jobs{status="SWEPT"}'), 2);
  assert.equal(value(out, 'vpn_sweep_jobs{status="EMPTY"}'), 1);
  assert.equal(value(out, 'vpn_sweep_jobs{status="FAILED"}'), 1);

  // Non-terminal = PENDING(2) + GAS_FUELING(1) + SWEEPING(1) = 4; terminal excluded.
  assert.equal(value(out, 'vpn_sweep_pending'), 4);
  assert.equal(value(out, 'vpn_sweep_failed'), 1);
  // Swept sum = 1000 + 2500 (FAILED amount 42 is NOT counted).
  assert.equal(value(out, 'vpn_sweep_amount_micro_total'), 3500);
});

test('absent statuses report 0 and stale series are cleared between scrapes', async () => {
  const metrics = new Metrics();
  const jobs: SweepJob[] = [job(SweepStatus.PENDING, 10)];
  const repo = new FakeSweepRepo(jobs);
  registerSweepMetrics({ metrics, sweepJobs: repo });

  let out = await metrics.render();
  assert.equal(value(out, 'vpn_sweep_jobs{status="PENDING"}'), 1);
  assert.equal(value(out, 'vpn_sweep_jobs{status="SWEPT"}'), 0);
  assert.equal(value(out, 'vpn_sweep_pending'), 1);

  // Mutate underlying data: the PENDING job becomes SWEPT.
  jobs[0] = job(SweepStatus.SWEPT, 10, jobs[0].id);
  out = await metrics.render();
  assert.equal(value(out, 'vpn_sweep_jobs{status="PENDING"}'), 0); // stale series cleared
  assert.equal(value(out, 'vpn_sweep_jobs{status="SWEPT"}'), 1);
  assert.equal(value(out, 'vpn_sweep_pending'), 0);
});

test('fee-wallet gauge is set when the provider resolves to a number', async () => {
  const metrics = new Metrics();
  const repo = new FakeSweepRepo([]);
  registerSweepMetrics({ metrics, sweepJobs: repo, feeBalanceSun: async () => 12345 });

  const out = await metrics.render();
  assert.equal(value(out, 'vpn_fee_wallet_trx_sun'), 12345);
});

test('fee-wallet gauge is skipped (no series) when the provider returns undefined', async () => {
  const metrics = new Metrics();
  const repo = new FakeSweepRepo([]);
  registerSweepMetrics({ metrics, sweepJobs: repo, feeBalanceSun: async () => undefined });

  const out = await metrics.render();
  assert.equal(value(out, 'vpn_fee_wallet_trx_sun'), undefined);
  // Job gauges still produced.
  assert.equal(value(out, 'vpn_sweep_pending'), 0);
});

test('a throwing fee-wallet provider does not crash the scrape', async () => {
  const metrics = new Metrics();
  const repo = new FakeSweepRepo([job(SweepStatus.PENDING, 5)]);
  registerSweepMetrics({
    metrics,
    sweepJobs: repo,
    feeBalanceSun: async () => {
      throw new Error('rpc down');
    },
  });

  const out = await metrics.render();
  // Fee gauge absent, but the rest of the scrape succeeded.
  assert.equal(value(out, 'vpn_fee_wallet_trx_sun'), undefined);
  assert.equal(value(out, 'vpn_sweep_pending'), 1);
});

test('a throwing repository is swallowed and does not crash the scrape', async () => {
  const metrics = new Metrics();
  const repo: SweepJobRepository = {
    all: async () => {
      throw new Error('db down');
    },
    create: async (j) => j,
    findById: async () => undefined,
    findByOrderId: async () => undefined,
    update: async (j) => j,
    due: async () => [],
  };
  registerSweepMetrics({ metrics, sweepJobs: repo, feeBalanceSun: async () => 7 });

  // Should not throw; fee-wallet gauge is guarded separately and still set.
  const out = await metrics.render();
  assert.equal(value(out, 'vpn_fee_wallet_trx_sun'), 7);
});
