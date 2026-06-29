import { OrderRepository } from '../storage/repository';
import { PaymentService } from './paymentService';
import { logger } from '../utils/logger';

/**
 * Periodically reconciles pending USDT orders against the chain. Each pending
 * order is re-queried via PaymentService.syncOrder, which performs amount
 * matching, dedupe and fulfilment. Safe to run repeatedly.
 */
export class UsdtWatcher {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentService,
    private readonly intervalMs = 30_000,
  ) {}

  /** Run a single reconciliation pass. Returns the number of orders settled. */
  async reconcileOnce(): Promise<number> {
    const pending = await this.orders.findPendingByMethod('usdt');
    let settled = 0;
    for (const order of pending) {
      try {
        const updated = await this.payments.syncOrder(order.id);
        if (updated.status !== 'PENDING') settled++;
      } catch (err) {
        logger.warn('usdt reconcile error', {
          orderId: order.id,
          error: (err as Error).message,
        });
      }
    }
    return settled;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileOnce();
      void this.payments.expireStaleOrders();
    }, this.intervalMs);
    // Do not keep the process alive solely for this timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('usdt watcher started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
