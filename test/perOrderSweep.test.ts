import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { AppConfig } from '../src/config';
import { buildContainer } from '../src/container';
import { createHttpServer } from '../src/api/server';
import { OrderStatus } from '../src/domain/types';
import { SweepStatus } from '../src/domain/deposit';
import { SweepService } from '../src/services/sweepService';
import { MemorySweepJobRepository } from '../src/storage/memoryStore';
import { Trc20Transfer, TronChainClient } from '../src/providers/usdt/usdtTron';
import { TronWallet, TronTreasury, DerivedAddress } from '../src/providers/usdt/tronTreasury';

process.env.LOG_LEVEL = 'silent';

/**
 * A single in-memory fake that plays all three TRON roles: the HD wallet
 * (address derivation), the chain client (deposit detection), and the treasury
 * (balances / gas / sweeps). Deterministic and synchronous for tests.
 */
class FakeTron implements TronWallet, TronChainClient, TronTreasury {
  usdt = new Map<string, number>(); // address -> micro-USDT
  trx = new Map<string, number>(); // address -> sun
  private transfers: Trc20Transfer[] = [];
  private txConfirmed = new Map<string, boolean>();
  private seq = 0;
  /** Force sweepTrc20 to throw, to exercise the retry/failure path. */
  failSweep = false;
  /** Number of isConfirmed calls to answer false before returning true. */
  confirmAfter = 0;
  private confirmCalls = new Map<string, number>();

  async deriveDepositAddress(index: number): Promise<DerivedAddress> {
    return { index, address: `TFAKE${index}` };
  }

  /** Simulate a user depositing USDT to their per-order address. */
  deposit(address: string, amountMicro: number, txId: string): void {
    this.usdt.set(address, (this.usdt.get(address) ?? 0) + amountMicro);
    this.transfers.push({ txId, to: address, from: 'Tsender', valueMicro: amountMicro, timestampMs: Date.now(), confirmed: true });
  }

  async getIncomingTransfers(address: string): Promise<Trc20Transfer[]> {
    return this.transfers.filter((t) => t.to === address);
  }

  async trc20BalanceMicro(address: string): Promise<number> {
    return this.usdt.get(address) ?? 0;
  }
  async trxBalanceSun(address: string): Promise<number> {
    return this.trx.get(address) ?? 0;
  }
  async fuelGas(toAddress: string, amountSun: number): Promise<string> {
    this.trx.set(toAddress, (this.trx.get(toAddress) ?? 0) + amountSun);
    const id = `gas-${++this.seq}`;
    this.txConfirmed.set(id, true);
    return id;
  }
  async sweepTrc20(_index: number, fromAddress: string, toAddress: string, amountMicro: number): Promise<string> {
    if (this.failSweep) throw new Error('simulated broadcast failure');
    const have = this.usdt.get(fromAddress) ?? 0;
    assert.ok(have >= amountMicro, 'cannot sweep more than the balance');
    this.usdt.set(fromAddress, have - amountMicro);
    this.usdt.set(toAddress, (this.usdt.get(toAddress) ?? 0) + amountMicro);
    const id = `sweep-${++this.seq}`;
    this.txConfirmed.set(id, true);
    return id;
  }
  async isConfirmed(txId: string): Promise<boolean> {
    if (!this.txConfirmed.get(txId)) return false;
    const n = (this.confirmCalls.get(txId) ?? 0) + 1;
    this.confirmCalls.set(txId, n);
    return n > this.confirmAfter;
  }
}

const COLLECTION = 'TCollectionWallet0000000000000000';

