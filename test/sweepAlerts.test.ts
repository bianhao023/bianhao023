import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'silent';

import { Alert } from '../src/alerting/alertFormatter';
import {
  formatFailedSweepsAlert,
  formatFeeWalletLowAlert,
  SweepAlertWatcher,
} from '../src/alerting/sweepAlerts';
import { SweepJob, SweepStatus } from '../src/domain/deposit';
import { SweepJobRepository } from '../src/storage/repository';

/** Build a SweepJob with sane defaults, overriding only what a test cares about. */
function makeJob(overrides: Partial<SweepJob> = {}): SweepJob {
  return {
    id: 'j1',
    orderId: 'o1',
    depositIndex: 0,
    depositAddress: 'TDeposit0',
    collectionAddress: 'TCollection',
    amountMicro: 1_000_000,
    status: SweepStatus.FAILED,
    attempts: 3,
    lastError: 'broadcast failed',
    createdAt: 0,
    updatedAt: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

/** Hand-written fake repo: only `all()` matters; the rest are trivial stubs. */
class FakeSweepJobRepository implements SweepJobRepository {
  constructor(private jobs: SweepJob[] = []) {}
  setJobs(jobs: SweepJob[]): void {
    this.jobs = jobs;
  }
  async all(): Promise<SweepJob[]> {
    return this.jobs;
  }
  async create(job: SweepJob): Promise<SweepJob> {
    return job;
  }
  async findById(): Promise<SweepJob | undefined> {
    return undefined;
  }
  async findByOrderId(): Promise<SweepJob | undefined> {
    return undefined;
  }
  async update(job: SweepJob): Promise<SweepJob> {
    return job;
  }
  async due(): Promise<SweepJob[]> {
    return [];
  }
}

/** Fake alert sink that records everything it receives. */
function makeSink(): { alerts: Alert[]; sink: (a: Alert) => Promise<void> } {
  const alerts: Alert[] = [];
  return { alerts, sink: async (a) => void alerts.push(a) };
}

// ---- formatFailedSweepsAlert -------------------------------------------------

test('formatFailedSweepsAlert: undefined when nothing failed', () => {
  assert.equal(formatFailedSweepsAlert([]), undefined);
});

test('formatFailedSweepsAlert: critical with count, total and details', () => {
  const failed = [
    makeJob({ orderId: 'oA', amountMicro: 1_500_000, lastError: 'errA', depositAddress: 'TA' }),
    makeJob({ orderId: 'oB', amountMicro: 2_500_000, lastError: 'errB', depositAddress: 'TB' }),
  ];
  const alert = formatFailedSweepsAlert(failed);
  assert.ok(alert);
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.title, 'USDT sweep failures');
  assert.match(alert.summary, /2 sweep job\(s\) FAILED/);
  assert.match(alert.summary, /4\.000000 USDT/); // 1.5 + 2.5
  assert.equal(alert.details.length, 2);
  assert.equal(alert.details[0], 'order oA (TA): errA');
  assert.equal(alert.details[1], 'order oB (TB): errB');
});

test('formatFailedSweepsAlert: caps detail lines at 50 with an overflow note', () => {
  const failed = Array.from({ length: 60 }, (_, i) =>
    makeJob({ orderId: `o${i}`, amountMicro: 1_000_000 }),
  );
  const alert = formatFailedSweepsAlert(failed);
  assert.ok(alert);
  assert.equal(alert.details.length, 51); // 50 + overflow line
  assert.match(alert.details[50], /and 10 more/);
});

// ---- formatFeeWalletLowAlert -------------------------------------------------

test('formatFeeWalletLowAlert: undefined at or above threshold', () => {
  assert.equal(formatFeeWalletLowAlert(100_000_000, 100_000_000), undefined);
  assert.equal(formatFeeWalletLowAlert(200_000_000, 100_000_000), undefined);
});

test('formatFeeWalletLowAlert: warning when below threshold', () => {
  const alert = formatFeeWalletLowAlert(50_000_000, 100_000_000);
  assert.ok(alert);
  assert.equal(alert.severity, 'warning');
  assert.equal(alert.title, 'USDT fee wallet low');
  assert.match(alert.summary, /50\.000000 TRX/);
  assert.match(alert.summary, /100\.000000 TRX/);
  assert.equal(alert.details.length, 1);
  assert.match(alert.details[0], /top up the fee wallet/);
});

test('formatFeeWalletLowAlert: critical when exactly empty', () => {
  const alert = formatFeeWalletLowAlert(0, 100_000_000);
  assert.ok(alert);
  assert.equal(alert.severity, 'critical');
});

// ---- SweepAlertWatcher.runOnce ----------------------------------------------

test('runOnce: emits critical for FAILED jobs, no repeat, re-emits when count grows', async () => {
  const repo = new FakeSweepJobRepository([
    makeJob({ id: 'j1', orderId: 'o1', status: SweepStatus.FAILED }),
    makeJob({ id: 'j2', orderId: 'o2', status: SweepStatus.SWEPT }),
  ]);
  const { alerts, sink } = makeSink();
  const watcher = new SweepAlertWatcher({ sweepJobs: repo, alertSink: sink, feeThresholdSun: 1 });

  await watcher.runOnce();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');

  await watcher.runOnce(); // identical state -> no repeat
  assert.equal(alerts.length, 1);

  // A new failure appears -> re-alert.
  repo.setJobs([
    makeJob({ id: 'j1', orderId: 'o1', status: SweepStatus.FAILED }),
    makeJob({ id: 'j3', orderId: 'o3', status: SweepStatus.FAILED }),
  ]);
  await watcher.runOnce();
  assert.equal(alerts.length, 2);
  assert.match(alerts[1].summary, /2 sweep job\(s\) FAILED/);
});

test('runOnce: emits a fee-low alert when balance is below threshold', async () => {
  const repo = new FakeSweepJobRepository([]);
  const { alerts, sink } = makeSink();
  const watcher = new SweepAlertWatcher({
    sweepJobs: repo,
    alertSink: sink,
    feeThresholdSun: 100_000_000,
    feeBalanceSun: async () => 10_000_000,
  });

  await watcher.runOnce();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'USDT fee wallet low');
  assert.equal(alerts[0].severity, 'warning');

  await watcher.runOnce(); // still low -> no repeat
  assert.equal(alerts.length, 1);
});

test('runOnce: skips the fee check without throwing when the probe rejects', async () => {
  const repo = new FakeSweepJobRepository([]);
  const { alerts, sink } = makeSink();
  const watcher = new SweepAlertWatcher({
    sweepJobs: repo,
    alertSink: sink,
    feeThresholdSun: 100_000_000,
    feeBalanceSun: async () => {
      throw new Error('rpc down');
    },
  });

  await watcher.runOnce(); // must not throw, must not alert
  assert.equal(alerts.length, 0);
});
