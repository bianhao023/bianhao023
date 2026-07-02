/**
 * Cyclic selector over a fixed, non-empty pool of items.
 *
 * Used to spread USDT gas funding across a fixed set of fee wallets: each sweep
 * that needs gas draws the next fee wallet in rotation, which avoids hammering a
 * single address (per-address rate limits / transaction contention) and spreads
 * hot-wallet balance/risk. Single-threaded by design (one event loop); no
 * locking needed.
 */
export class RoundRobin<T> {
  private cursor = 0;
  private readonly items: readonly T[];

  constructor(items: readonly T[]) {
    if (items.length === 0) throw new Error('RoundRobin: pool must be non-empty');
    this.items = [...items];
  }

  /** Return the next item, cycling back to the start after the last. */
  next(): T {
    const item = this.items[this.cursor % this.items.length];
    this.cursor += 1;
    return item;
  }

  /** Number of items in the pool. */
  get size(): number {
    return this.items.length;
  }

  /** All items (e.g. to sum balances across every fee wallet). */
  all(): readonly T[] {
    return this.items;
  }
}
