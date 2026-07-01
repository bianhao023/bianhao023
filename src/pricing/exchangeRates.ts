/**
 * Dependency-free multi-currency exchange-rate abstraction.
 *
 * Rates are expressed in MAJOR units: `rate(from, to)` returns how many units
 * of `to` you get for 1 unit of `from` (e.g. rate('USD', 'CNY') ~= 7.2).
 *
 * This module is intentionally decoupled from the app's Currency union so it can
 * work with arbitrary ISO-like codes ('USD', 'EUR', 'CNY', 'USDT', ...).
 */

export interface ExchangeRateProvider {
  /** Units of `to` per 1 unit of `from` (major units). rate(x, x) === 1. */
  rate(from: string, to: string): number;
}

/**
 * A provider backed by a fixed table of rates relative to a single base
 * currency. `ratesFromBase[c]` = units of `c` per 1 unit of the base currency.
 *
 * Cross rates are derived as:
 *   rate(from, to) = ratesFromBase[to] / ratesFromBase[from]
 *
 * which is base-independent (the base cancels out).
 */
export class StaticExchangeRateProvider implements ExchangeRateProvider {
  private readonly baseCurrency: string;
  private readonly ratesFromBase: Record<string, number>;

  constructor(baseCurrency: string, ratesFromBase: Record<string, number>) {
    this.baseCurrency = baseCurrency;

    // Copy so external mutation can't corrupt us, and default the base to 1.
    const table: Record<string, number> = { ...ratesFromBase };
    if (table[baseCurrency] === undefined) {
      table[baseCurrency] = 1;
    }

    for (const [currency, value] of Object.entries(table)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(
          `StaticExchangeRateProvider: invalid rate for ${currency}: ${value}`,
        );
      }
    }
    this.ratesFromBase = table;
  }

  private lookup(currency: string): number {
    const value = this.ratesFromBase[currency];
    if (value === undefined) {
      throw new Error(
        `StaticExchangeRateProvider: unknown currency '${currency}' ` +
          `(base '${this.baseCurrency}', known: ${Object.keys(this.ratesFromBase).join(', ')})`,
      );
    }
    return value;
  }

  rate(from: string, to: string): number {
    if (from === to) {
      // Still validate the currency is known so typos never silently pass.
      this.lookup(from);
      return 1;
    }
    return this.lookup(to) / this.lookup(from);
  }
}

/**
 * Example / illustrative rate table ONLY. These are NOT live market rates and
 * must not be used for real settlement. Base currency is CNY; values are units
 * of each currency per 1 CNY.
 *
 *   1 CNY ~= 0.1389 USD  (i.e. 1 USD ~= 7.2 CNY)
 *   1 CNY ~= 0.1282 EUR
 *   1 CNY ~= 0.1389 USDT (pegged to USD here for the demo)
 */
export const DEMO_RATES_FROM_CNY: Record<string, number> = {
  CNY: 1,
  USD: 1 / 7.2,
  EUR: 1 / 7.8,
  USDT: 1 / 7.2,
};

/** Ready-made demo provider (illustrative values only — see DEMO_RATES_FROM_CNY). */
export const demoProvider = new StaticExchangeRateProvider('CNY', DEMO_RATES_FROM_CNY);
