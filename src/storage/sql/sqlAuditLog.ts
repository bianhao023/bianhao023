import { AuditEvent, AuditLog, AuditQuery } from '../../audit/auditLog';
import { uuid } from '../../utils/ids';
import { SqlClient } from './sqlStore';

const num = (v: unknown): number => Number(v);
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

/** Map a DB row to an AuditEvent. Exported for unit testing without a live DB. */
export function rowToAuditEvent(r: Record<string, unknown>): AuditEvent {
  const event: AuditEvent = {
    id: str(r.id),
    at: num(r.at),
    action: str(r.action),
  };
  const actor = optStr(r.actor);
  if (actor !== undefined) event.actor = actor;
  const subjectId = optStr(r.subject_id);
  if (subjectId !== undefined) event.subjectId = subjectId;
  if (r.metadata !== null && r.metadata !== undefined) {
    event.metadata = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) as Record<
      string,
      unknown
    >;
  }
  return event;
}

const DEFAULT_LIMIT = 50;

/**
 * PostgreSQL-backed, append-only audit log. Events are inserted immutably and
 * queried newest-first (by `at` desc). Compatible with the `pg` Pool/Client
 * via the shared {@link SqlClient} interface.
 */
export class SqlAuditLog implements AuditLog {
  constructor(
    private readonly db: SqlClient,
    private readonly now: () => number = Date.now,
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

    await this.db.query(
      `INSERT INTO audit_events
        (id, at, action, actor, subject_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        event.id,
        event.at,
        event.action,
        event.actor ?? null,
        event.subjectId ?? null,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
    return event;
  }

  async query(filter: AuditQuery = {}): Promise<{ total: number; items: AuditEvent[] }> {
    const { action, actor, subjectId, from, to } = filter;

    // Build a parameterized WHERE clause; values are only ever passed as
    // placeholder params ($n), never interpolated into the SQL string.
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (action !== undefined) {
      params.push(action);
      clauses.push(`action = $${params.length}`);
    }
    if (actor !== undefined) {
      params.push(actor);
      clauses.push(`actor = $${params.length}`);
    }
    if (subjectId !== undefined) {
      params.push(subjectId);
      clauses.push(`subject_id = $${params.length}`);
    }
    if (from !== undefined) {
      params.push(from);
      clauses.push(`at >= $${params.length}`);
    }
    if (to !== undefined) {
      params.push(to);
      clauses.push(`at < $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

    const countRes = await this.db.query(`SELECT COUNT(*) AS total FROM audit_events${where}`, params);
    const total = num(countRes.rows[0]?.total);

    const limit = filter.limit ?? DEFAULT_LIMIT;
    const offset = filter.offset ?? 0;
    const limitParams = [...params, limit, offset];
    const res = await this.db.query(
      `SELECT * FROM audit_events${where} ORDER BY at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      limitParams,
    );

    return { total, items: res.rows.map(rowToAuditEvent) };
  }
}
