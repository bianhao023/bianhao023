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

/** USDT (TRC20) provider using shared-address + unique-amount reconciliation. */
export class UsdtTronProvider implements PaymentProvider {
  readonly method = 'usdt' as const;

  constructor(
    private readonly cfg: UsdtConfig,
    private readonly chain: TronChainClient,
  ) {}

  async createPayment(order: Order): Promise<CreatePaymentResult> {
    return {
      method: this.method,
      payTarget: this.cfg.receivingAddress,
      renderAs: 'address',
      extra: {
        network: 'TRON (TRC20)',
        contract: this.cfg.contractAddress,
        // The EXACT amount the user must send for automatic matching.
        amount: fromMinorUnits(order.amount, 'USDT'),
        currency: 'USDT',
        note: 'Send the exact amount shown so we can confirm your payment automatically.',
      },
    };
  }

  // USDT has no signed push callback; settlement is detected by reconciliation.
  async verifyCallback(_cb: RawCallback): Promise<CallbackResult> {
    throw new ProviderError('USDT settlement is detected on-chain, not via callbacks');
  }

  async queryPayment(order: Order): Promise<QueryResult> {
    const transfers = await this.chain.getIncomingTransfers(
      this.cfg.receivingAddress,
      this.cfg.contractAddress,
      order.createdAt - 5 * 60_000,
    );
    const match = matchTransfer(order, transfers, this.cfg.receivingAddress, new Set());
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
