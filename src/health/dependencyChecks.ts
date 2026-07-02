import type { HealthCheck, CheckResult } from './readiness';
import type { SqlClient } from '../storage/sql/sqlStore';

/**
 * Factory functions that build concrete dependency-ping {@link HealthCheck}s
 * for the deep `/readyz` endpoint.
 *
 * The {@link import('./readiness').ReadinessAggregator} owns the cross-cutting
 * concerns — it runs each check in parallel, isolates thrown errors, applies a
 * per-check timeout, and decides whether a `critical` failure degrades the
 * overall status. These factories therefore stay deliberately small: each just
 * pings one backing service and reports whether it is reachable.
 *
 * Wiring into the container's readiness checks:
 *
 *   const aggregator = new ReadinessAggregator([
 *     sqlHealthCheck(pgPool),          // critical: DB outage ejects the node
 *     redisHealthCheck(redisClient),   // non-critical: rate limiting degrades
 *   ]);
 *   const report = await aggregator.run();
 *
 * As with the rest of this package, the concrete clients are injected via
 * narrow interfaces, so adding these checks introduces NO hard dependency on
 * `pg`, `node-redis`, or `ioredis`.
 */

/**
 * Minimal pingable Redis surface this module needs. The {@link
 * import('../api/redisRateLimiter').RedisLike} interface used by the rate
 * limiter intentionally omits `PING`, so we define our own single-method view
 * here. It is satisfied by both `node-redis` (v4) and `ioredis`, whose clients
 * expose a `ping()` returning the server's reply (`'PONG'`).
 */
export interface PingableRedis {
  ping(): Promise<string>;
}

/**
 * Build a readiness check that verifies the SQL database is reachable by
 * issuing a trivial `SELECT 1 AS ok` round-trip.
 *
 * The check never throws: a rejected query is caught and returned as an
 * `ok: false` result carrying the error message as `detail`. (The aggregator
 * would isolate a throw anyway, but returning a clean {@link CheckResult} keeps
 * the reported detail useful instead of a bare stack message.)
 *
 * Defaults to `critical: true` — a database outage means the node cannot serve
 * traffic, so it should degrade `/readyz` and be ejected from the load
 * balancer. The `timeoutMs` option is accepted for symmetry/documentation but
 * is not enforced here: the aggregator already applies its own per-check
 * timeout, so this check stays a single, un-raced query.
 *
 * @param db   Injected SQL client (compatible with a `pg` Pool/Client).
 * @param opts Optional overrides for `name`, `critical`, and `timeoutMs`.
 */
export function sqlHealthCheck(
  db: SqlClient,
  opts?: { name?: string; critical?: boolean; timeoutMs?: number },
): HealthCheck {
  return {
    name: opts?.name ?? 'sql',
    critical: opts?.critical ?? true,
    run: async (): Promise<CheckResult> => {
      const start = Date.now();
      try {
        await db.query('SELECT 1 AS ok');
        const ms = Date.now() - start;
        return { ok: true, detail: `reachable (${ms}ms)` };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, detail };
      }
    },
  };
}

/**
 * Build a readiness check that verifies Redis is reachable via `PING`.
 *
 * A truthy reply (the server returns `'PONG'`) is treated as healthy; any
 * falsy reply is reported as an unexpected-response failure, and a rejected
 * `ping()` is caught and surfaced as `detail`.
 *
 * Defaults to `critical: false`. Redis backs the distributed rate limiter,
 * which degrades gracefully to the in-process limiter when Redis is
 * unavailable — so a Redis outage should be visible in the report but must NOT
 * eject an otherwise-healthy node from the load balancer.
 *
 * @param client Injected pingable Redis client (`node-redis` or `ioredis`).
 * @param opts   Optional overrides for `name` and `critical`.
 */
export function redisHealthCheck(
  client: PingableRedis,
  opts?: { name?: string; critical?: boolean },
): HealthCheck {
  return {
    name: opts?.name ?? 'redis',
    critical: opts?.critical ?? false,
    run: async (): Promise<CheckResult> => {
      try {
        const reply = await client.ping();
        if (reply) {
          return { ok: true, detail: 'reachable' };
        }
        return { ok: false, detail: `unexpected ping reply: ${String(reply)}` };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, detail };
      }
    },
  };
}
