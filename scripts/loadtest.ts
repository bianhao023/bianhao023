/**
 * Self-contained in-process load / performance test for the payment backend.
 *
 * This starts the real HTTP server in-process on an ephemeral port with an
 * in-memory container (no external credentials, DB, or network dependencies).
 * The 'wechat' method is enabled via a tiny stub PaymentProvider, so the full
 * order + callback flow can be exercised without a real payment provider.
 *
 * Env vars:
 *   LOAD_CONCURRENCY   Number of requests kept in flight at once. Default 20.
 *   LOAD_TOTAL         Total number of requests to send. Default 2000.
 *                      Ignored when LOAD_DURATION_SEC is set.
 *   LOAD_DURATION_SEC  If set, run for this many seconds instead of a fixed
 *                      request count (LOAD_TOTAL is then ignored).
 *   LOAD_SCENARIO      Traffic mix. Default 'mixed'. Currently only 'mixed'
 *                      is defined; any other value falls back to 'mixed'.
 *
 * Example:
 *   npm run build && LOAD_CONCURRENCY=50 LOAD_TOTAL=5000 node dist/scripts/loadtest.js
 *
 *   # time-boxed run:
 *   LOAD_CONCURRENCY=50 LOAD_DURATION_SEC=15 node dist/scripts/loadtest.js
 */
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';

import { buildContainer } from '../src/container';
import { AppConfig } from '../src/config';
import { createHttpServer } from '../src/api/server';
import { PaymentProvider, RawCallback } from '../src/providers/provider';
import {
  CallbackResult,
  CreatePaymentResult,
  Order,
  PaymentMethod,
  QueryResult,
} from '../src/domain/types';

/**
 * Minimal in-process payment provider so the 'wechat' method is enabled without
 * any real credentials. verifyCallback simply echoes the JSON callback body,
 * which lets the load driver mark orders paid deterministically.
 */
class StubProvider implements PaymentProvider {
  readonly method: PaymentMethod = 'wechat';

  async createPayment(order: Order): Promise<CreatePaymentResult> {
    return { method: 'wechat', payTarget: 'stub://' + order.outTradeNo, renderAs: 'qrcode', extra: {} };
  }

  async verifyCallback(cb: RawCallback): Promise<CallbackResult> {
    return JSON.parse(cb.rawBody) as CallbackResult;
  }

  async queryPayment(_order: Order): Promise<QueryResult> {
    return { paid: false, rawStatus: 'PENDING' };
  }

  callbackAck(success: boolean): { status: number; contentType: string; body: string } {
    return { status: success ? 200 : 500, contentType: 'text/plain', body: success ? 'ok' : 'fail' };
  }
}

// ── Configuration helpers ────────────────────────────────────────────────────

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** All required AppConfig fields; rate limiting off; methods enabled via stub. */
function buildLoadConfig(): AppConfig {
  return {
    port: 0,
    orderTtlMinutes: 15,
    enabledMethods: [], // provider map (below) enables 'wechat'
    expiryReminderDays: 3,
    processedEventTtlDays: 7,
    rateLimit: { enabled: false, max: 100000, windowMs: 60_000 }, security: { corsOrigins: [], requestTimeoutMs: 15000, maxBodyBytes: 1000000, securityHeaders: true },
  };
}

// ── Latency stats ────────────────────────────────────────────────────────────

interface Stats {
  total: number;
  success: number;
  errors: number;
  latenciesMs: number[];
  statusCounts: Map<string, number>;
}

function newStats(): Stats {
  return { total: 0, success: 0, errors: 0, latenciesMs: [], statusCounts: new Map() };
}

