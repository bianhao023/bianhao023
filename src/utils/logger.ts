/* Minimal structured logger. Silenced when LOG_LEVEL=silent (used in tests). */

import { currentRequestId } from '../observability/requestContext';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (lvl === 'silent') return 100;
  return ORDER[(lvl as Level)] ?? ORDER.info;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  // Auto-correlate with the ambient request id (explicit meta.requestId wins).
  const requestId = currentRequestId();
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(requestId && !(meta && 'requestId' in meta) ? { requestId } : {}),
    ...(meta ?? {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