function perOrderConfig(): AppConfig {
  return {
    port: 0,
    orderTtlMinutes: 15,
    enabledMethods: ['usdt'],
    expiryReminderDays: 3,
    processedEventTtlDays: 7,
    shutdownTimeoutMs: 10000,
    rateLimit: { enabled: false, max: 100, windowMs: 60_000 },
    security: { corsOrigins: ['*'], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
    usdt: {
      addressMode: 'per-order',
      receivingAddress: '',
      collectionAddress: COLLECTION,
      hdStartIndex: 0,
      // backoffMs: 0 keeps jobs immediately due so processDue advances each call.
      sweep: { minSweepMicro: 1_000_000, gasTopupSun: 15_000_000, gasMinSun: 10_000_000, maxAttempts: 3, backoffMs: 0 },
      contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      apiBase: 'https://api.trongrid.io',
      minConfirmations: 19,
      uniqueAmountMaxDelta: 9999,
    },
  };
}

test('end-to-end: per-order address, settlement, then sweep to collection wallet', async () => {
  const tron = new FakeTron();
  const jobs = new MemorySweepJobRepository();
  const container = buildContainer(perOrderConfig(), {
    chainClient: tron,
    tronWallet: tron,
    tronTreasury: tron,
    sweepJobs: jobs,
  });

  // 1. Create a USDT order — it gets its own derived deposit address.
  const { order, payInfo } = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'usdt' });
  const depositAddress = order.metadata['depositAddress'];
  assert.equal(depositAddress, 'TFAKE1');
  assert.equal(payInfo.payTarget, depositAddress, 'pay target is the per-order address');
  assert.equal(order.metadata['depositIndex'], '1');

  // 2. The user deposits the exact amount to that address.
  tron.deposit(depositAddress, order.amount, 'txdep-1');

  // 3. Reconcile — the order settles (PAID/FULFILLED) and a sweep is enqueued.
  const settled = await container.payments.syncOrder(order.id);
  assert.equal(settled.status, OrderStatus.FULFILLED);
  const job = await jobs.findByOrderId(order.id);
  assert.ok(job, 'a sweep job was enqueued on settlement');
  assert.equal(job!.status, SweepStatus.PENDING);

  // 4. Drive the sweep pipeline: PENDING -> GAS_FUELING -> SWEEPING -> SWEPT.
  for (let i = 0; i < 5; i++) {
    const j = await jobs.findByOrderId(order.id);
    if (j && j.status === SweepStatus.SWEPT) break;
    await container.sweepService!.processDue();
  }

  const final = await jobs.findByOrderId(order.id);
  assert.equal(final!.status, SweepStatus.SWEPT);
  assert.ok(final!.gasTxId, 'gas was fueled (deposit address had no TRX)');
  assert.ok(final!.sweepTxId, 'sweep transaction recorded');

  // 5. Funds actually moved: collection wallet holds the USDT, deposit is empty.
  assert.equal(await tron.trc20BalanceMicro(COLLECTION), order.amount);
  assert.equal(await tron.trc20BalanceMicro(depositAddress), 0);
});

test('two orders get distinct addresses; the plain plan price is charged (no unique delta)', async () => {
  const tron = new FakeTron();
  const container = buildContainer(perOrderConfig(), { chainClient: tron, tronWallet: tron, tronTreasury: tron });
  const a = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'usdt' });
  const b = await container.payments.createOrder({ userId: 'u2', planId: 'monthly', method: 'usdt' });
  assert.notEqual(a.order.metadata['depositAddress'], b.order.metadata['depositAddress']);
  // Both charged the identical plan price — the address, not the amount, disambiguates.
  assert.equal(a.order.amount, b.order.amount);
});

// ── SweepService unit tests (fine-grained state machine) ────────────────────

function sweepSetup(overrides?: { failSweep?: boolean }): { tron: FakeTron; jobs: MemorySweepJobRepository; svc: SweepService } {
  const tron = new FakeTron();
  if (overrides?.failSweep) tron.failSweep = true;
  const jobs = new MemorySweepJobRepository();
  const svc = new SweepService({
    jobs,
    treasury: tron,
    policy: { collectionAddress: COLLECTION, minSweepMicro: 1_000_000, gasTopupSun: 15_000_000, gasMinSun: 10_000_000, maxAttempts: 3, backoffMs: 0 },
  });
  return { tron, jobs, svc };
}

test('sweep skips gas fueling when the deposit already holds enough TRX', async () => {
  const { tron, svc } = sweepSetup();
  const addr = 'TFAKE7';
  tron.usdt.set(addr, 5_000_000);
  tron.trx.set(addr, 20_000_000); // already funded above gasMinSun
  const job = await svc.enqueue({ orderId: 'o7', depositIndex: 7, depositAddress: addr });
  await svc.step(job); // PENDING -> SWEEPING directly (no gas step)
  assert.equal(job.status, SweepStatus.SWEEPING);
  assert.equal(job.gasTxId, undefined, 'no gas fueling happened');
  await svc.step(job); // SWEEPING -> SWEPT
  assert.equal(job.status, SweepStatus.SWEPT);
  assert.equal(await tron.trc20BalanceMicro(COLLECTION), 5_000_000);
});

test('sweep marks EMPTY when the balance is below the dust threshold', async () => {
  const { tron, svc } = sweepSetup();
  const addr = 'TFAKE8';
  tron.usdt.set(addr, 500_000); // below minSweepMicro (1 USDT)
  const job = await svc.enqueue({ orderId: 'o8', depositIndex: 8, depositAddress: addr });
  await svc.step(job);
  assert.equal(job.status, SweepStatus.EMPTY);
});

