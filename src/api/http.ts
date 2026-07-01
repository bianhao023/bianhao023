import { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../domain/errors';
import { Counter, Histogram } from '../observability/metrics';
import { RateLimiter } from './rateLimiter';
import { logger } from '../utils/logger';

/** Optional request-level instrumentation for the router. */
export interface RouterMetrics {
  requests: Counter; // labels: method, route, code
  duration: Histogram; // labels: route (milliseconds)
  rateLimited?: Counter; // labels: route
}

/** Optional rate-limiting configuration for the router. */
export interface RateLimitOptions {
  limiter: RateLimiter;
  /** Route patterns exempt from limiting (e.g. /healthz, /metrics). */
  skipRoutes: Set<string>;
}

export interface RouterOptions {
  metrics?: RouterMetrics;
  rateLimit?: RateLimitOptions;
}

export interface ReqContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  rawBody: string;
  headers: Record<string, string>;
}

export type Handler = (ctx: ReqContext, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  /** Original pattern (used as a low-cardinality metrics label). */
  pattern: string;
  /** Pattern segments; ":name" captures a param. */
  segments: string[];
  handler: Handler;
}

/** Tiny dependency-free router with path params and centralised error handling. */
export class Router {
  private routes: Route[] = [];
  private readonly metrics?: RouterMetrics;
  private readonly rateLimit?: RateLimitOptions;

  constructor(opts: RouterOptions = {}) {
    this.metrics = opts.metrics;
    this.rateLimit = opts.rateLimit;
  }

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern: pattern.startsWith('/') ? pattern : `/${pattern}`,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return undefined;
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1_000_000; // 1 MB guard

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: 'request body too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      void this.dispatch(req, res, Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      logger.error('request stream error', { error: err.message });
      if (!res.headersSent) sendJson(res, 400, { error: 'BAD_REQUEST', message: 'stream error' });
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<void> {
    const started = Date.now();
    const httpMethod = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matched = this.match(httpMethod, url.pathname);
    // Low-cardinality route label: the pattern, or "unmatched" for 404s.
    const routeLabel = matched ? matched.route.pattern : 'unmatched';

    const record = () => {
      if (!this.metrics) return;
      this.metrics.requests.inc({ method: httpMethod, route: routeLabel, code: String(res.statusCode) });
      this.metrics.duration.observe({ route: routeLabel }, Date.now() - started);
    };

    if (!matched) {
      sendJson(res, 404, { error: 'NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` });
      record();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
    }

    // Rate limiting (per client IP + route), unless the route is exempt.
    if (this.rateLimit && !this.rateLimit.skipRoutes.has(routeLabel)) {
      const ip = clientIp(req, headers);
      const decision = this.rateLimit.limiter.check(`${ip}|${routeLabel}`);
      res.setHeader('X-RateLimit-Limit', String(decision.limit));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSec));
        sendJson(res, 429, { error: 'RATE_LIMITED', message: 'too many requests' });
        this.metrics?.rateLimited?.inc({ route: routeLabel });
        record();
        return;
      }
    }
    const ctx: ReqContext = {
      method: httpMethod,
      path: url.pathname,
      params: matched.params,
      query: url.searchParams,
      rawBody,
      headers,
    };
    try {
      await matched.route.handler(ctx, res);
    } catch (err) {
      if (err instanceof AppError) {
        sendJson(res, err.httpStatus, { error: err.code, message: err.message });
      } else {
        logger.error('unhandled error', { error: (err as Error).message, stack: (err as Error).stack });
        sendJson(res, 500, { error: 'INTERNAL', message: 'internal server error' });
      }
    } finally {
      record();
    }
  }
}

/** Best-effort client IP: first X-Forwarded-For hop, else the socket address. */
export function clientIp(req: IncomingMessage, headers: Record<string, string>): string {
  const xff = headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

export function parseJsonBody(ctx: ReqContext): Record<string, unknown> {
  if (!ctx.rawBody) return {};
  try {
    const v = JSON.parse(ctx.rawBody);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
