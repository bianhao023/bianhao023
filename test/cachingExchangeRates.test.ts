import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CachingExchangeRateProvider,
  HttpRateFeed,
  RateFeed,
} from '../src/pricing/cachingExchangeRates';
import { StaticExchangeRateProvider } from '../src/pricing/exchangeRates';
import { HttpClient } from '../src/providers/provider';

// A fallback provider (base CNY): 1 USD = 8 CNY (i.e. USD = 1/8 per CNY).
function makeFallback(): StaticExchangeRateProvider {
  return new StaticExchangeRateProvider('CNY', { CNY: 1, USD: 1 / 8 });
}

// A controllable fake feed.
class FakeFeed implements RateFeed {
  calls = 0;
  constructor(private readonly rates: Record<string, number>) {}
  async fetchRates(_base: string): Promise<Record<string, number>> {
    this.calls += 1;
    return { ...this.rates };
  }
}

class ThrowingFeed implements RateFeed {
  calls = 0;
  async fetchRates(_base: string): Promise<Record<string, number>> {
    this.calls += 1;
    throw new Error('feed down');
  }
}

test('before refresh: serves fallback and is stale; after refresh serves fetched rates', async () => {
  const feed = new FakeFeed({ CNY: 1, USD: 1 / 7 }); // fresh: 1 USD = 7 CNY
  const fallback = makeFallback();
  let clock = 1000;
  const provider = new CachingExchangeRateProvider(feed, 'CNY', fallback, {
    ttlMs: 5000,
    now: () => clock,
  });

  // Before any refresh: fallback value (1 USD = 8 CNY) and stale.
  assert.equal(provider.rate('USD', 'CNY'), 8);
  assert.equal(provider.isStale(), true);

  const ok = await provider.refresh();
  assert.equal(ok, true);
  assert.equal(feed.calls, 1);

  // After refresh: fetched value (1 USD = 7 CNY) and fresh.
  assert.equal(provider.rate('USD', 'CNY'), 7);
  assert.equal(provider.isStale(), false);

  // Advance clock beyond ttl → stale again, but still serves cached rates.
  clock += 6000;
  assert.equal(provider.isStale(), true);
  assert.equal(provider.rate('USD', 'CNY'), 7);
});

test('feed throws: refresh returns false, does not throw, serves fallback when never succeeded', async () => {
  const feed = new ThrowingFeed();
  const fallback = makeFallback();
  const provider = new CachingExchangeRateProvider(feed, 'CNY', fallback, {
    ttlMs: 5000,
    now: () => 0,
  });

  const ok = await provider.refresh();
  assert.equal(ok, false);
  assert.equal(feed.calls, 1);
  // Never succeeded → still serves fallback.
  assert.equal(provider.rate('USD', 'CNY'), 8);
  assert.equal(provider.isStale(), true);
});

test('feed throws after a good refresh: keeps last-good cache', async () => {
  let clock = 0;
  const good = new FakeFeed({ CNY: 1, USD: 1 / 7 });
  const fallback = makeFallback();
  const provider = new CachingExchangeRateProvider(good, 'CNY', fallback, {
    ttlMs: 5000,
    now: () => clock,
  });

  assert.equal(await provider.refresh(), true);
  assert.equal(provider.rate('USD', 'CNY'), 7);

  // Swap in a throwing feed by constructing a new provider sharing the cache is
  // not possible; instead simulate a later failing refresh on a provider whose
  // feed now throws. Use a feed that succeeds once then throws.
  let call = 0;
  const flaky: RateFeed = {
    async fetchRates() {
      call += 1;
      if (call === 1) return { CNY: 1, USD: 1 / 6 };
      throw new Error('later failure');
    },
  };
  const p2 = new CachingExchangeRateProvider(flaky, 'CNY', fallback, {
    ttlMs: 5000,
    now: () => clock,
  });
  assert.equal(await p2.refresh(), true); // 1 USD = 6 CNY
  assert.equal(p2.rate('USD', 'CNY'), 6);
  assert.equal(await p2.refresh(), false); // fails, keeps cache
  assert.equal(p2.rate('USD', 'CNY'), 6);
});

test('HttpRateFeed parses nested { rates: {...} } shape and includes base=1', async () => {
  const http: HttpClient = {
    async request(opts) {
      assert.equal(opts.method, 'GET');
      assert.equal(opts.url, 'https://api.example/CNY');
      return {
        status: 200,
        body: JSON.stringify({ rates: { USD: 1 / 7, EUR: 1 / 8 } }),
      };
    },
  };
  const feed = new HttpRateFeed(http, 'https://api.example/{base}');
  const rates = await feed.fetchRates('CNY');
  assert.equal(rates.CNY, 1);
  assert.equal(rates.USD, 1 / 7);
  assert.equal(rates.EUR, 1 / 8);
});

test('HttpRateFeed parses flat { CUR: n } shape and includes base=1', async () => {
  const http: HttpClient = {
    async request() {
      return { status: 200, body: JSON.stringify({ USD: 1 / 7 }) };
    },
  };
  const feed = new HttpRateFeed(http, 'https://api.example/rates');
  const rates = await feed.fetchRates('CNY');
  assert.equal(rates.CNY, 1);
  assert.equal(rates.USD, 1 / 7);
});

test('HttpRateFeed throws on non-2xx status', async () => {
  const http: HttpClient = {
    async request() {
      return { status: 503, body: 'unavailable' };
    },
  };
  const feed = new HttpRateFeed(http, 'https://api.example/rates');
  await assert.rejects(() => feed.fetchRates('CNY'), /non-2xx status 503/);
});

test('HttpRateFeed feeds into CachingExchangeRateProvider end-to-end', async () => {
  const http: HttpClient = {
    async request() {
      return { status: 200, body: JSON.stringify({ rates: { USD: 1 / 7 } }) };
    },
  };
  const feed = new HttpRateFeed(http, 'https://api.example/{base}');
  const provider = new CachingExchangeRateProvider(feed, 'CNY', makeFallback(), {
    now: () => 0,
  });
  assert.equal(await provider.refresh(), true);
  assert.equal(provider.rate('USD', 'CNY'), 7);
});

test('start()/stop() are safe and unref the timer', async () => {
  const feed = new FakeFeed({ CNY: 1, USD: 1 / 7 });
  const provider = new CachingExchangeRateProvider(feed, 'CNY', makeFallback());
  // stop() before start() is a no-op.
  provider.stop();
  provider.start(10_000);
  provider.stop();
  // No assertion beyond "does not throw / does not keep process alive".
  assert.ok(true);
});
