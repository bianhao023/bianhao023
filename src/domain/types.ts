/**
 * Core domain types shared across the payment backend.
 *
 * Monetary values are ALWAYS stored as integer "minor units" to avoid
 * floating-point rounding errors:
 *   - CNY  : 1 unit = 1 fen   (1 CNY  = 100)
 *   - USDT : 1 unit = 1 micro (1 USDT = 1_000_000, TRC20 has 6 decimals)
 */

export type Currency = 'CNY' | 'USDT';

export type PaymentMethod = 'wechat' | 'alipay' | 'usdt';

export const ALL_METHODS: PaymentMethod[] = ['wechat', 'alipay', 'usdt'];

/** Number of decimal places used by each currency's on-chain / fiat unit. */
export const CURRENCY_DECIMALS: Record<Currency, number> = {
  CNY: 2,
  USDT: 6,
};

/**
 * The lifecycle of an order. Transitions are enforced by the order state
 * machine (see core/orderStateMachine.ts).
 *
 *   PENDING ──▶ PAID ──▶ FULFILLED
 *      │          │
 *      │          └──▶ REFUNDED
 *      ├──▶ EXPIRED
 *      ├──▶ CANCELLED
 *      └──▶ FAILED
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FULFILLED = 'FULFILLED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
}

/** A purchasable VPN plan. */
export interface Plan {
  id: string;
  name: string;
  /** How many days of VPN access this plan grants. */
  durationDays: number;
  /** Monthly/total data allowance in GB. 0 means unlimited. */
  trafficGb: number;
  /** Maximum simultaneous devices. */
  deviceLimit: number;
  /** Price in CNY minor units (fen). */
  priceCnyFen: number;
  /** Price in USDT minor units (micro-USDT). */
  priceUsdtMicro: number;
  enabled: boolean;
}

/** An order placed by a user for a plan. */
export interface Order {
  id: string;
  /** Merchant order number sent to the payment provider (out_trade_no). */
  outTradeNo: string;
  userId: string;
  planId: string;
  method: PaymentMethod;
  currency: Currency;
  /** Amount due, in the currency's minor units. */
  amount: number;
  status: OrderStatus;
  /** Provider transaction id once paid (wechat transaction_id, alipay trade_no, tron txid). */
  providerTxnId?: string;
  /** Idempotency key supplied by the client to dedupe order creation. */
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  paidAt?: number;
  /** Total amount refunded so far, in minor units (0 when never refunded). */
  refundedAmount?: number;
  /** Provider/method specific data (e.g. USDT receiving address, unique amount). */
  metadata: Record<string, string>;
}

/** A user's active VPN subscription, produced when an order is fulfilled. */
export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  /** Epoch millis when access starts. */
  startsAt: number;
  /** Epoch millis when access ends. */
  expiresAt: number;
  trafficGb: number;
  deviceLimit: number;
  active: boolean;
  /** Orders that contributed to this subscription, newest last. */
  orderIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Result of asking a provider to create a payment intent. */
export interface CreatePaymentResult {
  method: PaymentMethod;
  /** Human-payable target: a QR code payload / pay URL / deposit address. */
  payTarget: string;
  /**
   * Discriminates how the client should render payTarget:
   *  - 'qrcode'  : render payTarget as a QR code (wechat native, alipay precreate)
   *  - 'address' : crypto deposit address (usdt)
   *  - 'redirect': open payTarget in a browser
   */
  renderAs: 'qrcode' | 'address' | 'redirect';
  /** Extra display fields (e.g. exact USDT amount, network, expiry). */
  extra: Record<string, string>;
}

/** Normalised outcome of verifying a provider callback / on-chain match. */
export interface CallbackResult {
  /** Which merchant order this refers to. */
  outTradeNo: string;
  /** Provider's own transaction id. */
  providerTxnId: string;
  /** True only when the provider reports a successful, settled payment. */
  paid: boolean;
  /** Amount the provider says was actually paid, in minor units. */
  paidAmount: number;
  currency: Currency;
  /** A stable id used to deduplicate repeated callbacks for the same event. */
  eventId: string;
  /** Raw provider status string, for auditing. */
  rawStatus: string;
}

/** Outcome of actively querying a provider for an order's status. */
export interface QueryResult {
  paid: boolean;
  providerTxnId?: string;
  paidAmount?: number;
  rawStatus: string;
}
