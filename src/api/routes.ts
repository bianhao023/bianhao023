import { Order, OrderStatus, PaymentMethod, ALL_METHODS } from '../domain/types';
import { ValidationError, NotFoundError, AppError } from '../domain/errors';
import { fromMinorUnits } from '../core/money';
import { safeEqual } from '../utils/crypto';
import { PaymentService } from '../services/paymentService';
import { RefundService } from '../services/refundService';
import { ReportService, ReportFilter } from '../services/reportService';
import { ExpiryService } from '../services/expiryService';
import { PlanCatalog } from '../services/plans';
import { UsdtWatcher } from '../services/usdtWatcher';
import { Metrics } from '../observability/metrics';
import { parseJsonBody, Router, RouterMetrics, RateLimitOptions, sendJson, sendRaw, ReqContext } from './http';

export interface ApiDeps {
  payments: PaymentService;
  refunds: RefundService;
  reports: ReportService;
  expiry: ExpiryService;
  plans: PlanCatalog;
  enabledMethods: PaymentMethod[];
  /** Bearer token guarding /admin. Undefined disables admin endpoints. */
  adminToken?: string;
  metrics?: Metrics;
  routerMetrics?: RouterMetrics;
  rateLimit?: RateLimitOptions;
  usdtWatcher?: UsdtWatcher;
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

/** Enforce the admin bearer token (constant-time). Disabled when no token set. */
function requireAdmin(ctx: ReqContext, adminToken?: string): void {
  if (!adminToken) throw new AuthError('admin endpoints are disabled (set ADMIN_TOKEN)', 403);
  const header = ctx.headers['authorization'] ?? '';
  const prefix = 'Bearer ';
  const token = header.startsWith(prefix) ? header.slice(prefix.length) : '';
  if (!safeEqual(token, adminToken)) throw new AuthError('invalid admin token');
}

/** Parse a non-negative integer query param with a default and cap. */
function intParam(q: URLSearchParams, name: string, def: number, max: number): number {
  const raw = q.get(name);
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`invalid ${name}`);
  return Math.min(n, max);
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
  const r = new Router({ metrics: deps.routerMetrics, rateLimit: deps.rateLimit });

  r.get('/healthz', (_ctx, res) => {
    sendJson(res, 200, { status: 'ok', methods: deps.enabledMethods });
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

  // ── Admin / reconciliation (bearer-token protected) ──────────────────────
  r.get('/admin/reports/summary', async (ctx, res) => {
    requireAdmin(ctx, deps.adminToken);
    sendJson(res, 200, await deps.reports.summary(reportFilter(ctx.query)));
  });

  r.get('/admin/orders', async (ctx, res) => {
    requireAdmin(ctx, deps.adminToken);
    const limit = intParam(ctx.query, 'limit', 50, 500);
    const offset = intParam(ctx.query, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const { total, items } = await deps.reports.listOrders(reportFilter(ctx.query), { limit, offset });
    sendJson(res, 200, { total, limit, offset, items: items.map(orderView) });
  });

  r.get('/admin/refunds', async (ctx, res) => {
    requireAdmin(ctx, deps.adminToken);
    const limit = intParam(ctx.query, 'limit', 50, 500);
    const offset = intParam(ctx.query, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const { total, items } = await deps.reports.listRefunds({ limit, offset });
    sendJson(res, 200, { total, limit, offset, items });
  });

  // Trigger an expiry pass (reminders + deactivation); usually driven by cron.
  r.post('/admin/expiry/run', async (ctx, res) => {
    requireAdmin(ctx, deps.adminToken);
    const reminders = await deps.expiry.sendExpiryReminders();
    const deactivated = await deps.expiry.deactivateExpired();
    sendJson(res, 200, { reminders, deactivated });
  });

  return r;
}
