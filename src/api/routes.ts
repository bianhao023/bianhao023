import { Order, OrderStatus, PaymentMethod, ALL_METHODS } from '../domain/types';
import { RefundStatus } from '../domain/refund';
import { ValidationError, NotFoundError, AppError } from '../domain/errors';
import { fromMinorUnits } from '../core/money';
import { safeEqual } from '../utils/crypto';
import { PaymentService } from '../services/paymentService';
import { RefundService } from '../services/refundService';
import { ReportService, ReportFilter } from '../services/reportService';
import { ExpiryService } from '../services/expiryService';
import { UserService } from '../services/userService';
import { ReconciliationService } from '../services/reconciliationService';
import { AuditLog } from '../audit/auditLog';
import { WebhookDispatcher, DeliveryStatus } from '../webhooks/outbound';
import { PricingService } from '../pricing/pricingService';
import { ReadinessAggregator } from '../health/readiness';
import { ProcessedEventStore, SweepJobRepository } from '../storage/repository';
import { SweepService } from '../services/sweepService';
import { ordersToCsv, refundsToCsv } from '../reporting/csv';
import { formatReconciliationAlert, Alert } from '../alerting/alertFormatter';
import { APP_VERSION, API_VERSION, SUPPORTED_API_VERSIONS } from '../version';
import { buildOpenApiSpec } from './openapi';
import { SWAGGER_UI_HTML } from './docsHtml';
import { toPublicUser } from '../domain/user';
import { PlanCatalog } from '../services/plans';
import { UsdtWatcher } from '../services/usdtWatcher';
import { Metrics } from '../observability/metrics';
import { parseJsonBody, Router, RouterMetrics, RateLimitOptions, SecurityOptions, sendJson, sendRaw, ReqContext } from './http';

export interface ApiDeps {
  payments: PaymentService;
  refunds: RefundService;
  reports: ReportService;
  expiry: ExpiryService;
  users: UserService;
  reconciliation: ReconciliationService;
  audit: AuditLog;
  pricing: PricingService;
  readiness: ReadinessAggregator;
  alertSink: (alert: Alert) => Promise<void>;
  processedEvents: ProcessedEventStore;
  processedEventTtlMs: number;
  plans: PlanCatalog;
  enabledMethods: PaymentMethod[];
  /** Bearer token guarding /admin. Undefined disables admin endpoints. */
  adminToken?: string;
  /** Previous admin token accepted during rotation (grace window). */
  adminTokenPrevious?: string;
  metrics?: Metrics;
  routerMetrics?: RouterMetrics;
  rateLimit?: RateLimitOptions;
  security?: SecurityOptions;
  usdtWatcher?: UsdtWatcher;
  webhooks?: WebhookDispatcher;
  /** Sweep-job store (per-order USDT mode); enables /admin/sweeps. */
  sweepJobs?: SweepJobRepository;
  /** Sweep service (per-order USDT mode); enables sweep retry. */
  sweepService?: SweepService;
}

/** Public, sanitised projection of an order returned to clients. */
function orderView(o: Order): Record<string, unknown> {
  return {
    orderId: o.id,
    outTradeNo: o.outTradeNo,
    planId: o.planId,
    method: o.method,
    status: o.status,
    currency: o.currency,
    amount: o.amount,
    amountDisplay: fromMinorUnits(o.amount, o.currency),
    refundedAmount: o.refundedAmount ?? 0,
    providerTxnId: o.providerTxnId,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    paidAt: o.paidAt,
    payInfo: o.metadata['payInfo'] ? JSON.parse(o.metadata['payInfo']) : undefined,
  };
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError(`missing or invalid field: ${key}`);
  }
  return v.trim();
}

class AuthError extends AppError {
  constructor(message: string, status = 401) {
    super('UNAUTHORIZED', message, status);
  }
}

