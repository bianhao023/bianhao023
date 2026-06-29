import { randomBytes, randomUUID } from 'node:crypto';

/** Generate a globally-unique id (UUID v4). */
export function uuid(): string {
  return randomUUID();
}

/**
 * Generate a merchant order number (out_trade_no). Format:
 *   <prefix><YYYYMMDDHHmmss><6 random alphanumerics>
 * Stays within the length limits of WeChat (32) and Alipay (64).
 */
export function newOutTradeNo(prefix = 'VPN'): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  return `${prefix}${ts}${rand}`;
}

/** A random nonce string (used in WeChat request signing). */
export function nonceStr(len = 32): string {
  return randomBytes(len).toString('hex').slice(0, len);
}
