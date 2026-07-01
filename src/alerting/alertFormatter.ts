import { ReconciliationReport, Discrepancy } from '../services/reconciliationService';

/** A normalized alert ready to be logged, emailed, or posted to a webhook. */
export interface Alert {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string;
  details: string[];
}

/** Discrepancy types that indicate real money/state inconsistency (critical). */
const CRITICAL_TYPES = new Set<Discrepancy['type']>([
  'paid_unfulfilled',
  'fulfilled_without_payment',
  'over_refunded',
  'refund_ledger_mismatch',
]);

const MAX_DETAIL_LINES = 50;

/**
 * Turn a reconciliation report into an alert, or `undefined` when the ledger is
 * clean. Severity is `critical` if any money/state inconsistency is present,
 * otherwise `warning` (e.g. only stale-pending drift).
 */
export function formatReconciliationAlert(report: ReconciliationReport): Alert | undefined {
  const { discrepancies } = report;
  if (discrepancies.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const d of discrepancies) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);

  const critical = discrepancies.some((d) => CRITICAL_TYPES.has(d.type));
  const severity: Alert['severity'] = critical ? 'critical' : 'warning';

  const summary =
    `${discrepancies.length} discrepancy(ies) across ${report.checkedOrders} orders — ` +
    [...counts.entries()].map(([type, n]) => `${type}=${n}`).join(', ');

  const details = discrepancies
    .slice(0, MAX_DETAIL_LINES)
    .map((d) => `[${d.type}] order ${d.orderId}: ${d.detail}`);
  if (discrepancies.length > MAX_DETAIL_LINES) {
    details.push(`… and ${discrepancies.length - MAX_DETAIL_LINES} more`);
  }

  return { severity, title: `Reconciliation ${severity}`, summary, details };
}

/**
 * Alert for dead-lettered webhook deliveries. `undefined` when none are dead.
 */
export function formatDeadLetterAlert(deadCount: number, sampleIds: string[] = []): Alert | undefined {
  if (deadCount <= 0) return undefined;
  const details = sampleIds.slice(0, MAX_DETAIL_LINES).map((id) => `delivery ${id}`);
  return {
    severity: 'warning',
    title: 'Webhook dead-letter queue non-empty',
    summary: `${deadCount} webhook delivery(ies) exhausted all retries`,
    details,
  };
}