/** Extract a Bearer token from the Authorization header (empty string if none). */
function bearerToken(ctx: ReqContext): string {
  const header = ctx.headers['authorization'] ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

/**
 * Enforce the admin bearer token (constant-time). Accepts the current token or,
 * during rotation, the previous one. Disabled when no token is set.
 */
function requireAdmin(ctx: ReqContext, adminToken?: string, adminTokenPrevious?: string): void {
  if (!adminToken) throw new AuthError('admin endpoints are disabled (set ADMIN_TOKEN)', 403);
  const header = ctx.headers['authorization'] ?? '';
  const prefix = 'Bearer ';
  const token = header.startsWith(prefix) ? header.slice(prefix.length) : '';
  const valid = safeEqual(token, adminToken) || (!!adminTokenPrevious && safeEqual(token, adminTokenPrevious));
  if (!valid) throw new AuthError('invalid admin token');
}

/** Authenticate an admin request and record the access in the audit log. */
async function adminGuard(ctx: ReqContext, deps: ApiDeps): Promise<void> {
  requireAdmin(ctx, deps.adminToken, deps.adminTokenPrevious);
  await deps.audit.record({ action: 'admin.access', subjectId: ctx.path, metadata: { method: ctx.method } });
}

/** Parse a non-negative integer query param with a default and cap. */
function intParam(q: URLSearchParams, name: string, def: number, max: number): number {
  const raw = q.get(name);
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`invalid ${name}`);
  return Math.min(n, max);
}

/** Build a refund filter from query params (validating the status enum). */
function refundFilter(q: URLSearchParams): { status?: RefundStatus; from?: number; to?: number } {
  const f: { status?: RefundStatus; from?: number; to?: number } = {};
  const status = q.get('status');
  if (status) {
    if (!Object.values(RefundStatus).includes(status as RefundStatus)) throw new ValidationError(`invalid status: ${status}`);
    f.status = status as RefundStatus;
  }
  if (q.get('from')) f.from = intParam(q, 'from', 0, Number.MAX_SAFE_INTEGER);
  if (q.get('to')) f.to = intParam(q, 'to', 0, Number.MAX_SAFE_INTEGER);
  return f;
}

/** Build a report filter from query params (validating enums). */
function reportFilter(q: URLSearchParams): ReportFilter {
  const f: ReportFilter = {};
  if (q.get('from')) f.from = intParam(q, 'from', 0, Number.MAX_SAFE_INTEGER);
  if (q.get('to')) f.to = intParam(q, 'to', 0, Number.MAX_SAFE_INTEGER);
  const method = q.get('method');
  if (method) {
    if (!ALL_METHODS.includes(method as PaymentMethod)) throw new ValidationError(`invalid method: ${method}`);
    f.method = method as PaymentMethod;
  }
  const status = q.get('status');
  if (status) {
    if (!Object.values(OrderStatus).includes(status as OrderStatus)) throw new ValidationError(`invalid status: ${status}`);
    f.status = status as OrderStatus;
  }
  return f;
}

