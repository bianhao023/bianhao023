import { createServer, Server } from 'node:http';
import { Container } from '../container';
import { buildRouter } from './routes';

/** Build (but do not start) the HTTP server for a wired container. */
export function createHttpServer(container: Container): Server {
  const router = buildRouter({
    payments: container.payments,
    refunds: container.refunds,
    reports: container.reports,
    expiry: container.expiry,
    plans: container.plans,
    enabledMethods: container.enabledMethods,
    adminToken: container.config.adminToken,
    usdtWatcher: container.usdtWatcher,
  });
  return createServer((req, res) => router.handle(req, res));
}
