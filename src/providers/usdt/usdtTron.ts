import { UsdtConfig } from '../../config';
import {
  CallbackResult,
  CreatePaymentResult,
  Order,
  QueryResult,
} from '../../domain/types';
import { ProviderError } from '../../domain/errors';
import { HttpClient, PaymentProvider, RawCallback } from '../provider';
import { fromMinorUnits } from '../../core/money';

/** A normalised incoming TRC20 transfer. */
export interface Trc20Transfer {
  txId: string;
  to: string;
  from: string;
  /** Transfer value in micro-USDT (integer). */
  valueMicro: number;
  timestampMs: number;
  /** Whether the transfer has reached the required confirmations. */
  confirmed: boolean;
}

/** Reads on-chain TRC20 transfers. Injectable so the watcher is testable. */
export interface TronChainClient {
  getIncomingTransfers(
    address: string,
    contract: string,
    sinceMs: number,
  ): Promise<Trc20Transfer[]>;
}

/**
 * Allocate a unique receivable amount so deposits to a shared address can be
 * matched to a specific order. We add a small per-order delta (micro-USDT) to
 * the base price, avoiding any delta already in use by another pending order.
 *
 * Returns the unique amount in micro-USDT. Throws if the space is exhausted.
 */
export function allocateUniqueAmount(
  basePriceMicro: number,
  takenAmountsMicro: Iterable<number>,
  maxDelta: number,
): number {
  const taken = new Set(takenAmountsMicro);
  for (let delta = 0; delta <= maxDelta; delta++) {
    const candidate = basePriceMicro + delta;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ProviderError('no unique USDT amount available; try again later');
}

/** Match an order against a list of confirmed transfers by exact amount. */
export function matchTransfer(
  order: Order,
  transfers: Trc20Transfer[],
  receivingAddress: string,
  claimedTxIds: Set<string>,
): Trc20Transfer | undefined {
  // Small timing tolerance for clock differences between us and the chain.
  const earliest = order.createdAt - 5 * 60_000;
  return transfers.find(
    (t) =>
      t.confirmed &&
      t.to === receivingAddress &&
      t.valueMicro === order.amount &&
      t.timestampMs >= earliest &&
      !claimedTxIds.has(t.txId),
  );
}

/**
 * Match an order in per-order mode: the deposit address is unique to the order,
 * so any confirmed transfer to it that covers the amount settles it (over-
 * payment is accepted downstream; under-payment is rejected). Address
 * uniqueness — not the amount — is what disambiguates the order.
 */
export function matchByAddress(
  order: Order,
  transfers: Trc20Transfer[],
  depositAddress: string,
  claimedTxIds: Set<string>,
): Trc20Transfer | undefined {
  const earliest = order.createdAt - 5 * 60_000;
  return transfers.find(
    (t) =>
      t.confirmed &&
      t.to === depositAddress &&
      t.valueMicro >= order.amount &&
      t.timestampMs >= earliest &&
      !claimedTxIds.has(t.txId),
  );
}

/** USDT (TRC20) provider using shared-address + unique-amount reconciliation. */
export class UsdtTronProvider implements PaymentProvider {
  readonly method = 'usdt' as const;

  constructor(
    private readonly cfg: UsdtConfig,
    private readonly chain: TronChainClient,
  ) {}

  async createPayment(order: Order): Promise<CreatePaymentResult> {
    const perOrder = this.cfg.addressMode === 'per-order';
    // In per-order mode each order has its own address (set on the order
    // metadata by the allocator before this call); in shared mode all orders
    // use the one receiving address and are told an exact, unique amount.
    const payTarget = perOrder
      ? (order.metadata['depositAddress'] ?? '')
      : this.cfg.receivingAddress;
    if (perOrder && !payTarget) {
      throw new ProviderError('per-order USDT mode: order has no deposit address allocated');
    }
    return {
      method: this.method,
      payTarget,
      renderAs: 'address',
      extra: {
        network: 'TRON (TRC20)',
        contract: this.cfg.contractAddress,
        amount: fromMinorUnits(order.amount, 'USDT'),
        currency: 'USDT',
        note: perOrder
          ? 'Send USDT (TRC20) to this address; it is dedicated to your order.'
          : 'Send the exact amount shown so we can confirm your payment automatically.',
      },
    };
  }

  // USDT has no signed push callback; settlement is detected by reconciliation.
  async verifyCallback(_cb: RawCallback): Promise<CallbackResult> {
    throw new ProviderError('USDT settlement is detected on-chain, not via callbacks');
  }

  async queryPayment(order: Order): Promise<QueryResult> {
    const perOrder = this.cfg.addressMode === 'per-order';
    const watchAddress = perOrder ? (order.metadata['depositAddress'] ?? '') : this.cfg.receivingAddress;
    if (perOrder && !watchAddress) return { paid: false, rawStatus: 'NO_ADDRESS' };

    const transfers = await this.chain.getIncomingTransfers(
      watchAddress,
      this.cfg.contractAddress,
      order.createdAt - 5 * 60_000,
    );
    const match = perOrder
      ? matchByAddress(order, transfers, watchAddress, new Set())
      : matchTransfer(order, transfers, watchAddress, new Set());
    if (!match) return { paid: false, rawStatus: 'NO_MATCH' };
    return {
      paid: true,
      providerTxnId: match.txId,
      paidAmount: match.valueMicro,
      rawStatus: 'CONFIRMED',
    };
  }

  callbackAck(): { status: number; contentType: string; body: string } {
    return { status: 404, contentType: 'text/plain', body: 'not applicable' };
  }
}

/** Default TronChainClient backed by TronGrid's TRC20 transaction API. */
export class TronGridClient implements TronChainClient {
  constructor(
    private readonly cfg: UsdtConfig,
    private readonly http: HttpClient,
  ) {}

  async getIncomingTransfers(
    address: string,
    contract: string,
    sinceMs: number,
  ): Promise<Trc20Transfer[]> {
    const url =
      `${this.cfg.apiBase}/v1/accounts/${address}/transactions/trc20` +
      `?only_to=true&limit=100&contract_address=${contract}&min_timestamp=${sinceMs}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cfg.apiKey) headers['TRON-PRO-API-KEY'] = this.cfg.apiKey;

    const res = await this.http.request({ method: 'GET', url, headers });
    if (res.status !== 200) throw new ProviderError(`trongrid query failed (${res.status})`);

    const parsed = JSON.parse(res.body) as {
      data?: Array<{
        transaction_id: string;
        to: string;
        from: string;
        value: string;
        block_timestamp: number;
        // TronGrid returns confirmed transactions by default.
      }>;
    };
    return (parsed.data ?? []).map((t) => ({
      txId: t.transaction_id,
      to: t.to,
      from: t.from,
      valueMicro: Number(t.value),
      timestampMs: t.block_timestamp,
      confirmed: true,
    }));
  }
}
