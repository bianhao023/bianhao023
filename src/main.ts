import { loadConfig } from './config';
import { buildContainer } from './container';
import { createHttpServer } from './api/server';
import { GracefulShutdown } from './lifecycle/gracefulShutdown';
import { logger } from './utils/logger';

/** Process entrypoint: load config, wire the system, start the server + watcher. */
function main(): void {
  const config = loadConfig();
  const container = buildContainer(config);

  if (container.enabledMethods.length === 0) {
    logger.warn(
      'no payment methods configured; set WECHAT_*, ALIPAY_* and/or USDT_* env vars',
    );
  }

  container.usdtWatcher?.start();
  container.expiryWatcher.start();
  container.webhookWatcher?.start();
  container.fxProvider?.start();

  const server = createHttpServer(container);

  // Graceful shutdown: stop background workers, drain in-flight requests, then
  // force any lingering sockets closed after the configured timeout.
  const graceful = new GracefulShutdown(server, {
    timeoutMs: config.shutdownTimeoutMs,
    stoppers: [
      () => container.usdtWatcher?.stop(),
      () => container.expiryWatcher.stop(),
      () => container.webhookWatcher?.stop(),
      () => container.fxProvider?.stop(),
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

main();
