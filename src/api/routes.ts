import { Order, PaymentMethod, ALL_METHODS } from '../domain/types';
import { ValidationError, NotFoundError } from '../domain/errors';
import { fromMinorUnits } from '../core/money';
import { PaymentService } from '../services/paymentService';
import { RefundService } from '../services/refundService';
import { PlanCatalog } from '../services/plans';
import { UsdtWatcher } from '../services/usdtWatcher';
import { parseJsonBody, Router, sendJson, sendRaw, ReqContext } from './http';

export interface ApiDeps {
  payments: PaymentService;
  refunds: RefundService;
  plans: PlanCatalog;
  enabledMethods: PaymentMethod[];
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

export function buildRouter(deps: ApiDeps): Router {
  const r = new Router();

  r.get('/healthz', (_ctx, res) => {
    sendJson(res, 200, { status: 'ok', methods: deps.enabledMethods });
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

  return r;
}
