/**
 * Domain types for per-order USDT deposit addresses and the sweep ("二次归集")
 * pipeline that collects settled funds into a central wallet.
 *
 * Model: in `per-order` address mode each USDT order is assigned its own TRON
 * deposit address, derived deterministically from a treasury HD wallet at a
 * unique index. Payments are matched by that address (not by a unique amount).
 * Once an order settles, a {@link SweepJob} drives the funds from the deposit
 * address to the configured collection address.
 */

/** A per-order TRON deposit address derived from the treasury HD wallet. */
export interface DepositAddress {
  /** HD derivation index — unique and monotonically increasing. */
  index: number;
  /** Base58 TRON address (`T…`). */
  address: string;
  /** The order this address is assigned to. */
  orderId: string;
  createdAt: number;
}

/**
 * Lifecycle of a sweep job. The pipeline is advanced one step per watcher tick
 * so it works with real on-chain confirmation latency:
 *
 *   PENDING ─▶ GAS_FUELING ─▶ SWEEPING ─▶ SWEPT
 *      │            │             │
 *      │            └─────────────┴──▶ FAILED (retries exhausted)
 *      └─▶ EMPTY (nothing above the dust threshold to sweep)
 */
export enum SweepStatus {
  /** Queued; not yet inspected on-chain. */
  PENDING = 'PENDING',
  /** TRX gas sent to the deposit address; awaiting confirmation. */
  GAS_FUELING = 'GAS_FUELING',
  /** TRC20 transfer to the collection address broadcast; awaiting confirmation. */
  SWEEPING = 'SWEEPING',
  /** Funds confirmed at the collection address. Terminal. */
  SWEPT = 'SWEPT',
  /** Balance was below the dust threshold; nothing to move. Terminal. */
  EMPTY = 'EMPTY',
  /** Retries exhausted. Terminal; requires manual attention. */
  FAILED = 'FAILED',
}

/** True for sweep states that need no further processing. */
export function isSweepTerminal(status: SweepStatus): boolean {
  return status === SweepStatus.SWEPT || status === SweepStatus.EMPTY || status === SweepStatus.FAILED;
}

/** A unit of work that collects one order's deposit into the central wallet. */
export interface SweepJob {
  id: string;
  orderId: string;
  /** HD index of the source deposit address. */
  depositIndex: number;
  /** Source deposit address the funds sit at. */
  depositAddress: string;
  /** Destination (central collection) address. */
  collectionAddress: string;
  /** Amount to sweep in micro-USDT; set from the on-chain balance once known. */
  amountMicro: number;
  status: SweepStatus;
  /** TRX gas-fueling transaction id, once sent. */
  gasTxId?: string;
  /** TRC20 sweep transaction id, once broadcast. */
  sweepTxId?: string;
  /** How many times processing has been attempted (for backoff / failure). */
  attempts: number;
  /** Last error message, for observability. */
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  /** Earliest time the watcher should (re)attempt this job. */
  nextAttemptAt: number;
}
