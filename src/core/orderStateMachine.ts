import { OrderStatus } from '../domain/types';
import { InvalidStateError } from '../domain/errors';

/**
 * Allowed order state transitions. The map value is the set of states that may
 * be reached directly from the key state.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [
    OrderStatus.PAID,
    OrderStatus.EXPIRED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.PAID]: [OrderStatus.FULFILLED, OrderStatus.REFUNDED],
  [OrderStatus.FULFILLED]: [OrderStatus.REFUNDED],
  // Terminal states.
  [OrderStatus.EXPIRED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.FAILED]: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Validate a transition. Returns the target state.
 *
 * Idempotency: re-applying the SAME state (e.g. PENDING->PAID arriving twice)
 * is treated as a successful no-op, which is essential for duplicate payment
 * callbacks. The caller is responsible for not double-applying side effects;
 * `assertTransition` only governs the status field.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (from === to) return to; // idempotent no-op
  if (!canTransition(from, to)) {
    throw new InvalidStateError(`cannot transition order from ${from} to ${to}`);
  }
  return to;
}