function record(stats: Stats, status: number | 'ERR', latencyMs: number): void {
  stats.total += 1;
  stats.latenciesMs.push(latencyMs);
  const key = String(status);
  stats.statusCounts.set(key, (stats.statusCounts.get(key) ?? 0) + 1);
  if (status !== 'ERR' && status >= 200 && status < 300) stats.success += 1;
  else stats.errors += 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ── Request scenarios ────────────────────────────────────────────────────────

let seq = 0;

/** Fire a single logical request per the scenario weighting; record its result. */
async function runRequest(baseUrl: string, scenario: string, stats: Stats): Promise<void> {
  // Weighted pick: ~50% read plans, ~20% register, ~30% full order flow.
  const roll = Math.random();
  const kind = scenario === 'mixed' ? (roll < 0.5 ? 'plans' : roll < 0.7 ? 'register' : 'order') : 'plans';

  const start = process.hrtime.bigint();
  try {
    let status: number;
    if (kind === 'plans') {
      status = await getPlans(baseUrl);
    } else if (kind === 'register') {
      status = await register(baseUrl);
    } else {
      status = await orderFlow(baseUrl);
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    record(stats, status, ms);
  } catch {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    record(stats, 'ERR', ms);
  }
}

async function getPlans(baseUrl: string): Promise<number> {
  const res = await fetch(baseUrl + '/api/plans');
  await res.arrayBuffer(); // drain
  return res.status;
}

function uniqueEmail(): string {
  seq += 1;
  return `load_${Date.now().toString(36)}_${seq}_${Math.floor(Math.random() * 1e6)}@loadtest.local`;
}

async function register(baseUrl: string): Promise<number> {
  const res = await fetch(baseUrl + '/api/users/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: uniqueEmail(), password: 'loadtest-password', name: 'Load Test' }),
  });
  await res.arrayBuffer();
  return res.status;
}

/**
 * Full order flow: register a user, create a wechat order, then post a wechat
 * callback (JSON that the StubProvider echoes as a CallbackResult) marking it
 * paid. Returns the status of the final (callback) request; short-circuits and
 * returns the failing status if an earlier step is not 2xx.
 */
async function orderFlow(baseUrl: string): Promise<number> {
  // 1. Register a user to own the order.
  const regRes = await fetch(baseUrl + '/api/users/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: uniqueEmail(), password: 'loadtest-password' }),
  });
  const regBody = (await regRes.json().catch(() => null)) as { user?: { id?: string } } | null;
  const userId = regBody?.user?.id;
  if (!regRes.ok || !userId) return regRes.status;

  // 2. Create a wechat order.
  const orderRes = await fetch(baseUrl + '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, planId: 'monthly', method: 'wechat' }),
  });
  const orderBody = (await orderRes.json().catch(() => null)) as
    | { outTradeNo?: string; amount?: number }
    | null;
  const outTradeNo = orderBody?.outTradeNo;
  if (!orderRes.ok || !outTradeNo) return orderRes.status;

  // 3. Deliver a paid callback. The StubProvider parses this JSON verbatim as a
  // CallbackResult; paidAmount matches the order amount so applyPayment settles.
  const callback: CallbackResult = {
    outTradeNo,
    providerTxnId: 'stub-txn-' + outTradeNo,
    paid: true,
    paidAmount: typeof orderBody?.amount === 'number' ? orderBody.amount : 1500,
    currency: 'CNY',
    eventId: 'evt-' + outTradeNo,
    rawStatus: 'SUCCESS',
  };
  const cbRes = await fetch(baseUrl + '/api/notify/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(callback),
  });
  await cbRes.arrayBuffer();
  return cbRes.status;
}

// ── Worker pool driver ───────────────────────────────────────────────────────

interface DriveOptions {
  baseUrl: string;
  scenario: string;
  concurrency: number;
  total?: number;
  durationMs?: number;
}

/**
 * Keep exactly `concurrency` requests in flight. Stops when `total` requests
 * have been issued, or (if durationMs is set) when the deadline passes.
 */
