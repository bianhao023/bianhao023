import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReconciliationAlert, formatDeadLetterAlert } from '../src/alerting/alertFormatter';
import { ReconciliationReport, Discrepancy } from '../src/services/reconciliationService';

function report(discrepancies: Discrepancy[]): ReconciliationReport {
  return { ranAt: 0, checkedOrders: 10, checkedRefunds: 3, discrepancies, healedStaleOrders: 0 };
}

test('no discrepancies produces no alert', () => {
  assert.equal(formatReconciliationAlert(report([])), undefined);
});

test('money/state inconsistencies are critical with a type breakdown', () => {
  const a = formatReconciliationAlert(report([
    { type: 'over_refunded', orderId: 'o1', detail: 'refunded 2000 exceeds amount 1500' },
    { type: 'paid_unfulfilled', orderId: 'o2', detail: 'PAID but never fulfilled' },
  ]))!;
  assert.equal(a.severity, 'critical');
  assert.match(a.summary, /over_refunded=1/);
  assert.match(a.summary, /paid_unfulfilled=1/);
  assert.equal(a.details.length, 2);
  assert.match(a.details[0], /\[over_refunded\] order o1/);
});

test('only stale-pending drift is a warning', () => {
  const a = formatReconciliationAlert(report([
    { type: 'stale_pending', orderId: 'o1', detail: 'pending past expiry' },
  ]))!;
  assert.equal(a.severity, 'warning');
});

test('details are capped with an overflow line', () => {
  const many: Discrepancy[] = Array.from({ length: 60 }, (_, i) => ({
    type: 'stale_pending', orderId: `o${i}`, detail: 'x',
  }));
  const a = formatReconciliationAlert(report(many))!;
  assert.equal(a.details.length, 51); // 50 + overflow line
  assert.match(a.details[50], /and 10 more/);
});

test('dead-letter alert reflects the queue depth', () => {
  assert.equal(formatDeadLetterAlert(0), undefined);
  const a = formatDeadLetterAlert(3, ['d1', 'd2'])!;
  assert.equal(a.severity, 'warning');
  assert.match(a.summary, /3 webhook/);
  assert.equal(a.details.length, 2);
});
