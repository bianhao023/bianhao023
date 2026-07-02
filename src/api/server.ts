import { createServer, Server } from 'node:http';
import { Container } from '../container';
import { ApiDeps, buildRouter } from './routes';
import { Router } from './http';

/** Assemble the API dependencies from a wired container. */
export function apiDepsFromContainer(container: Container): ApiDeps {
  return {
    payments: container.payments,
    refunds: container.refunds,
    reports: container.reports,
    expiry: container.expiry,
    users: container.users,
    reconciliation: container.reconciliation,
    audit: container.audit,
    pricing: container.pricing,
    readiness: container.readiness,
    alertSink: container.alertSink,
    processedEvents: container.processedEvents,
    processedEventTtlMs: container.config.processedEventTtlDays * 24 * 60 * 60 * 1000,
    plans: container.plans,
    enabledMethods: container.enabledMethods,
    adminToken: container.config.adminToken,
    adminTokenPrevious: container.config.adminTokenPrevious,
    metrics: container.metrics,
    routerMetrics: container.routerMetrics,
    rateLimit: container.rateLimit,
    security: container.security,
    usdtWatcher: container.usdtWatcher,
    webhooks: container.webhooks,
    sweepJobs: container.sweepJobs,
    sweepService: container.sweepService,
  };
}

/** Build the router for a wired container (shared by the server and tests). */
export function buildContainerRouter(container: Container): Router {
  return buildRouter(apiDepsFromContainer(container));
}

/** Build (but do not start) the HTTP server for a wired container. */
export function createHttpServer(container: Container): Server {
  const router = buildContainerRouter(container);
  return createServer((req, res) => router.handle(req, res));
}
