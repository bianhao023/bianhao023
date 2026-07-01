/**
 * Decimal-safe pricing / currency-conversion on integer minor units.
 *
 * The app stores money as integer minor units (see src/core/money.ts). This
 * module generalises conversion to arbitrary currencies, carrying its own
 * decimals map rather than assuming only CNY/USDT.
 *
 * Rounding rule: HALF-UP to the nearest minor unit of the target currency
 * (ties round away from zero; inputs are non-negative so this is "round up").
 */

import { ExchangeRateProvider } from './exchangeRates';

/** Decimal places per currency. Extend as new currencies are supported. */
export const DECIMALS: Record<string, number> = {
  CNY: 2,
  USDT: 6,
  USD: 2,
  EUR: 2,
};

/** Number of minor-unit decimals for a currency; throws on unknown. */
export function decimalsOf(currency: string): number {
  const d = DECIMALS[currency];
  if (d === undefined) {
    throw new Error(
      `unknown currency '${currency}' (known: ${Object.keys(DECIMALS).join(', ')})`,
    );
  }
  return d;
}

/**
 * Convert an integer minor amount in `from` to an integer minor amount in `to`.
 *
 * Major-unit relationship:
 *   majorTo = majorFrom * rate
 * Substituting minor = major * 10^decimals:
 *   minorTo = minorFrom * rate * 10^(decimalsTo - decimalsFrom)
 *
 * We compute this in floating point but apply a SINGLE Math.round at the end,
 * so there is no compounding of rounding error. Math.round is half-up
 * (ties toward +Infinity); inputs are non-negative so ties round away from zero.
 */
export function convertMinor(
  amountMinor: number,
  from: string,
  to: string,
  rate: number,
  decimalsFrom: number = decimalsOf(from),
  decimalsTo: number = decimalsOf(to),
): number {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`convertMinor: amountMinor must be a non-negative integer, got ${amountMinor}`);
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw new Error(`convertMinor: rate must be a non-negative finite number, got ${rate}`);
  }
  if (!Number.isInteger(decimalsFrom) || decimalsFrom < 0) {
    throw new Error(`convertMinor: decimalsFrom must be a non-negative integer, got ${decimalsFrom}`);
  }
  if (!Number.isInteger(decimalsTo) || decimalsTo < 0) {
    throw new Error(`convertMinor: decimalsTo must be a non-negative integer, got ${decimalsTo}`);
  }

  const scale = Math.pow(10, decimalsTo - decimalsFrom);
  const resultMinor = Math.round(amountMinor * rate * scale);

  if (!Number.isSafeInteger(resultMinor)) {
    throw new Error(`convertMinor: result ${resultMinor} exceeds safe integer range`);
  }
  return resultMinor;
}

/** Format an integer minor amount to a human decimal string for `decimals` places. */
export function formatMinor(amountMinor: number, decimals: number): string {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`formatMinor: amountMinor must be a non-negative integer, got ${amountMinor}`);
  }
  if (decimals === 0) return String(amountMinor);
  const factor = Math.pow(10, decimals);
  const intPart = Math.floor(amountMinor / factor);
  const fracPart = String(amountMinor % factor).padStart(decimals, '0');
  return `${intPart}.${fracPart}`;
}

export interface Quote {
  amountMinor: number;
  amountDisplay: string;
  currency: string;
  rate: number;
}

export class PricingService {
  private readonly rates: ExchangeRateProvider;

  constructor(rates: ExchangeRateProvider) {
    this.rates = rates;
  }

  /** Quote `amountMinor` (in `from`) converted to the target currency `to`. */
  quote(amountMinor: number, from: string, to: string): Quote {
    const decimalsFrom = decimalsOf(from);
    const decimalsTo = decimalsOf(to);
    const rate = this.rates.rate(from, to);
    const converted = convertMinor(amountMinor, from, to, rate, decimalsFrom, decimalsTo);
    return {
      amountMinor: converted,
      amountDisplay: formatMinor(converted, decimalsTo),
      currency: to,
      rate,
    };
  }
}
