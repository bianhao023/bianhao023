import { uuid } from '../utils/ids';

/** A single, immutable entry in the append-only audit log. */
export interface AuditEvent {
  id: string;
  at: number;
  action: string;
  actor?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
}

/** Filter/pagination options for querying the audit log. */
export interface AuditQuery {
  action?: string;
  actor?: string;
  subjectId?: string;
  /** Inclusive lower bound on `at`. */
  from?: number;
  /** Exclusive upper bound on `at`. */
  to?: number;
  limit?: number;
  offset?: number;
}

/** Append-only audit log: events can be recorded and queried, never mutated. */
export interface AuditLog {
  record(input: {
    action: string;
    actor?: string;
    subjectId?: string;
    metadata?: Record<string, unknown>;
    at?: number;
  }): Promise<AuditEvent>;
  query(filter?: AuditQuery): Promise<{ total: number; items: AuditEvent[] }>;
}

const DEFAULT_LIMIT = 50;

/** Deep-clone an event via JSON round-trip so callers can't mutate stored state. */
function cloneEvent(event: AuditEvent): AuditEvent {
  return JSON.parse(JSON.stringify(event)) as AuditEvent;
}

/**
 * In-memory, append-only audit log with bounded memory.
 *
 * Events are stored in insertion order; queries return matching events
 * newest-first (by `at` desc, tie-broken by insertion order desc).
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEvent[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10000,
  ) {}

  async record(input: {
    action: string;
    actor?: string;
    subjectId?: string;
    metadata?: Record<string, unknown>;
    at?: number;
  }): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: uuid(),
      at: input.at ?? this.now(),
      action: input.action,
    };
    if (input.actor !== undefined) event.actor = input.actor;
    if (input.subjectId !== undefined) event.subjectId = input.subjectId;
    if (input.metadata !== undefined) event.metadata = input.metadata;

    // Store a clone so later mutation of `input.metadata` can't affect the log.
    this.entries.push(cloneEvent(event));

    // Keep memory bounded: drop the oldest entries when over capacity.
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return cloneEvent(event);
  }

  async query(filter: AuditQuery = {}): Promise<{ total: number; items: AuditEvent[] }> {
    const { action, actor, subjectId, from, to } = filter;

    // Filter by exact-match fields and by the [from, to) time range.
    const matched: Array<{ event: AuditEvent; index: number }> = [];
    for (let index = 0; index < this.entries.length; index++) {
      const event = this.entries[index];
      if (action !== undefined && event.action !== action) continue;
      if (actor !== undefined && event.actor !== actor) continue;
      if (subjectId !== undefined && event.subjectId !== subjectId) continue;
      if (from !== undefined && event.at < from) continue;
      if (to !== undefined && event.at >= to) continue;
      matched.push({ event, index });
    }

    // Sort newest-first: by `at` desc, tie-break by insertion order desc.
    matched.sort((a, b) => {
      if (b.event.at !== a.event.at) return b.event.at - a.event.at;
      return b.index - a.index;
    });

    const total = matched.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const page = matched.slice(offset, offset + limit);

    // Deep-clone on the way out so callers can't mutate stored state.
    return { total, items: page.map((m) => cloneEvent(m.event)) };
  }
}
