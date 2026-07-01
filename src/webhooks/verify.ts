import { signPayload } from './outbound';
import { safeEqual } from '../utils/crypto';

/**
 * Merchant-side verification of an inbound webhook request. This is the exact
 * counterpart to {@link signPayload} used by the server's outbound dispatcher,
 * so the two schemes can never drift: the expected signature is recomputed by
 * importing and reusing `signPayload`.
 *
 * A merchant handler verifies a request like so:
 *
 * ```ts
 * import { verifyWebhookSignature } from './webhooks/verify';
 *
 * app.post('/webhooks', (req, res) => {
 *   const timestamp = req.header('X-Webhook-Timestamp') ?? '';
 *   const signature = req.header('X-Webhook-Signature') ?? '';
 *   const rawBody = req.rawBody; // the exact bytes as received, as a string
 *
 *   if (!verifyWebhookSignature(process.env.WEBHOOK_SECRET!, timestamp, rawBody, signature)) {
 *     return res.status(401).send('invalid signature');
 *   }
 *   // ...process the event...
 *   res.sendStatus(204);
 * });
 * ```
 */

export interface VerifyOptions {
  /** Max allowed skew (seconds) between `now()` and `timestamp`. Default 300. */
  toleranceSec?: number;
  /** Clock source in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Verify a webhook's HMAC-SHA256 signature and (optionally) its freshness.
 *
 * @param secret          The shared `WEBHOOK_SECRET`.
 * @param timestamp       Value of the `X-Webhook-Timestamp` header.
 * @param body            The raw request body, exactly as received.
 * @param signatureHeader Value of the `X-Webhook-Signature` header (`sha256=<hex>`).
 * @param opts            Optional tolerance / clock overrides.
 * @returns `true` iff the signature matches and the timestamp is within tolerance.
 *          Never throws — any parsing/compare error yields `false`.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signatureHeader: string,
  opts?: VerifyOptions,
): boolean {
  try {
    const toleranceSec = opts?.toleranceSec ?? 300;
    const now = opts?.now ?? Date.now;

    // Replay guard: reject non-finite or stale/future timestamps.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(now() / 1000 - ts) > toleranceSec) return false;

    const expected = signPayload(secret, timestamp, body);
    return safeEqual(expected, signatureHeader);
  } catch {
    return false;
  }
}
