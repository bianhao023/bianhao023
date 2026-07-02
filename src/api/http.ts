import { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../domain/errors';
import { Counter, Histogram } from '../observability/metrics';
import { RateLimiterLike } from './rateLimiter';
import { API_VERSION } from '../version';
import { uuid } from '../utils/ids';
import { runWithRequestId } from '../observability/requestContext';
import { logger } from '../utils/logger';

/** Optional request-level instrumentation for the router. */
export interface RouterMetrics {
  requests: Counter; // labels: method, route, code
  duration: Histogram; // labels: route (milliseconds)
  rateLimited?: Counter; // labels: route
}

/** Optional rate-limiting configuration for the router. */
export interface RateLimitOptions {
  limiter: RateLimiterLike;
  /** Route patterns exempt from limiting (e.g. /healthz, /metrics). */
  skipRoutes: Set<string>;
}

/** HTTP hardening applied to every request. */
export interface SecurityOptions {
  /** Allowed CORS origins: `['*']` = any, `[]` = disabled, else an allow-list. */
  corsOrigins: string[];
  requestTimeoutMs: number;
  maxBodyBytes: number;
  securityHeaders: boolean;
}

export interface RouterOptions {
  metrics?: RouterMetrics;
  rateLimit?: RateLimitOptions;
  security?: SecurityOptions;
}

export interface ReqContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  rawBody: string;
  headers: Record<string, string>;
  /** Correlation id for this request (echoed as the X-Request-Id header). */
  requestId: string;
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
  private readonly security?: SecurityOptions;
  /** Route patterns advertised as deprecated -> optional Sunset date (RFC 8594). */
  private deprecated = new Map<string, string | undefined>();

  constructor(opts: RouterOptions = {}) {
    this.metrics = opts.metrics;
    this.rateLimit = opts.rateLimit;
    this.security = opts.security;
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

  /**
   * Register every existing route under `from` (a path prefix) again under
   * `to`, sharing the handler — e.g. expose `/api/*` also at `/api/v1/*`.
   * Snapshot the current routes so aliases are not themselves re-aliased.
   */
  aliasPrefix(from: string, to: string): this {
    for (const route of [...this.routes]) {
      if (route.pattern === from || route.pattern.startsWith(from + '/')) {
        this.add(route.method, to + route.pattern.slice(from.length), route.handler);
      }
    }
    return this;
  }

  /** Advertise a route pattern as deprecated (adds Deprecation/Sunset headers). */
  markDeprecated(pattern: string, sunsetHttpDate?: string): this {
    this.deprecated.set(pattern.startsWith('/') ? pattern : `/${pattern}`, sunsetHttpDate);
    return this;
  }

  /** Read-only list of registered routes (method + pattern), for contract tests. */
  listRoutes(): Array<{ method: string; pattern: string }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern }));
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

  /** Set security response headers and CORS allow-origin for the request. */
  private applySecurityHeaders(res: ServerResponse, origin?: string): void {
    res.setHeader('X-API-Version', API_VERSION);
    const sec = this.security;
    if (!sec) return;
    if (sec.securityHeaders) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-DNS-Prefetch-Control', 'off');
    }
    if (sec.corsOrigins.length > 0) {
      if (sec.corsOrigins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else if (origin && sec.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    }
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxBody = this.security?.maxBodyBytes ?? 1_000_000;

    // Per-request timeout: respond 503 rather than hanging a socket.
    const timeoutMs = this.security?.requestTimeoutMs;
    if (timeoutMs && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        if (!res.headersSent) sendJson(res, 503, { error: 'REQUEST_TIMEOUT', message: 'request timed out' });
        req.destroy();
      });
    }

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) {
        if (!res.headersSent) sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: 'request body too large' });
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

    // Security response headers + CORS, applied to every response.
    this.applySecurityHeaders(res, req.headers['origin']);

    // Correlation id: honour an inbound X-Request-Id or mint one, and echo it.
    const requestId = String(req.headers['x-request-id'] || uuid());
    res.setHeader('X-Request-Id', requestId);

    // CORS preflight: answer OPTIONS before route matching.
    if (httpMethod === 'OPTIONS' && this.security && this.security.corsOrigins.length > 0) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204).end();
      return;
    }

    const matched = this.match(httpMethod, url.pathname);
    // Low-cardinality route label: the pattern, or "unmatched" for 404s.
    const routeLabel = matched ? matched.route.pattern : 'unmatched';

    const record = () => {
      const durationMs = Date.now() - started;
      if (this.metrics) {
        this.metrics.requests.inc({ method: httpMethod, route: routeLabel, code: String(res.statusCode) });
        this.metrics.duration.observe({ route: routeLabel }, durationMs);
      }
      // Structured access log, correlatable by requestId.
      const fwd = req.headers['x-forwarded-for'];
      const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      logger.info('request', { requestId, method: httpMethod, route: routeLabel, status: res.statusCode, durationMs, ip });
    };

    if (!matched) {
      sendJson(res, 404, { error: 'NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` });
      record();
      return;
    }

    // Deprecation advertising (RFC 8594) for sunsetting routes.
    if (this.deprecated.has(routeLabel)) {
      res.setHeader('Deprecation', 'true');
      const sunset = this.deprecated.get(routeLabel);
      if (sunset) res.setHeader('Sunset', sunset);
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
    }

    // Rate limiting (per client IP + route), unless the route is exempt.
    if (this.rateLimit && !this.rateLimit.skipRoutes.has(routeLabel)) {
      const ip = clientIp(req, headers);
      const decision = await this.rateLimit.limiter.check(`${ip}|${routeLabel}`);
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
      requestId,
    };
    try {
      // Bind the request id to the async context so service/repository logs
      // during this handler are automatically correlated.
      await runWithRequestId(requestId, () => matched.route.handler(ctx, res));
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