export function buildRouter(deps: ApiDeps): Router {
  const r = new Router({ metrics: deps.routerMetrics, rateLimit: deps.rateLimit, security: deps.security });

  r.get('/healthz', (_ctx, res) => {
    sendJson(res, 200, { status: 'ok', methods: deps.enabledMethods });
  });

  r.get('/version', (_ctx, res) => {
    sendJson(res, 200, { app: APP_VERSION, api: API_VERSION, supported: SUPPORTED_API_VERSIONS });
  });

  // Deep readiness probe: 200 when ready, 503 when degraded (report in body).
  r.get('/readyz', async (_ctx, res) => {
    const report = await deps.readiness.run();
    sendJson(res, report.status === 'ok' ? 200 : 503, report);
  });

  // Prometheus scrape endpoint (kept open for scrapers; restrict via network policy).
  r.get('/metrics', async (_ctx, res) => {
    const body = deps.metrics ? await deps.metrics.render() : '';
    sendRaw(res, 200, 'text/plain; version=0.0.4; charset=utf-8', body);
  });

  r.get('/api/plans', (_ctx, res) => {
    const plans = deps.plans.listPlans().map((p) => ({
      ...p,
      priceCnyDisplay: fromMinorUnits(p.priceCnyFen, 'CNY'),
      priceUsdtDisplay: fromMinorUnits(p.priceUsdtMicro, 'USDT'),
    }));
    sendJson(res, 200, { plans, enabledMethods: deps.enabledMethods });
  });

  // Convert an integer minor-unit amount between currencies at the current rate.
  r.get('/api/pricing/quote', (ctx, res) => {
    const amount = Number(ctx.query.get('amount'));
    const from = ctx.query.get('from') ?? '';
    const to = ctx.query.get('to') ?? '';
    if (!Number.isInteger(amount) || amount < 0) throw new ValidationError('amount must be a non-negative integer (minor units)');
    if (!from || !to) throw new ValidationError('from and to currencies are required');
    try {
      sendJson(res, 200, deps.pricing.quote(amount, from, to));
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
  });

  // ── Users / accounts ─────────────────────────────────────────────────────
  r.post('/api/users/register', async (ctx, res) => {
    const body = parseJsonBody(ctx);
    const result = await deps.users.register({
      email: requireString(body, 'email'),
      password: requireString(body, 'password'),
      locale: typeof body['locale'] === 'string' ? (body['locale'] as string) : undefined,
      name: typeof body['name'] === 'string' ? (body['name'] as string) : undefined,
    });
    sendJson(res, 201, result);
  });

  r.post('/api/users/login', async (ctx, res) => {
    const body = parseJsonBody(ctx);
    const result = await deps.users.login(requireString(body, 'email'), requireString(body, 'password'));
    sendJson(res, 200, result);
  });

  r.get('/api/users/me', async (ctx, res) => {
    const user = await deps.users.authenticate(bearerToken(ctx));
    sendJson(res, 200, toPublicUser(user));
  });

  r.post('/api/users/me/rotate-key', async (ctx, res) => {
    const user = await deps.users.authenticate(bearerToken(ctx));
    const apiKey = await deps.users.rotateApiKey(user.id);
    sendJson(res, 200, { apiKey });
  });

  r.post('/api/orders', async (ctx, res) => {
    const body = parseJsonBody(ctx);
    const userId = requireString(body, 'userId');
    const planId = requireString(body, 'planId');
    const method = requireString(body, 'method') as PaymentMethod;

    if (!ALL_METHODS.includes(method)) {
      throw new ValidationError(`unsupported method: ${method}`);
    }
    if (!deps.enabledMethods.includes(method)) {
      throw new ValidationError(`payment method not enabled: ${method}`);
    }

    const idempotencyKey =
      ctx.headers['idempotency-key'] ||
      (typeof body['idempotencyKey'] === 'string' ? (body['idempotencyKey'] as string) : undefined);

    const { order, payInfo } = await deps.payments.createOrder({
      userId,
      planId,
      method,
      idempotencyKey,
    });
    sendJson(res, 201, { ...orderView(order), payInfo });
  });

  r.get('/api/orders/:id', async (ctx, res) => {
    const order = await deps.payments.getOrder(ctx.params['id']);
    if (!order) throw new NotFoundError(`order not found: ${ctx.params['id']}`);
    sendJson(res, 200, orderView(order));
  });

  // Manual/polling settlement (used by clients waiting on USDT confirmation).
  r.post('/api/orders/:id/sync', async (ctx, res) => {
    const order = await deps.payments.syncOrder(ctx.params['id']);
    sendJson(res, 200, orderView(order));
  });

  // Refund (full or partial). Body: { amount?, reason?, outRefundNo? }.
  r.post('/api/orders/:id/refund', async (ctx, res) => {
    const body = parseJsonBody(ctx);
    const amount = body['amount'];
    if (amount !== undefined && (typeof amount !== 'number' || !Number.isInteger(amount))) {
      throw new ValidationError('amount must be an integer in minor units');
    }
    const refund = await deps.refunds.refundOrder(ctx.params['id'], {
      amount: amount as number | undefined,
      reason: typeof body['reason'] === 'string' ? (body['reason'] as string) : undefined,
      outRefundNo: typeof body['outRefundNo'] === 'string' ? (body['outRefundNo'] as string) : undefined,
    });
    sendJson(res, 201, refund);
  });

  // List refunds for an order.
  r.get('/api/orders/:id/refunds', async (ctx, res) => {
    const refunds = await deps.refunds.listOrderRefunds(ctx.params['id']);
    sendJson(res, 200, { refunds });
  });

  // Provider webhooks. Raw body is preserved for signature verification.
  const notify = (method: PaymentMethod) => async (ctx: ReqContext, res: import('node:http').ServerResponse) => {
    const ack = await deps.payments.handleCallback(method, {
      rawBody: ctx.rawBody,
      headers: ctx.headers,
    });
    sendRaw(res, ack.status, ack.contentType, ack.body);
  };
  r.post('/api/notify/wechat', notify('wechat'));
  r.post('/api/notify/alipay', notify('alipay'));

  // Async refund-result webhook (WeChat refunds can settle after PROCESSING).
  r.post('/api/notify/wechat/refund', async (ctx, res) => {
    const ack = await deps.refunds.handleRefundCallback('wechat', {
      rawBody: ctx.rawBody,
      headers: ctx.headers,
    });
    sendRaw(res, ack.status, ack.contentType, ack.body);
  });

  // Internal endpoint to trigger a USDT reconciliation pass (e.g. from cron).
  r.post('/internal/usdt/reconcile', async (_ctx, res) => {
    const settled = deps.usdtWatcher ? await deps.usdtWatcher.reconcileOnce() : 0;
    sendJson(res, 200, { settled });
  });

  // Sweep expired processed-event dedupe records (e.g. from cron).
  r.post('/internal/maintenance/sweep', async (_ctx, res) => {
    const removed = await deps.processedEvents.sweep(deps.processedEventTtlMs);
    sendJson(res, 200, { removed });
  });

  // Drain due outbound webhook deliveries (e.g. from cron).
  r.post('/internal/webhooks/process', async (_ctx, res) => {
    const result = deps.webhooks
      ? await deps.webhooks.processDue()
      : { delivered: 0, retried: 0, dead: 0 };
    sendJson(res, 200, result);
  });

  // ── API documentation ────────────────────────────────────────────────────
  r.get('/openapi.json', (_ctx, res) => sendJson(res, 200, buildOpenApiSpec(deps.enabledMethods)));
  r.get('/docs', (_ctx, res) => sendRaw(res, 200, 'text/html; charset=utf-8', SWAGGER_UI_HTML));

  // ── Admin / reconciliation (bearer-token protected) ──────────────────────
  r.get('/admin/reports/summary', async (ctx, res) => {
    await adminGuard(ctx, deps);
    sendJson(res, 200, await deps.reports.summary(reportFilter(ctx.query)));
  });

  // Scalable order-side aggregation (SQL GROUP BY pushdown; no refund attribution).
  r.get('/admin/reports/orders-summary', async (ctx, res) => {
    await adminGuard(ctx, deps);
    sendJson(res, 200, await deps.reports.orderSummary(reportFilter(ctx.query)));
  });

  r.get('/admin/orders', async (ctx, res) => {
    await adminGuard(ctx, deps);
    const limit = intParam(ctx.query, 'limit', 50, 500);
    const offset = intParam(ctx.query, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const { total, items } = await deps.reports.listOrders(reportFilter(ctx.query), { limit, offset });
    sendJson(res, 200, { total, limit, offset, items: items.map(orderView) });
  });

  r.get('/admin/refunds', async (ctx, res) => {
    await adminGuard(ctx, deps);
    const limit = intParam(ctx.query, 'limit', 50, 500);
    const offset = intParam(ctx.query, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const { total, items } = await deps.reports.listRefunds({ limit, offset }, refundFilter(ctx.query));
    sendJson(res, 200, { total, limit, offset, items });
  });

  // USDT sweep ("二次归集") jobs: list, and manually requeue a FAILED one.
  r.get('/admin/sweeps', async (ctx, res) => {
    await adminGuard(ctx, deps);
    if (!deps.sweepJobs) {
      sendJson(res, 404, { error: 'NOT_ENABLED', message: 'USDT per-order sweeping is not enabled' });
      return;
    }
    const statusFilter = ctx.query.get('status') ?? undefined;
    let items = await deps.sweepJobs.all();
    if (statusFilter) items = items.filter((j) => j.status === statusFilter);
    const limit = intParam(ctx.query, 'limit', 100, 1000);
    const offset = intParam(ctx.query, 'offset', 0, Number.MAX_SAFE_INTEGER);
    sendJson(res, 200, { total: items.length, limit, offset, items: items.slice(offset, offset + limit) });
  });

  r.post('/admin/sweeps/:orderId/retry', async (ctx, res) => {
    await adminGuard(ctx, deps);
    if (!deps.sweepService) {
      sendJson(res, 404, { error: 'NOT_ENABLED', message: 'USDT per-order sweeping is not enabled' });
      return;
    }
    const job = await deps.sweepService.retry(ctx.params.orderId);
    if (!job) {
      sendJson(res, 404, { error: 'NOT_FOUND', message: 'no FAILED sweep job for that order' });
      return;
    }
    sendJson(res, 200, { requeued: true, job });
  });

  // CSV exports for reconciliation / bookkeeping.
  r.get('/admin/orders.csv', async (ctx, res) => {
    await adminGuard(ctx, deps);
    const { items } = await deps.reports.listOrders(reportFilter(ctx.query), { limit: 100_000, offset: 0 });
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    sendRaw(res, 200, 'text/csv; charset=utf-8', ordersToCsv(items));
  });

  r.get('/admin/refunds.csv', async (ctx, res) => {
    await adminGuard(ctx, deps);
    const { items } = await deps.reports.listRefunds({ limit: 100_000, offset: 0 });
    res.setHeader('Content-Disposition', 'attachment; filename="refunds.csv"');
    sendRaw(res, 200, 'text/csv; charset=utf-8', refundsToCsv(items));
  });

  // Trigger an expiry pass (reminders + deactivation); usually driven by cron.
  r.post('/admin/expiry/run', async (ctx, res) => {
    await adminGuard(ctx, deps);
    const reminders = await deps.expiry.sendExpiryReminders();
    const deactivated = await deps.expiry.deactivateExpired();
    sendJson(res, 200, { reminders, deactivated });
  });

  // Run a financial-consistency reconciliation pass (optionally healing).
  r.post('/admin/reconciliation', async (ctx, res) => {
    await adminGuard(ctx, deps);
    const report = await deps.reconciliation.run({ heal: ctx.query.get('heal') === 'true' });
    // Fire an alert (log + webhook) when discrepancies are found.
    const alert = formatReconciliationAlert(report);
    if (alert) await deps.alertSink(alert);
    sendJson(res, 200, { ...report, alert: alert ?? null });
  });

  // List outbound webhook deliveries (optionally by status), for DLQ inspection.
  r.get('/admin/webhooks', async (ctx, res) => {
    await adminGuard(ctx, deps);
    if (!deps.webhooks) {
      sendJson(res, 200, { total: 0, limit: 0, offset: 0, items: [] });
      return;
    }
    const status = ctx.query.get('status') as DeliveryStatus | null;
    if (status && !['pending', 'delivered', 'dead'].includes(status)) {
      throw new ValidationError(`invalid status: ${status}`);
    }
    const limit = intParam(ctx.query, 'limit', 50, 500);
    const offset = intParam(ctx.query, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const { total, items } = await deps.webhooks.list(status ?? undefined, limit, offset);
    sendJson(res, 200, { total, limit, offset, items });
  });

  // Requeue a (dead-lettered) webhook delivery for immediate retry.
  r.post('/admin/webhooks/:id/retry', async (ctx, res) => {
    await adminGuard(ctx, deps);
    if (!deps.webhooks) throw new NotFoundError('webhooks are not configured');
    try {
      const delivery = await deps.webhooks.retry(ctx.params['id']);
      sendJson(res, 200, delivery);
    } catch {
      throw new NotFoundError(`delivery not found: ${ctx.params['id']}`);
    }
  });

  // Expose every public /api/* route also under the explicit /api/v1/* prefix.
  // (Both are canonical for the current major version; no deprecation yet.)
  r.aliasPrefix('/api', '/api/v1');

  // Query the audit log.
  r.get('/admin/audit', async (ctx, res) => {
    await adminGuard(ctx, deps);
    const q = ctx.query;
    const result = await deps.audit.query({
      action: q.get('action') ?? undefined,
      actor: q.get('actor') ?? undefined,
      subjectId: q.get('subjectId') ?? undefined,
      from: q.get('from') ? intParam(q, 'from', 0, Number.MAX_SAFE_INTEGER) : undefined,
      to: q.get('to') ? intParam(q, 'to', 0, Number.MAX_SAFE_INTEGER) : undefined,
      limit: intParam(q, 'limit', 50, 500),
      offset: intParam(q, 'offset', 0, Number.MAX_SAFE_INTEGER),
    });
    sendJson(res, 200, result);
  });

  return r;
}
