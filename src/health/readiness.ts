/**
 * Pure readiness-check aggregator for a deep `/readyz` endpoint.
 *
 * The aggregator runs a set of independent health checks in parallel, guards
 * each against throwing and against hanging (via a per-check timeout), and
 * summarises the outcome into a single {@link ReadinessReport}.
 *
 * HTTP mapping (left to the caller / route handler):
 *   - `status === 'ok'`       -> respond `200 OK`
 *   - `status === 'degraded'` -> respond `503 Service Unavailable`
 * The full report is typically serialised as the JSON body in both cases so
 * operators can see which checks failed.
 */

/** Outcome of a single health check. */
export interface CheckResult {
  ok: boolean;
  detail?: string;
}

/** A named readiness probe. `critical` checks can degrade overall status. */
export interface HealthCheck {
  name: string;
  critical?: boolean;
  run: () => Promise<CheckResult> | CheckResult;
}

/** Aggregated readiness outcome across all checks. */
export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: Array<{ name: string; ok: boolean; critical: boolean; detail?: string }>;
}

/** Options controlling aggregation behaviour. */
export interface ReadinessOptions {
  /** Per-check timeout in milliseconds (default 2000). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Runs a collection of {@link HealthCheck}s and aggregates their results.
 *
 * Each check is isolated: a thrown error or rejected promise becomes an
 * `ok: false` row (with the error message as `detail`), and a check that does
 * not settle within `timeoutMs` becomes an `ok: false` row with `detail:
 * 'timeout'`. Only failures of `critical` checks degrade the overall status.
 */
export class ReadinessAggregator {
  private readonly timeoutMs: number;

  constructor(private checks: HealthCheck[], opts?: ReadinessOptions) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Execute all checks in parallel and produce a report (input order preserved). */
  async run(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map((check) => this.runOne(check)),
    );

    const rows = this.checks.map((check, i) => {
      const result = results[i];
      const critical = check.critical ?? false;
      const row: { name: string; ok: boolean; critical: boolean; detail?: string } = {
        name: check.name,
        ok: result.ok,
        critical,
      };
      if (result.detail !== undefined) {
        row.detail = result.detail;
      }
      return row;
    });

    const degraded = rows.some((row) => row.critical && !row.ok);
    return { status: degraded ? 'degraded' : 'ok', checks: rows };
  }

  /** Run a single check with error isolation and a timeout guard. */
  private runOne(check: HealthCheck): Promise<CheckResult> {
    const execution = (async (): Promise<CheckResult> => {
      try {
        return await check.run();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, detail };
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CheckResult>((resolve) => {
      // The timer is short-lived and always cleared on settle, so it must NOT
      // be unref'd — otherwise, if a check hangs and nothing else keeps the
      // loop alive, the timeout would never fire and run() would never resolve.
      timer = setTimeout(() => resolve({ ok: false, detail: 'timeout' }), this.timeoutMs);
    });

    return Promise.race([execution, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}