async function drive(opts: DriveOptions, stats: Stats): Promise<void> {
  const { baseUrl, scenario, concurrency } = opts;
  const deadline = opts.durationMs !== undefined ? Date.now() + opts.durationMs : undefined;
  let issued = 0;

  const shouldContinue = (): boolean => {
    if (deadline !== undefined) return Date.now() < deadline;
    return issued < (opts.total ?? 0);
  };

  async function worker(): Promise<void> {
    while (shouldContinue()) {
      issued += 1;
      await runRequest(baseUrl, scenario, stats);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) workers.push(worker());
  await Promise.all(workers);
}

// ── Reporting ────────────────────────────────────────────────────────────────

function printSummary(stats: Stats, durationSec: number, cfg: {
  concurrency: number;
  scenario: string;
  mode: string;
}): void {
  const sorted = [...stats.latenciesMs].sort((a, b) => a - b);
  const throughput = durationSec > 0 ? stats.total / durationSec : 0;
  const fmt = (n: number): string => n.toFixed(2);

  const rows: [string, string][] = [
    ['Scenario', cfg.scenario],
    ['Mode', cfg.mode],
    ['Concurrency', String(cfg.concurrency)],
    ['Total requests', String(stats.total)],
    ['Duration (s)', fmt(durationSec)],
    ['Throughput (req/s)', fmt(throughput)],
    ['Success (2xx)', String(stats.success)],
    ['Errors', String(stats.errors)],
    ['Latency p50 (ms)', fmt(percentile(sorted, 50))],
    ['Latency p90 (ms)', fmt(percentile(sorted, 90))],
    ['Latency p99 (ms)', fmt(percentile(sorted, 99))],
    ['Latency max (ms)', fmt(sorted.length ? sorted[sorted.length - 1] : 0)],
  ];

  const labelW = Math.max(...rows.map((r) => r[0].length));
  const valueW = Math.max(...rows.map((r) => r[1].length));
  const line = '+' + '-'.repeat(labelW + 2) + '+' + '-'.repeat(valueW + 2) + '+';

  console.log('\n=== Load test summary ===');
  console.log(line);
  for (const [label, value] of rows) {
    console.log('| ' + label.padEnd(labelW) + ' | ' + value.padEnd(valueW) + ' |');
  }
  console.log(line);

  // Status-code breakdown.
  const statuses = [...stats.statusCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const codeW = Math.max(6, ...statuses.map((s) => s[0].length));
  const cntW = Math.max(5, ...statuses.map((s) => String(s[1]).length));
  const sLine = '+' + '-'.repeat(codeW + 2) + '+' + '-'.repeat(cntW + 2) + '+';
  console.log('\nStatus-code breakdown:');
  console.log(sLine);
  console.log('| ' + 'Status'.padEnd(codeW) + ' | ' + 'Count'.padEnd(cntW) + ' |');
  console.log(sLine);
  for (const [code, count] of statuses) {
    console.log('| ' + code.padEnd(codeW) + ' | ' + String(count).padEnd(cntW) + ' |');
  }
  console.log(sLine);
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const concurrency = intEnv('LOAD_CONCURRENCY', 20);
  const scenario = (process.env.LOAD_SCENARIO ?? 'mixed').trim() || 'mixed';
  const durationSec = process.env.LOAD_DURATION_SEC ? intEnv('LOAD_DURATION_SEC', 0) : 0;
  const total = intEnv('LOAD_TOTAL', 2000);

  const config = buildLoadConfig();
  const providers = new Map<PaymentMethod, PaymentProvider>([['wechat', new StubProvider()]]);
  const container = buildContainer(config, { providers });
  const server: Server = createHttpServer(container);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const mode = durationSec > 0 ? `duration=${durationSec}s` : `total=${total}`;
  console.log(
    `Load test: scenario=${scenario} concurrency=${concurrency} ${mode} target=${baseUrl}`,
  );

  const stats = newStats();
  const startedAt = process.hrtime.bigint();
  await drive(
    {
      baseUrl,
      scenario,
      concurrency,
      total: durationSec > 0 ? undefined : total,
      durationMs: durationSec > 0 ? durationSec * 1000 : undefined,
    },
    stats,
  );
  const elapsedSec = Number(process.hrtime.bigint() - startedAt) / 1e9;

  printSummary(stats, elapsedSec, { concurrency, scenario, mode });

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('loadtest failed:', err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