test('sweep retries then FAILS after maxAttempts when broadcast keeps throwing', async () => {
  const { tron, jobs, svc } = sweepSetup({ failSweep: true });
  const addr = 'TFAKE9';
  tron.usdt.set(addr, 5_000_000);
  tron.trx.set(addr, 20_000_000); // enough gas so it goes straight to the (failing) sweep
  await svc.enqueue({ orderId: 'o9', depositIndex: 9, depositAddress: addr });
  // Each processDue attempt hits the throw and increments attempts; FAILS at maxAttempts (3).
  for (let i = 0; i < 3; i++) await svc.processDue();
  const job = await jobs.findByOrderId('o9');
  assert.equal(job!.status, SweepStatus.FAILED);
  assert.equal(job!.attempts, 3);
  assert.match(job!.lastError ?? '', /broadcast failure/);
});

test('enqueue is idempotent per order', async () => {
  const { svc } = sweepSetup();
  const a = await svc.enqueue({ orderId: 'o10', depositIndex: 10, depositAddress: 'TFAKE10' });
  const b = await svc.enqueue({ orderId: 'o10', depositIndex: 10, depositAddress: 'TFAKE10' });
  assert.equal(a.id, b.id);
});

test('gas fueling waits for confirmation before sweeping', async () => {
  const { tron, svc } = sweepSetup();
  tron.confirmAfter = 1; // first isConfirmed() call returns false
  const addr = 'TFAKE11';
  tron.usdt.set(addr, 3_000_000); // no TRX -> must fuel gas
  const job = await svc.enqueue({ orderId: 'o11', depositIndex: 11, depositAddress: addr });
  await svc.step(job); // PENDING -> GAS_FUELING
  assert.equal(job.status, SweepStatus.GAS_FUELING);
  await svc.step(job); // gas not yet confirmed -> stays GAS_FUELING
  assert.equal(job.status, SweepStatus.GAS_FUELING);
  await svc.step(job); // now confirmed -> SWEEPING
  assert.equal(job.status, SweepStatus.SWEEPING);
});

// ── Admin ops surface (list / retry a FAILED sweep over HTTP) ────────────────

async function getJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

test('admin can list and retry a FAILED sweep over HTTP; shared mode returns 404', async () => {
  const tron = new FakeTron();
  tron.failSweep = true; // force the sweep to fail so we can exercise retry
  const cfg = perOrderConfig();
  cfg.adminToken = 'secret-admin';
  const container = buildContainer(cfg, { chainClient: tron, tronWallet: tron, tronTreasury: tron });
  const server = createHttpServer(container);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { Authorization: 'Bearer secret-admin' };

  try {
    // Settle an order, then drive its sweep to FAILED (maxAttempts=3).
    const { order } = await container.payments.createOrder({ userId: 'u1', planId: 'monthly', method: 'usdt' });
    tron.deposit(order.metadata['depositAddress'], order.amount, 'dep-1');
    tron.trx.set(order.metadata['depositAddress'], 20_000_000); // pre-funded gas -> sweep fails directly
    await container.payments.syncOrder(order.id);
    for (let i = 0; i < 3; i++) await container.sweepService!.processDue();

    // List FAILED sweeps.
    const listRes = await fetch(`${base}/admin/sweeps?status=FAILED`, { headers: auth });
    assert.equal(listRes.status, 200);
    const list = await getJson(listRes);
    assert.equal(list.total, 1);
    assert.equal(list.items[0].orderId, order.id);
    assert.equal(list.items[0].status, 'FAILED');

    // Requeue it (after "topping up" — clear the failure flag), then finish it.
    tron.failSweep = false;
    const retryRes = await fetch(`${base}/admin/sweeps/${order.id}/retry`, { method: 'POST', headers: auth });
    assert.equal(retryRes.status, 200);
    assert.equal((await getJson(retryRes)).requeued, true);

    for (let i = 0; i < 5; i++) await container.sweepService!.processDue();
    assert.equal(await tron.trc20BalanceMicro(COLLECTION), order.amount, 'funds collected after retry');

    // Unknown order -> 404.
    const missRes = await fetch(`${base}/admin/sweeps/nope/retry`, { method: 'POST', headers: auth });
    assert.equal(missRes.status, 404);

    // Unauthorized without the admin token.
    assert.equal((await fetch(`${base}/admin/sweeps`)).status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('admin sweep endpoints return 404 NOT_ENABLED in shared mode', async () => {
  const cfg: AppConfig = {
    port: 0, orderTtlMinutes: 15, enabledMethods: [], expiryReminderDays: 3, processedEventTtlDays: 7,
    shutdownTimeoutMs: 10000, adminToken: 'secret-admin',
    rateLimit: { enabled: false, max: 100, windowMs: 60_000 },
    security: { corsOrigins: ['*'], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
  };
  const container = buildContainer(cfg);
  const server = createHttpServer(container);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/admin/sweeps`, { headers: { Authorization: 'Bearer secret-admin' } });
    assert.equal(res.status, 404);
    assert.equal((await getJson(res)).error, 'NOT_ENABLED');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
