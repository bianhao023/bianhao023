import { Order, OrderStatus } from '../domain/types';
import { RefundStatus } from '../domain/refund';
import { OrderRepository, RefundRepository } from '../storage/repository';
import { logger } from '../utils/logger';

/** A single detected inconsistency. */
export interface Discrepancy {
  type:
    | 'paid_unfulfilled'
    | 'fulfilled_without_payment'
    | 'stale_pending'
    | 'over_refunded'
    | 'refund_ledger_mismatch';
  orderId: string;
  detail: string;
}

export interface ReconciliationReport {
  ranAt: number;
  checkedOrders: number;
  checkedRefunds: number;
  discrepancies: Discrepancy[];
  /** Pending orders past their window that were auto-expired (when heal=true). */
  healedStaleOrders: number;
}

export interface ReconciliationOptions {
  /** Auto-expire stale pending orders during the run. */
  heal?: boolean;
}

/**
 * A financial-consistency auditor. It cross-checks orders against their refunds
 * to surface states that should never occur (paid-but-unfulfilled, fulfilled
 * without payment, over-refunded, refund-ledger drift) plus operational drift
 * (stale pending orders). It is read-only unless `heal` is requested.
 *
 * The refund ledger invariant: an order's `refundedAmount` must equal the sum
 * of its non-FAILED refunds (SUCCESS + MANUAL settle the money; PENDING reserve
 * it — both are counted, FAILED refunds release their reservation).
 */
export class ReconciliationService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
    /** Optional healer (e.g. PaymentService.expireStaleOrders). */
    private readonly expireStale?: () => Promise<number>,
    private readonly now: () => number = Date.now,
  ) {}

  async run(opts: ReconciliationOptions = {}): Promise<ReconciliationReport> {
    const now = this.now();
    const allOrders = await this.orders.all();
    const allRefunds = await this.refunds.all();

    // Sum of reserved (non-FAILED) refunds per order.
    const reservedByOrder = new Map<string, number>();
    for (const r of allRefunds) {
      if (r.status === RefundStatus.FAILED) continue;
      reservedByOrder.set(r.orderId, (reservedByOrder.get(r.orderId) ?? 0) + r.amount);
    }

    const discrepancies: Discrepancy[] = [];
    for (const o of allOrders) {
      this.checkOrder(o, reservedByOrder.get(o.id) ?? 0, now, discrepancies);
    }

    let healedStaleOrders = 0;
    if (opts.heal && this.expireStale) {
      healedStaleOrders = await this.expireStale();
    }

    const report: ReconciliationReport = {
      ranAt: now,
      checkedOrders: allOrders.length,
      checkedRefunds: allRefunds.length,
      discrepancies,
      healedStaleOrders,
    };
    if (discrepancies.length) {
      logger.warn('reconciliation found discrepancies', { count: discrepancies.length });
    }
    return report;
  }

  private checkOrder(o: Order, reserved: number, now: number, out: Discrepancy[]): void {
    const refunded = o.refundedAmount ?? 0;

    if (o.status === OrderStatus.PAID && o.paidAt !== undefined) {
      out.push({ type: 'paid_unfulfilled', orderId: o.id, detail: 'order is PAID but was never fulfilled' });
    }
    if ((o.status === OrderStatus.FULFILLED || o.status === OrderStatus.REFUNDED) && o.paidAt === undefined) {
      out.push({ type: 'fulfilled_without_payment', orderId: o.id, detail: `status ${o.status} but paidAt is unset` });
    }
    if (o.status === OrderStatus.PENDING && o.expiresAt <= now) {
      out.push({ type: 'stale_pending', orderId: o.id, detail: `pending past expiry by ${now - o.expiresAt}ms` });
    }
    if (refunded > o.amount) {
      out.push({ type: 'over_refunded', orderId: o.id, detail: `refunded ${refunded} exceeds amount ${o.amount}` });
    }
    if (refunded !== reserved) {
      out.push({
        type: 'refund_ledger_mismatch',
        orderId: o.id,
        detail: `order.refundedAmount ${refunded} != sum of non-failed refunds ${reserved}`,
      });
    }
  }
}
