import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsdtConfig, CANONICAL_USDT_TRC20 } from '../src/config';
import {
  allocateUniqueAmount,
  matchTransfer,
  UsdtTronProvider,
  Trc20Transfer,
} from '../src/providers/usdt/usdtTron';
import { Order, OrderStatus } from '../src/domain/types';
import { ProviderError } from '../src/domain/errors';
import { FakeChainClient } from './_helpers';

const ADDRESS = 'TXYZreceivingAddr00000000000000000';

function cfg(): UsdtConfig {
  return {
    addressMode: 'shared', hdStartIndex: 0,
    sweep: { minSweepMicro: 1_000_000, gasTopupSun: 15_000_000, gasMinSun: 10_000_000, maxAttempts: 10, backoffMs: 60_000 },
    receivingAddress: ADDRESS, contractAddress: CANONICAL_USDT_TRC20,
    apiBase: 'https://api.trongrid.io', minConfirmations: 19, uniqueAmountMaxDelta: 9999,
  };
}

function order(amount: number, createdAt = Date.now()): Order {
  return {
    id: 'o1', outTradeNo: 'VPN-USDT-1', userId: 'u1', planId: 'monthly', method: 'usdt',
    currency: 'USDT', amount, status: OrderStatus.PENDING, createdAt,
    updatedAt: createdAt, expiresAt: createdAt + 900_000, metadata: {},
  };
}

test('allocateUniqueAmount returns base when free, else next free delta', () => {
  assert.equal(allocateUniqueAmount(2_000_000, [], 9999), 2_000_000);
  assert.equal(allocateUniqueAmount(2_000_000, [2_000_000], 9999), 2_000_001);
  assert.equal(allocateUniqueAmount(2_000_000, [2_000_000, 2_000_001], 9999), 2_000_002);
});

test('allocateUniqueAmount throws when the delta space is exhausted', () => {
  const taken = [2_000_000, 2_000_001, 2_000_002];
  assert.throws(() => allocateUniqueAmount(2_000_000, taken, 2), ProviderError);
});

test('matchTransfer matches exact amount, confirmed, to our address', () => {
  const o = order(2_000_001);
  const transfers: Trc20Transfer[] = [
    { txId: 't1', to: ADDRESS, from: 'f', valueMicro: 2_000_000, timestampMs: o.createdAt, confirmed: true },
    { txId: 't2', to: ADDRESS, from: 'f', valueMicro: 2_000_001, timestampMs: o.createdAt, confirmed: true },
  ];
  const m = matchTransfer(o, transfers, ADDRESS, new Set());
  assert.equal(m?.txId, 't2');
});

test('matchTransfer ignores unconfirmed, wrong-address, already-claimed', () => {
  const o = order(2_000_001);
  const unconfirmed: Trc20Transfer = { txId: 'u', to: ADDRESS, from: 'f', valueMicro: 2_000_001, timestampMs: o.createdAt, confirmed: false };
  const wrongAddr: Trc20Transfer = { txId: 'w', to: 'OTHER', from: 'f', valueMicro: 2_000_001, timestampMs: o.createdAt, confirmed: true };
  const claimed: Trc20Transfer = { txId: 'c', to: ADDRESS, from: 'f', valueMicro: 2_000_001, timestampMs: o.createdAt, confirmed: true };
  assert.equal(matchTransfer(o, [unconfirmed, wrongAddr], ADDRESS, new Set()), undefined);
  assert.equal(matchTransfer(o, [claimed], ADDRESS, new Set(['c'])), undefined);
});

test('matchTransfer rejects transfers older than the order window', () => {
  const o = order(2_000_001, Date.now());
  const old: Trc20Transfer = { txId: 'old', to: ADDRESS, from: 'f', valueMicro: 2_000_001, timestampMs: o.createdAt - 10 * 60_000, confirmed: true };
  assert.equal(matchTransfer(o, [old], ADDRESS, new Set()), undefined);
});

test('createPayment returns the address and exact amount to send', async () => {
  const provider = new UsdtTronProvider(cfg(), new FakeChainClient());
  const res = await provider.createPayment(order(2_000_001));
  assert.equal(res.renderAs, 'address');
  assert.equal(res.payTarget, ADDRESS);
  assert.equal(res.extra.amount, '2.000001');
  assert.equal(res.extra.network, 'TRON (TRC20)');
});

test('queryPayment reports paid when a matching transfer exists', async () => {
  const chain = new FakeChainClient();
  const o = order(2_000_001);
  chain.transfers = [
    { txId: 'tx-match', to: ADDRESS, from: 'f', valueMicro: 2_000_001, timestampMs: o.createdAt, confirmed: true },
  ];
  const provider = new UsdtTronProvider(cfg(), chain);
  const q = await provider.queryPayment(o);
  assert.equal(q.paid, true);
  assert.equal(q.providerTxnId, 'tx-match');
  assert.equal(q.paidAmount, 2_000_001);
});

test('queryPayment reports unpaid when no transfer matches', async () => {
  const provider = new UsdtTronProvider(cfg(), new FakeChainClient());
  const q = await provider.queryPayment(order(2_000_001));
  assert.equal(q.paid, false);
});

test('verifyCallback is not supported for USDT', async () => {
  const provider = new UsdtTronProvider(cfg(), new FakeChainClient());
  await assert.rejects(() => provider.verifyCallback({ rawBody: '', headers: {} }), ProviderError);
});
