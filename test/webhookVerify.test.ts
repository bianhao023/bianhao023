import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload } from '../src/webhooks/outbound';
import { verifyWebhookSignature } from '../src/webhooks/verify';

const SECRET = 'whsec_test_shared_secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'order.fulfilled', data: { amount: 100 } });

/** Fixed clock helper: reports `sec` seconds as milliseconds. */
function clockAt(sec: number): () => number {
  return () => sec * 1000;
}

test('a valid signature from signPayload verifies true', () => {
  const ts = '1750000000';
  const sig = signPayload(SECRET, ts, BODY);
  assert.equal(
    verifyWebhookSignature(SECRET, ts, BODY, sig, { now: clockAt(1750000000) }),
    true,
  );
});

test('tampered body returns false', () => {
  const ts = '1750000000';
  const sig = signPayload(SECRET, ts, BODY);
  const tampered = BODY.replace('100', '999');
  assert.equal(
    verifyWebhookSignature(SECRET, ts, tampered, sig, { now: clockAt(1750000000) }),
    false,
  );
});

test('wrong secret returns false', () => {
  const ts = '1750000000';
  const sig = signPayload(SECRET, ts, BODY);
  assert.equal(
    verifyWebhookSignature('whsec_wrong', ts, BODY, sig, { now: clockAt(1750000000) }),
    false,
  );
});

test('wrong signature returns false', () => {
  const ts = '1750000000';
  const sig = signPayload(SECRET, ts, BODY);
  // Flip the last hex nibble to make a same-length but invalid signature.
  const last = sig.slice(-1);
  const flipped = sig.slice(0, -1) + (last === '0' ? '1' : '0');
  assert.equal(
    verifyWebhookSignature(SECRET, ts, BODY, flipped, { now: clockAt(1750000000) }),
    false,
  );
});

test('timestamp outside toleranceSec returns false', () => {
  const ts = '1750000000';
  const sig = signPayload(SECRET, ts, BODY);
  // now is 301s ahead of ts, tolerance 300.
  assert.equal(
    verifyWebhookSignature(SECRET, ts, BODY, sig, {
      now: clockAt(1750000301),
      toleranceSec: 300,
    }),
    false,
  );
});

test('timestamp within toleranceSec returns true', () => {
  const ts = '1750000000';
  const sig = signPayload(SECRET, ts, BODY);
  // now is 299s ahead of ts, tolerance 300.
  assert.equal(
    verifyWebhookSignature(SECRET, ts, BODY, sig, {
      now: clockAt(1750000299),
      toleranceSec: 300,
    }),
    true,
  );
});

test('default tolerance (300s) rejects a stale timestamp', () => {
  const ts = '1750000000';
  const sig = signPayload(SECRET, ts, BODY);
  assert.equal(
    verifyWebhookSignature(SECRET, ts, BODY, sig, { now: clockAt(1750001000) }),
    false,
  );
});

test('non-numeric timestamp returns false without throwing', () => {
  const ts = 'not-a-number';
  // Build a signature with the same (garbage) timestamp string so only the
  // numeric parse is what rejects it.
  const sig = signPayload(SECRET, ts, BODY);
  assert.doesNotThrow(() => {
    assert.equal(
      verifyWebhookSignature(SECRET, ts, BODY, sig, { now: clockAt(1750000000) }),
      false,
    );
  });
});

test('empty / malformed signature header returns false without throwing', () => {
  const ts = '1750000000';
  assert.doesNotThrow(() => {
    assert.equal(
      verifyWebhookSignature(SECRET, ts, BODY, '', { now: clockAt(1750000000) }),
      false,
    );
    assert.equal(
      verifyWebhookSignature(SECRET, ts, BODY, 'garbage', { now: clockAt(1750000000) }),
      false,
    );
  });
});
