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
    users: container.users,
    reconciliation: container.reconciliation,
    audit: container.audit,
    pricing: container.pricing,
    processedEvents: container.processedEvents,
    processedEventTtlMs: container.config.processedEventTtlDays * 24 * 60 * 60 * 1000,
    plans: container.plans,
    enabledMethods: container.enabledMethods,
    adminToken: container.config.adminToken,
    metrics: container.metrics,
    routerMetrics: container.routerMetrics,
    rateLimit: container.rateLimit,
    usdtWatcher: container.usdtWatcher,
    webhooks: container.webhooks,
  });
  return createServer((req, res) => router.handle(req, res));
}
