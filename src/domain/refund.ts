import { Currency } from './types';

/** Lifecycle of a refund. */
export enum RefundStatus {
  /** Submitted to the provider and awaiting settlement. */
  PENDING = 'PENDING',
  /** Provider confirmed the refund. */
  SUCCESS = 'SUCCESS',
  /** Provider rejected the refund. */
  FAILED = 'FAILED',
  /** No automatic refund channel (e.g. USDT) — an operator must send funds. */
  MANUAL = 'MANUAL',
}

/** A refund issued against a paid order. Supports partial refunds. */
export interface Refund {
  id: string;
  orderId: string;
  /** Merchant refund number sent to the provider (out_refund_no). */
  outRefundNo: string;
  /** Refund amount in the order currency's minor units. */
  amount: number;
  currency: Currency;
  reason?: string;
  status: RefundStatus;
  providerRefundId?: string;
  rawStatus: string;
  createdAt: number;
  updatedAt: number;
}

/** What a provider needs to perform a refund. */
export interface RefundRequest {
  outRefundNo: string;
  /** Amount to refund, in minor units. */
  amount: number;
  /** The original order total, in minor units (required by WeChat). */
  totalAmount: number;
  currency: Currency;
  reason?: string;
}

/** Normalised result of a provider refund call. */
export interface RefundResult {
  providerRefundId?: string;
  status: RefundStatus;
  rawStatus: string;
}
