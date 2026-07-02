/**
 * Lazy Redis adapter. Like the Postgres adapter, `redis` (node-redis v4) is
 * `require`d only here and only when `REDIS_URL` is configured, so the core
 * library and tests carry no hard dependency on it. `redis` is declared as an
 * optionalDependency.
 *
 * The returned handle satisfies both interfaces the app needs:
 *   - `RedisLike`     (incr/pexpire/pttl) for the distributed rate limiter, and
 *   - `PingableRedis` (ping)              for the `/readyz` readiness check.
 */

import type { RedisLike } from '../api/redisRateLimiter';
import type { PingableRedis } from '../health/dependencyChecks';
import { logger } from '../utils/logger';

/** Combined Redis surface used across the app, plus a shutdown hook. */
export interface RedisHandle extends RedisLike, PingableRedis {
  /** Close the connection (call on graceful shutdown). */
  quit(): Promise<void>;
}

/** The subset of the node-redis v4 client we call (avoids a hard type dep). */
interface NodeRedisClient {
  connect(): Promise<void>;
  quit(): Promise<unknown>;
  on(event: 'error', handler: (err: Error) => void): void;
  incr(key: string): Promise<number>;
  pExpire(key: string, ms: number): Promise<unknown>;
  pTTL(key: string): Promise<number>;
  ping(): Promise<string>;
}

/**
 * Connect to Redis and return a {@link RedisHandle}. Awaitable because
 * node-redis v4 requires an explicit `connect()` before use. Throws a clear
 * error if `REDIS_URL` is set but the `redis` package is not installed.
 */
export async function createRedisClient(url: string): Promise<RedisHandle> {
  let createClient: (opts: { url: string }) => NodeRedisClient;
  try {
    createClient = (require('redis') as { createClient: (opts: { url: string }) => NodeRedisClient }).createClient;
  } catch {
    throw new Error(
      "REDIS_URL is set but the 'redis' package is not installed. " +
        'Run `npm install redis` (it is declared as an optional dependency).',
    );
  }

  const client = createClient({ url });
  // Never let a connection blip crash the process; the rate limiter degrades.
  client.on('error', (err: Error) => logger.error('redis client error', { error: err.message }));
  await client.connect();

  return {
    // node-redis v4 uses camelCase (pExpire/pTTL); map to the RedisLike names.
    incr: (key: string) => client.incr(key),
    pexpire: (key: string, ms: number) => client.pExpire(key, ms),
    pttl: (key: string) => client.pTTL(key),
    ping: () => client.ping(),
    quit: async () => {
      await client.quit();
    },
  };
}
