/**
 * Dependency-free CSV export module (RFC 4180 compliant).
 *
 * Used to export orders and refunds to CSV for reporting/reconciliation.
 */

import { Order } from '../domain/types';
import { Refund } from '../domain/refund';

/** Convert a single cell value to its string representation. */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Escape a cell per RFC 4180: wrap in double quotes if it contains a comma,
 * double quote, CR or LF; any internal double quotes are doubled.
 */
function escapeCell(value: unknown): string {
  const s = stringifyCell(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Render rows to an RFC 4180 CSV string.
 *
 * - The first line is the header (the `columns` names).
 * - One line per row, cells in `columns` order.
 * - CRLF line endings, including a trailing CRLF after the last row.
 * - An empty `rows` array yields just the header line + CRLF.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const lines: string[] = [];
  lines.push(columns.map(escapeCell).join(','));
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row[col])).join(','));
  }
  return lines.map((line) => line + '\r\n').join('');
}

export const ORDER_COLUMNS: string[] = [
  'id',
  'outTradeNo',
  'userId',
  'planId',
  'method',
  'currency',
  'amount',
  'status',
  'refundedAmount',
  'providerTxnId',
  'createdAt',
  'paidAt',
  'expiresAt',
];

export const REFUND_COLUMNS: string[] = [
  'id',
  'orderId',
  'outRefundNo',
  'amount',
  'currency',
  'status',
  'providerRefundId',
  'createdAt',
];

/** Map each Order to a plain record over ORDER_COLUMNS and render to CSV. */
export function ordersToCsv(orders: Order[]): string {
  const rows = orders.map((o): Record<string, unknown> => ({
    id: o.id,
    outTradeNo: o.outTradeNo,
    userId: o.userId,
    planId: o.planId,
    method: o.method,
    currency: o.currency,
    amount: o.amount,
    status: o.status,
    refundedAmount: o.refundedAmount ?? 0,
    providerTxnId: o.providerTxnId,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    expiresAt: o.expiresAt,
  }));
  return toCsv(rows, ORDER_COLUMNS);
}

/** Map each Refund to a plain record over REFUND_COLUMNS and render to CSV. */
export function refundsToCsv(refunds: Refund[]): string {
  const rows = refunds.map((r): Record<string, unknown> => ({
    id: r.id,
    orderId: r.orderId,
    outRefundNo: r.outRefundNo,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    providerRefundId: r.providerRefundId,
    createdAt: r.createdAt,
  }));
  return toCsv(rows, REFUND_COLUMNS);
}
