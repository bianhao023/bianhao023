/**
 * Caching secret provider: the "future KMS/Vault provider" foreshadowed by the
 * closing comment in `./secretProvider`. It realises exactly that pattern — a
 * synchronous `SecretProvider` face over an asynchronous remote store.
 *
 * The `SecretProvider` interface is synchronous, but real secret stores (AWS
 * KMS / Secrets Manager, HashiCorp Vault) are network-bound and async. This
 * provider bridges the two by never blocking on I/O in `get`/`getRotating`:
 * those methods serve strictly from an in-memory cache. Values arrive in the
 * cache via `prime` (awaitable startup warm-up) and via non-blocking background
 * refreshes kicked off on cache misses and on stale reads. Call-sites keep the
 * same synchronous `SecretProvider` contract and never change.
 */

import { Secret, SecretProvider } from './secretProvider';
import { logger } from '../utils/logger';

/** A remote secret store (KMS / Vault / Secrets Manager). Async by nature. */
export interface RemoteSecretSource {
  /** Fetch the current (+ optional previous) value for `name`; undefined if absent. */
  fetch(name: string): Promise<Secret | undefined>;
}

/*
 * A real AWS Secrets Manager source would implement `RemoteSecretSource` along
 * these lines (pseudo-code — no aws-sdk dependency in this zero-runtime-dep
 * project). It maps the newest secret version to `current` and the prior
 * (AWSPREVIOUS-staged) version to `previous`, exactly mirroring rotation:
 *
 *   class SecretsManagerSource implements RemoteSecretSource {
 *     constructor(private client: SecretsManagerClient) {}
 *     async fetch(name: string): Promise<Secret | undefined> {
 *       try {
 *         const current = await this.client.send(
 *           new GetSecretValueCommand({ SecretId: name, VersionStage: 'AWSCURRENT' }),
 *         );
 *         if (current.SecretString === undefined) return undefined;
 *         let previous: string | undefined;
 *         try {
 *           const prev = await this.client.send(
 *             new GetSecretValueCommand({ SecretId: name, VersionStage: 'AWSPREVIOUS' }),
 *           );
 *           previous = prev.SecretString;
 *         } catch {
 *           previous = undefined; // no prior version staged yet
 *         }
 *         return previous === undefined
 *           ? { current: current.SecretString }
 *           : { current: current.SecretString, previous };
 *       } catch (err) {
 *         if (err.name === 'ResourceNotFoundException') return undefined;
 *         throw err; // surfaced to the caller of refresh(); swallowed in background
 *       }
 *     }
 *   }
 */

/** Options for {@link CachingSecretProvider}. */
export interface CachingSecretProviderOptions {
  /** How long a cached entry is considered fresh, in ms. Default 300_000 (5 min). */
  ttlMs?: number;
  /** Clock injection point (for tests). Default `Date.now`. */
  now?: () => number;
}

/** A cached secret plus the wall-clock time at which it goes stale. */
interface CacheEntry {
  value: Secret;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 300_000;

/**
 * Synchronous {@link SecretProvider} backed by an async {@link RemoteSecretSource}.
 *
 * Because `get`/`getRotating` may not block, they serve only from the in-memory
 * cache and use a **stale-while-revalidate** strategy:
 *
 * - Fresh hit: return the cached value.
 * - Stale hit (present but past its TTL): return the stale `current`/`previous`
 *   value immediately AND kick off a non-blocking background refresh so the
 *   next call sees an up-to-date value.
 * - Miss (absent): return undefined immediately AND kick off a background
 *   refresh so the value becomes available for a subsequent call.
 *
 * Background refreshes are fire-and-forget; their rejections are swallowed and
 * logged via `logger.warn` and never surface to the caller or as an unhandled
 * rejection. Concurrent refreshes for the same name are de-duplicated so N
 * simultaneous misses trigger exactly one underlying `fetch`.
 *
 * Use {@link prime} at startup to populate the cache so the first real `get` is
 * a hit, and {@link refresh} for an awaitable single fetch when you need the
 * up-to-date value directly.
 */
export class CachingSecretProvider implements SecretProvider {
  private readonly source: RemoteSecretSource;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Secret | undefined>>();

  constructor(source: RemoteSecretSource, opts: CachingSecretProviderOptions = {}) {
    this.source = source;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return the current value for `name` from cache, or undefined if not cached.
   * Never blocks: on a miss (or a stale entry) it triggers a background refresh
   * and returns the cached (possibly stale) value, or undefined if absent.
   */
  get(name: string): string | undefined {
    return this.serve(name)?.current;
  }

  /**
   * Return `{ current, previous }` for `name` from cache, or undefined if not
   * cached. `previous` is omitted when the cached secret has no prior value.
   * Same stale-while-revalidate semantics as {@link get}.
   */
  getRotating(name: string): Secret | undefined {
    const value = this.serve(name);
    if (value === undefined) return undefined;
    return value.previous === undefined
      ? { current: value.current }
      : { current: value.current, previous: value.previous };
  }

  /**
   * Awaitable warm-up: fetch all `names` in parallel and populate the cache so
   * the first real `get`/`getRotating` is a hit. Names the source reports as
   * absent are simply skipped; individual failures are logged and do not reject
   * the returned promise.
   */
  async prime(names: string[]): Promise<void> {
    await Promise.all(names.map((name) => this.backgroundRefresh(name)));
  }

  /**
   * Awaitable single fetch that updates the cache and returns the value (or
   * undefined if absent). Concurrent calls for the same name share one fetch.
   * Unlike the background path, this rejects if the source rejects, so callers
   * that want the fresh value can observe and handle the error.
   */
  async refresh(name: string): Promise<Secret | undefined> {
    const existing = this.inFlight.get(name);
    if (existing !== undefined) return existing;

    const promise = this.source
      .fetch(name)
      .then((value) => {
        if (value === undefined) {
          this.cache.delete(name);
        } else {
          this.cache.set(name, { value, expiresAt: this.now() + this.ttlMs });
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(name);
      });

    this.inFlight.set(name, promise);
    return promise;
  }

  /**
   * Serve `name` from cache, applying stale-while-revalidate: return the cached
   * value if present (kicking a background refresh when stale), else trigger a
   * background refresh and return undefined. Never blocks.
   */
  private serve(name: string): Secret | undefined {
    const entry = this.cache.get(name);
    if (entry === undefined) {
      this.backgroundRefresh(name);
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      // Stale-while-revalidate: hand back the stale value, refresh in the
      // background so the next call sees the up-to-date value.
      this.backgroundRefresh(name);
    }
    return entry.value;
  }

  /**
   * Fire-and-forget refresh: dedupes via {@link refresh} and swallows any
   * rejection (logged as a warning) so a failing background fetch never becomes
   * an unhandled rejection. Returns the settled promise so callers like
   * {@link prime} can await completion without risk of rejection.
   */
  private backgroundRefresh(name: string): Promise<void> {
    return this.refresh(name).then(
      () => undefined,
      (err: unknown) => {
        logger.warn('secret background refresh failed', { name, error: String(err) });
      },
    );
  }
}
