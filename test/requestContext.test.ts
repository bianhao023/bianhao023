import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithRequestId, currentRequestId } from '../src/observability/requestContext';
import { logger } from '../src/utils/logger';

test('currentRequestId is bound inside the scope and unset outside', () => {
  assert.equal(currentRequestId(), undefined);
  runWithRequestId('rid-1', () => {
    assert.equal(currentRequestId(), 'rid-1');
  });
  assert.equal(currentRequestId(), undefined);
});

test('context propagates across async boundaries', async () => {
  await runWithRequestId('rid-async', async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(currentRequestId(), 'rid-async');
  });
});

/** Capture logger output regardless of ambient LOG_LEVEL. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const origLevel = process.env.LOG_LEVEL;
  const origOut = process.stdout.write.bind(process.stdout);
  process.env.LOG_LEVEL = 'info';
  (process.stdout as { write: unknown }).write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as { write: unknown }).write = origOut;
    if (origLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = origLevel;
  }
  return lines;
}

test('logger auto-correlates with the ambient request id', () => {
  const lines = captureLog(() => {
    runWithRequestId('rid-log', () => logger.info('order created', { orderId: 'o1' }));
  });
  const entry = JSON.parse(lines.join(''));
  assert.equal(entry.requestId, 'rid-log');
  assert.equal(entry.orderId, 'o1');
  assert.equal(entry.msg, 'order created');
});

test('explicit meta.requestId is not overridden by the ambient id', () => {
  const lines = captureLog(() => {
    runWithRequestId('ambient', () => logger.info('x', { requestId: 'explicit' }));
  });
  assert.equal(JSON.parse(lines.join('')).requestId, 'explicit');
});

test('no requestId field when outside any scope', () => {
  const lines = captureLog(() => logger.info('bare'));
  assert.equal('requestId' in JSON.parse(lines.join('')), false);
});
