import { loadConfig } from './config';
import { buildContainer } from './container';
import { createHttpServer } from './api/server';
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

  const server = createHttpServer(container);
  server.listen(config.port, () => {
    logger.info('vpn-payment-backend listening', {
      port: config.port,
      methods: container.enabledMethods,
    });
  });

  const shutdown = (sig: string) => {
    logger.info('shutting down', { signal: sig });
    container.usdtWatcher?.stop();
    container.expiryWatcher.stop();
    server.close(() => process.exit(0));
    // Force-exit if connections do not drain promptly.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
