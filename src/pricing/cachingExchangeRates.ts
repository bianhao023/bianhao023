/**
 * Caching, live exchange-rate provider.
 *
 * `CachingExchangeRateProvider` keeps a synchronous `ExchangeRateProvider`
 * surface (as required by callers) while refreshing rates asynchronously over a
 * pluggable `RateFeed`. Refreshed rates are held in a `StaticExchangeRateProvider`
 * with a TTL; when no fresh cache exists, lookups fall back to a static provider.
 *
 * Design notes:
 *  - `rate()` is synchronous and never throws due to staleness — it serves the
 *    best-available data (fresh cache, then last-good cache, then fallback).
 *  - `refresh()` never throws; on failure it logs and keeps the previous cache.
 */

import {
  ExchangeRateProvider,
  StaticExchangeRateProvider,
} from './exchangeRates';
import { HttpClient } from '../providers/provider';
import { logger } from '../utils/logger';

/**
 * A source of live rates. `fetchRates(base)` returns a `ratesFromBase` map:
 * units of each currency per 1 unit of `base`. The map must include the base as
 * 1 (or the caching provider will add it).
 */
export interface RateFeed {
  fetchRates(base: string): Promise<Record<string, number>>;
}

const DEFAULT_TTL_MS = 3_600_000;

export interface CachingExchangeRateProviderOptions {
  ttlMs?: number;
  now?: () => number;
}

export class CachingExchangeRateProvider implements ExchangeRateProvider {
  private readonly feed: RateFeed;
  private readonly base: string;
  private readonly fallback: ExchangeRateProvider;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private cached: StaticExchangeRateProvider | undefined;
  private lastRefreshAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    feed: RateFeed,
    base: string,
    fallback: ExchangeRateProvider,
    opts?: CachingExchangeRateProviderOptions,
  ) {
    this.feed = feed;
    this.base = base;
    this.fallback = fallback;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
  }

  /**
   * Units of `to` per 1 unit of `from`. Serves the cached provider when one has
   * been built, otherwise delegates to the fallback. Never throws due to
   * staleness — stale-but-present cache is still served.
   */
  rate(from: string, to: string): number {
    const provider = this.cached ?? this.fallback;
    return provider.rate(from, to);
  }

  /**
   * Fetch fresh rates and rebuild the cached provider. Returns true on success.
   * On error, logs via logger.warn, keeps the previous cache, and returns false.
   * Never throws.
   */
  async refresh(): Promise<boolean> {
    try {
      const rates = await this.feed.fetchRates(this.base);
      const table: Record<string, number> = { ...rates };
      // Ensure the base is present as 1 (StaticExchangeRateProvider also does
      // this, but we make the intent explicit here).
      if (table[this.base] === undefined) {
        table[this.base] = 1;
      }
      this.cached = new StaticExchangeRateProvider(this.base, table);
      this.lastRefreshAt = this.now();
      return true;
    } catch (err) {
      logger.warn('CachingExchangeRateProvider: refresh failed', {
        base: this.base,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** True if never refreshed, or the last refresh is older than the TTL. */
  isStale(): boolean {
    if (this.lastRefreshAt === undefined) {
      return true;
    }
    return this.now() - this.lastRefreshAt > this.ttlMs;
  }

  /**
   * Begin self-scheduling refreshes. Safe to call repeatedly (a running timer is
   * stopped first). The timer is unref'd so it never keeps the process alive.
   * Default interval is the TTL.
   */
  start(intervalMs?: number): void {
    this.stop();
    const period = intervalMs ?? this.ttlMs;
    this.timer = setInterval(() => {
      // refresh() never throws; swallow the returned promise deliberately.
      void this.refresh();
    }, period);
    // unref may be unavailable on some timer shims; guard defensively.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /** Stop self-scheduling. Safe to call even if start() was never called. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Default JSON parser used by `HttpRateFeed`. Accepts either:
 *   { "rates": { "USD": 7.2, ... } }   // rates nested under `rates`
 *   { "USD": 7.2, ... }                // a flat map of rates
 * Values are units of each currency per 1 unit of `base`. Ensures `base: 1`.
 */
function defaultParse(body: string, base: string): Record<string, number> {
  const json: unknown = JSON.parse(body);
  if (json === null || typeof json !== 'object') {
    throw new Error('HttpRateFeed: response is not a JSON object');
  }

  const obj = json as Record<string, unknown>;
  const source =
    obj.rates !== undefined && obj.rates !== null && typeof obj.rates === 'object'
      ? (obj.rates as Record<string, unknown>)
      : obj;

  const out: Record<string, number> = {};
  for (const [currency, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[currency] = value;
    }
  }
  if (out[base] === undefined) {
    out[base] = 1;
  }
  return out;
}

export class HttpRateFeed implements RateFeed {
  private readonly http: HttpClient;
  private readonly url: string;
  private readonly parse: (body: string, base: string) => Record<string, number>;

  constructor(
    http: HttpClient,
    url: string,
    parse?: (body: string, base: string) => Record<string, number>,
  ) {
    this.http = http;
    this.url = url;
    this.parse = parse ?? defaultParse;
  }

  async fetchRates(base: string): Promise<Record<string, number>> {
    const url = this.url.replace(/\{base\}/g, encodeURIComponent(base));
    const res = await this.http.request({ method: 'GET', url });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `HttpRateFeed: GET ${url} returned non-2xx status ${res.status}`,
      );
    }
    return this.parse(res.body, base);
  }
}
