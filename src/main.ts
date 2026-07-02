import { loadConfig, AppConfig } from './config';
import { buildContainer, ContainerOverrides } from './container';
import { createHttpServer } from './api/server';
import { GracefulShutdown } from './lifecycle/gracefulShutdown';
import { logger } from './utils/logger';
import { createPgClient, runMigrations, PgClientHandle } from './storage/sql/pgClient';
import { createRedisClient, RedisHandle } from './storage/redisClient';
import { SqlOrderRepository, SqlRefundRepository, SqlSubscriptionRepository, SqlProcessedEventStore } from './storage/sql/sqlStore';
import { SqlUserRepository } from './storage/sql/sqlUserStore';
import { SqlDepositAddressRepository, SqlSweepJobRepository } from './storage/sql/sqlDepositStore';
import { SqlAuditLog } from './storage/sql/sqlAuditLog';
import { RedisRateLimiter } from './api/redisRateLimiter';
import { TronWebTreasury } from './providers/usdt/tronWebTreasury';

/**
 * Assemble container overrides from the environment. When `DATABASE_URL` is set,
 * all repositories are backed by PostgreSQL (schema applied on boot) so state
 * survives restarts — required for a real deployment. When `REDIS_URL` is set,
 * rate limiting is Redis-backed so it is correct across multiple instances.
 * Returns the overrides plus any resources that must be closed on shutdown.
 */
async function buildOverrides(config: AppConfig): Promise<{
  overrides: ContainerOverrides;
  closers: Array<() => Promise<void> | void>;
}> {
  const overrides: ContainerOverrides = {};
  const closers: Array<() => Promise<void> | void> = [];

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const pg: PgClientHandle = createPgClient(databaseUrl);
    await runMigrations(pg.client);
    overrides.orders = new SqlOrderRepository(pg.client);
    overrides.refunds = new SqlRefundRepository(pg.client);
    overrides.subscriptions = new SqlSubscriptionRepository(pg.client);
    overrides.processedEvents = new SqlProcessedEventStore(pg.client);
    overrides.users = new SqlUserRepository(pg.client);
    overrides.audit = new SqlAuditLog(pg.client);
    overrides.depositAddresses = new SqlDepositAddressRepository(pg.client);
    overrides.sweepJobs = new SqlSweepJobRepository(pg.client);
    overrides.readinessSql = pg.client;
    closers.push(() => pg.end());
    logger.info('storage backend: postgres');
  } else {
    logger.warn('DATABASE_URL not set — using in-memory storage (state is LOST on restart; not for production)');
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const redis: RedisHandle = await createRedisClient(redisUrl);
    const max = Number(process.env.RATE_LIMIT_MAX ?? '100');
    const windowMs = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? '60') * 1000;
    overrides.rateLimiter = new RedisRateLimiter(redis, max, windowMs);
    overrides.readinessRedis = redis;
    closers.push(() => redis.quit());
    logger.info('rate limiter backend: redis (cross-instance)');
  }

  // Per-order USDT mode: build the tronweb-backed treasury from hot-wallet
  // secrets so the container can derive deposit addresses and sweep funds.
  if (config.usdt?.addressMode === 'per-order') {
    const mnemonic = process.env.USDT_HD_MNEMONIC;
    const feePrivateKey = process.env.USDT_FEE_PRIVATE_KEY;
    if (!mnemonic || !feePrivateKey) {
      throw new Error('USDT per-order mode requires USDT_HD_MNEMONIC and USDT_FEE_PRIVATE_KEY');
    }
    const treasury = new TronWebTreasury({
      fullHost: config.usdt.apiBase,
      apiKey: config.usdt.apiKey,
      mnemonic,
      hdPath: process.env.USDT_HD_PATH,
      feePrivateKey,
      contractAddress: config.usdt.contractAddress,
      minConfirmations: config.usdt.minConfirmations,
    });
    overrides.tronWallet = treasury;
    overrides.tronTreasury = treasury;
    logger.info('usdt: per-order deposit addresses + sweep enabled');
  }

  return { overrides, closers };
}

/** Process entrypoint: load config, wire the system, start the server + watcher. */
async function main(): Promise<void> {
  const config = loadConfig();
  const { overrides, closers } = await buildOverrides(config);
  const container = buildContainer(config, overrides);

  if (container.enabledMethods.length === 0) {
    logger.warn(
      'no payment methods configured; set WECHAT_*, ALIPAY_* and/or USDT_* env vars',
    );
  }

  container.usdtWatcher?.start();
  container.sweepWatcher?.start();
  container.sweepAlertWatcher?.start();
  container.expiryWatcher.start();
  container.webhookWatcher?.start();
  container.fxProvider?.start();

  const server = createHttpServer(container);

  // Graceful shutdown: stop background workers, drain in-flight requests, close
  // external resources (DB/Redis), then force lingering sockets after timeout.
  const graceful = new GracefulShutdown(server, {
    timeoutMs: config.shutdownTimeoutMs,
    stoppers: [
      () => container.usdtWatcher?.stop(),
      () => container.sweepWatcher?.stop(),
      () => container.sweepAlertWatcher?.stop(),
      () => container.expiryWatcher.stop(),
      () => container.webhookWatcher?.stop(),
      () => container.fxProvider?.stop(),
      ...closers,
    ],
  });
  graceful.install();

  server.listen(config.port, () => {
    logger.info('vpn-payment-backend listening', {
      port: config.port,
      methods: container.enabledMethods,
    });
  });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal: sig });
    const result = await graceful.shutdown();
    logger.info('shutdown complete', { result });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('fatal: failed to start', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
