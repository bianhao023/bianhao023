import { Currency, Order, OrderStatus, PaymentMethod } from '../domain/types';
import { Refund, RefundStatus } from '../domain/refund';
import { OrderRepository, RefundRepository } from '../storage/repository';
import { fromMinorUnits } from '../core/money';

export interface ReportFilter {
  /** Inclusive lower bound on order.createdAt (epoch millis). */
  from?: number;
  /** Exclusive upper bound on order.createdAt (epoch millis). */
  to?: number;
  method?: PaymentMethod;
  status?: OrderStatus;
  /** Scope to a single tenant (multi-merchant isolation). */
  merchantId?: string;
}

export interface Page {
  limit: number;
  offset: number;
}

interface CurrencyTotals {
  currency: Currency;
  paidCount: number;
  grossMinor: number;
  grossDisplay: string;
  refundedMinor: number;
  refundedDisplay: string;
  netMinor: number;
  netDisplay: string;
}

/** A refund counts toward settled money once SUCCESS or MANUAL. */
function refundSettled(r: Refund): boolean {
  return r.status === RefundStatus.SUCCESS || r.status === RefundStatus.MANUAL;
}

/** An order counts as revenue once it has been paid. */
function isPaid(o: Order): boolean {
  return o.paidAt !== undefined &&
    (o.status === OrderStatus.PAID ||
      o.status === OrderStatus.FULFILLED ||
      o.status === OrderStatus.REFUNDED);
}

/**
 * Produces reconciliation summaries and paginated order/refund listings from
 * the repositories. Aggregation is per-currency (CNY and USDT are never summed
 * together). For very large datasets push these aggregates into SQL.
 */
export class ReportService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
  ) {}

  private matches(o: Order, f: ReportFilter): boolean {
    if (f.from !== undefined && o.createdAt < f.from) return false;
    if (f.to !== undefined && o.createdAt >= f.to) return false;
    if (f.method && o.method !== f.method) return false;
    if (f.status && o.status !== f.status) return false;
    return true;
  }

  async summary(filter: ReportFilter = {}): Promise<Record<string, unknown>> {
    const orders = (await this.orders.all()).filter((o) => this.matches(o, filter));
    const orderIds = new Set(orders.map((o) => o.id));
    const refunds = (await this.refunds.all()).filter((r) => orderIds.has(r.orderId));

    const byStatus: Record<string, number> = {};
    const perCurrency = new Map<Currency, CurrencyTotals>();
    const byMethod: Record<string, { method: PaymentMethod; currency: Currency; paidCount: number; grossMinor: number; grossDisplay: string }> = {};

    const cur = (c: Currency): CurrencyTotals => {
      let t = perCurrency.get(c);
      if (!t) {
        t = { currency: c, paidCount: 0, grossMinor: 0, grossDisplay: '0', refundedMinor: 0, refundedDisplay: '0', netMinor: 0, netDisplay: '0' };
        perCurrency.set(c, t);
      }
      return t;
    };

    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      if (isPaid(o)) {
        const t = cur(o.currency);
        t.paidCount++;
        t.grossMinor += o.amount;
        const m = (byMethod[o.method] ??= { method: o.method, currency: o.currency, paidCount: 0, grossMinor: 0, grossDisplay: '0' });
        m.paidCount++;
        m.grossMinor += o.amount;
      }
    }
    for (const r of refunds) {
      if (refundSettled(r)) cur(r.currency).refundedMinor += r.amount;
    }

    const currencies = [...perCurrency.values()].map((t) => {
      t.netMinor = t.grossMinor - t.refundedMinor;
      t.grossDisplay = fromMinorUnits(t.grossMinor, t.currency);
      t.refundedDisplay = fromMinorUnits(t.refundedMinor, t.currency);
      t.netDisplay = fromMinorUnits(Math.max(0, t.netMinor), t.currency);
      return t;
    });
    const methods = Object.values(byMethod).map((m) => ({
      ...m,
      grossDisplay: fromMinorUnits(m.grossMinor, m.currency),
    }));

    return {
      ordersTotal: orders.length,
      byStatus,
      currencies,
      byMethod: methods,
      refundsTotal: refunds.length,
    };
  }

  async listOrders(filter: ReportFilter, page: Page): Promise<{ total: number; items: Order[] }> {
    // Push filtering + pagination into the store (SQL WHERE + LIMIT/OFFSET).
    return this.orders.query(
      { status: filter.status, method: filter.method, from: filter.from, to: filter.to, merchantId: filter.merchantId },
      page.limit,
      page.offset,
    );
  }

  async listRefunds(page: Page, filter: { status?: RefundStatus; from?: number; to?: number } = {}): Promise<{ total: number; items: Refund[] }> {
    // Push filtering + pagination into the store.
    return this.refunds.query(filter, page.limit, page.offset);
  }

  /**
   * Order-side aggregation pushed down to the store (SQL GROUP BY). Unlike
   * `summary`, this does NOT attribute refunds — it is the scalable big-table
   * roll-up (counts + paid gross by status/method/currency).
   */
  async orderSummary(filter: ReportFilter = {}): Promise<Record<string, unknown>> {
    const s = await this.orders.summarize(filter);
    const byCurrency = new Map<string, { currency: string; paidCount: number; grossMinor: number }>();
    for (const row of s.paid) {
      const c = byCurrency.get(row.currency) ?? { currency: row.currency, paidCount: 0, grossMinor: 0 };
      c.paidCount += row.paidCount;
      c.grossMinor += row.grossMinor;
      byCurrency.set(row.currency, c);
    }
    return {
      ordersTotal: s.ordersTotal,
      byStatus: s.byStatus,
      currencies: [...byCurrency.values()].map((c) => ({
        ...c,
        grossDisplay: fromMinorUnits(c.grossMinor, c.currency as Currency),
      })),
      byMethod: s.paid.map((r) => ({
        ...r,
        grossDisplay: fromMinorUnits(r.grossMinor, r.currency as Currency),
      })),
    };
  }
}
