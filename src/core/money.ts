import { Currency, CURRENCY_DECIMALS } from '../domain/types';
import { ValidationError } from '../domain/errors';

/**
 * Decimal-safe money helpers. All arithmetic in the system is done on integer
 * minor units; these helpers only convert at the boundary (display / parsing).
 */

/** Convert a human decimal string/number (e.g. "12.34") to integer minor units. */
export function toMinorUnits(value: string | number, currency: Currency): number {
  const decimals = CURRENCY_DECIMALS[currency];
  const str = typeof value === 'number' ? value.toFixed(decimals) : value.trim();

  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new ValidationError(`invalid monetary value: ${value}`);
  }

  const [intPart, fracPartRaw = ''] = str.split('.');
  if (fracPartRaw.length > decimals) {
    // Reject more precision than the currency supports rather than silently rounding.
    throw new ValidationError(
      `value ${str} has more than ${decimals} decimal places for ${currency}`,
    );
  }
  const fracPart = fracPartRaw.padEnd(decimals, '0');
  const minor = BigInt(intPart) * BigInt(10 ** decimals) + BigInt(fracPart || '0');

  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError(`value ${str} is too large`);
  }
  return Number(minor);
}

/** Format integer minor units back to a human decimal string (e.g. 1234 -> "12.34"). */
export function fromMinorUnits(minor: number, currency: Currency): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new ValidationError(`invalid minor-unit amount: ${minor}`);
  }
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals === 0) return String(minor);
  const factor = 10 ** decimals;
  const intPart = Math.floor(minor / factor);
  const fracPart = String(minor % factor).padStart(decimals, '0');
  return `${intPart}.${fracPart}`;
}
