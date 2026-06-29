import { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../domain/errors';
import { logger } from '../utils/logger';

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
  /** Pattern segments; ":name" captures a param. */
  segments: string[];
  handler: Handler;
}

/** Tiny dependency-free router with path params and centralised error handling. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
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
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matched = this.match(req.method ?? 'GET', url.pathname);
    if (!matched) {
      sendJson(res, 404, { error: 'NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
    }
    const ctx: ReqContext = {
      method: req.method ?? 'GET',
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
    }
  }
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
