import { createServer, Server } from 'node:http';
import { Container } from '../container';
import { buildRouter } from './routes';

/** Build (but do not start) the HTTP server for a wired container. */
export function createHttpServer(container: Container): Server {
  const router = buildRouter({
    payments: container.payments,
    plans: container.plans,
    enabledMethods: container.enabledMethods,
    usdtWatcher: container.usdtWatcher,
  });
  return createServer((req, res) => router.handle(req, res));
}
