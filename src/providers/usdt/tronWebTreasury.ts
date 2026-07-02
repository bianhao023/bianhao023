/**
 * REAL (production) implementation of the TRON treasury seam, backed by the
 * `tronweb` library.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY / SCOPE NOTE
 * This adapter is the ONLY part of the per-order deposit + sweep feature that
 * touches real key material and the live chain. It is loaded lazily and ONLY in
 * `per-order` USDT mode (the default shared-address flow and all tests use the
 * deterministic fake and never import this file). Both {@link
 * TronWebTreasuryConfig.mnemonic} and {@link TronWebTreasuryConfig.feePrivateKey}
 * are HOT-WALLET SECRETS: they can move funds and MUST come from a secret
 * manager (never a checked-in file / plain env in production). Config is
 * INJECTED — this module never reads `process.env` itself.
 *
 * `tronweb` is an optionalDependency and is `require`d lazily here (exactly like
 * `src/storage/sql/pgClient.ts` lazy-requires `pg`), so the zero-runtime-deps
 * core and the test suite never need it installed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Operator wiring — env → {@link TronWebTreasuryConfig} (done by the composition
 * root, NOT here):
 *
 *   fullHost        ← USDT_TRON_FULL_HOST      (e.g. https://api.trongrid.io)
 *   apiKey          ← USDT_TRONGRID_API_KEY    (optional; TRON-PRO-API-KEY)
 *   mnemonic        ← USDT_HD_MNEMONIC         🔒 secret manager
 *   hdPath          ← USDT_HD_PATH             (optional; default below)
 *   feePrivateKeys  ← USDT_FEE_PRIVATE_KEYS    🔒 secret manager (1..N, comma-sep;
 *                     falls back to the single USDT_FEE_PRIVATE_KEY)
 *   contractAddress ← USDT_CONTRACT_ADDRESS    (USDT TRC20 contract)
 *   minConfirmations← USDT_MIN_CONFIRMATIONS
 *
 * (The collection/sweep destination — e.g. USDT_COLLECTION_ADDRESS — is passed
 * per-call to {@link TronWebTreasury.sweepTrc20} by the pipeline, not stored
 * here.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DerivedAddress, TronTreasury, TronWallet } from './tronTreasury';
import { RoundRobin } from './roundRobin';
import { logger } from '../../utils/logger';

/** Default base BIP44 path prefix for TRON (coin type 195). */
const DEFAULT_HD_PATH = "m/44'/195'/0'/0";

/**
 * Injected configuration for {@link TronWebTreasury}. See the file header for the
 * env → config mapping an operator wires at the composition root.
 */
export interface TronWebTreasuryConfig {
  /** TronGrid / full-node URL, e.g. `https://api.trongrid.io`. */
  fullHost: string;
  /** Optional TronGrid API key, sent as the `TRON-PRO-API-KEY` header. */
  apiKey?: string;
  /**
   * 🔒 HD wallet mnemonic. Used both to derive per-order deposit addresses AND
   * to re-derive their private keys when sweeping. Hot-wallet secret.
   */
  mnemonic: string;
  /**
   * Base BIP44 path prefix; the per-index deposit address uses
   * `${hdPath}/${index}`. Defaults to {@link DEFAULT_HD_PATH}.
   */
  hdPath?: string;
  /**
   * 🔒 Private keys of the fee wallet POOL that funds gas (TRX). Provide one or
   * more; sweeps draw a fee wallet in round-robin to spread rate limits, tx
   * contention and hot-wallet balance/risk across a fixed, known set of
   * addresses. Must be non-empty. Hot-wallet secrets.
   */
  feePrivateKeys: string[];
  /** USDT TRC20 contract address (base58). */
  contractAddress: string;
  /** Confirmations required before a sweep/fuel tx is considered final. */
  minConfirmations: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal local typings for the slice of the `tronweb` surface we touch.
//
// The real `tronweb` package ships no bundled @types and is not installed in
// this repo, so we DO NOT `import` it (which would make tsc try to resolve the
// module). Instead we `require` it at the boundary (typed `any` there) and cast
// to these hand-written interfaces so the rest of the file stays type-checked.
// Casts are localized to the constructor; every interface below mirrors tronweb
// v5's documented shapes.
// ─────────────────────────────────────────────────────────────────────────────

/** A prepared contract method call (`.balanceOf(x)` / `.transfer(x, y)`). */
interface TronContractMethod {
  /** Read-only call; returns the raw contract value (often a BigNumber-like). */
  call(): Promise<unknown>;
  /** Sign + broadcast; resolves to the transaction id. */
  send(): Promise<string>;
}

/** The USDT TRC20 contract instance, as returned by `contract().at(addr)`. */
interface TronContract {
  balanceOf(address: string): TronContractMethod;
  transfer(toAddress: string, amountMicro: number): TronContractMethod;
}

/** Factory returned by `tronWeb.contract()`. */
interface TronContractFactory {
  at(contractAddress: string): Promise<TronContract>;
}

/** Result shape of `trx.sendTransaction` (varies across tronweb versions). */
interface TronSendResult {
  txid?: string;
  result?: boolean;
  transaction?: { txID?: string };
}

/** `trx.getTransactionInfo` result — we only rely on `blockNumber`. */
interface TronTransactionInfo {
  blockNumber?: number;
  [key: string]: unknown;
}

/** `trx.getConfirmedTransaction` result — we only rely on `ret[].contractRet`. */
interface TronConfirmedTransaction {
  ret?: Array<{ contractRet?: string }>;
  [key: string]: unknown;
}

/** `trx.getCurrentBlock` result — we only rely on the head block number. */
interface TronBlock {
  block_header?: { raw_data?: { number?: number } };
}

/** The `tronWeb.trx` namespace slice we use. */
interface TronTrxNamespace {
  getBalance(address: string): Promise<number | string>;
  sendTransaction(toAddress: string, amountSun: number): Promise<TronSendResult>;
  getTransactionInfo(txId: string): Promise<TronTransactionInfo>;
  getConfirmedTransaction(txId: string): Promise<TronConfirmedTransaction>;
  getCurrentBlock(): Promise<TronBlock>;
}

/** The `tronWeb.address` utility slice we use. */
interface TronAddressUtil {
  /** Convert a `41…` hex address to its base58 `T…` form. */
  fromHex(hex: string): string;
  /** Derive the base58 `T…` address that owns `privateKey`. */
  fromPrivateKey(privateKey: string): string;
}

/** A live TronWeb instance (the bits this adapter calls). */
interface TronWebLike {
  trx: TronTrxNamespace;
  address: TronAddressUtil;
  contract(): TronContractFactory;
  setPrivateKey(privateKey: string): void;
}

/** Options accepted by the TronWeb constructor. */
interface TronWebOptions {
  fullHost: string;
  headers?: Record<string, string>;
  privateKey?: string;
}

/** Account object returned by the static `TronWeb.fromMnemonic`. */
interface TronMnemonicAccount {
  /** base58 `T…` in tronweb v5 (may be `41…` hex on some builds — see helper). */
  address: string;
  /** Hex private key (may carry a `0x` prefix depending on build). */
  privateKey: string;
  publicKey?: string;
}

/** The TronWeb class value: constructable + static `fromMnemonic` factory. */
interface TronWebConstructor {
  new (options: TronWebOptions): TronWebLike;
  /**
   * Derive an account from a BIP39 mnemonic at `path` (tronweb v5 static).
   * Returns `{ address, privateKey, publicKey }`.
   */
  fromMnemonic(mnemonic: string, path?: string): TronMnemonicAccount;
}

/**
 * Production TRON treasury adapter. Implements both {@link TronWallet}
 * (deterministic per-order address derivation) and {@link TronTreasury}
 * (balances, gas funding, sweeping, confirmation checks) on top of `tronweb`.
 */
export class TronWebTreasury implements TronWallet, TronTreasury {
  /** The lazily-required TronWeb class (module boundary; see constructor). */
  private readonly TronWeb: TronWebConstructor;
  /** Read-only / default instance (the first fee wallet). */
  private readonly base: TronWebLike;
  /** Fee-wallet pool: one signing instance per key, drawn round-robin for gas. */
  private readonly feePool: RoundRobin<TronWebLike>;
  /** Effective base HD path prefix (`cfg.hdPath` or the TRON default). */
  private readonly hdPath: string;
  /** Cached base58 addresses of the fee wallets (derived lazily from the keys). */
  private feeAddresses?: string[];

  constructor(private readonly cfg: TronWebTreasuryConfig) {
    if (cfg.feePrivateKeys.length === 0) {
      throw new Error('TronWebTreasury: at least one fee private key is required');
    }
    // Lazy load: no hard dependency on `tronweb` for the shared-address flow/tests.
    let TronWebCtor: TronWebConstructor;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const required = require('tronweb') as {
        TronWeb?: TronWebConstructor;
        default?: TronWebConstructor;
      };
      // v5 exports the class as the module itself; v6/ESM interop expose it under
      // `.TronWeb` / `.default`. Accept whichever is present. Cast is confined here.
      TronWebCtor =
        required.TronWeb ??
        required.default ??
        (required as unknown as TronWebConstructor);
    } catch {
      throw new Error(
        "USDT per-order mode requires the 'tronweb' package. Run `npm install tronweb`.",
      );
    }

    this.TronWeb = TronWebCtor;
    this.hdPath = cfg.hdPath ?? DEFAULT_HD_PATH;
    // One signing instance per fee wallet; gas funding rotates over the pool.
    const feeInstances = cfg.feePrivateKeys.map((key) => new TronWebCtor(this.instanceOptions(key)));
    this.feePool = new RoundRobin<TronWebLike>(feeInstances);
    this.base = feeInstances[0];
  }

  // ── TronWallet ────────────────────────────────────────────────────────────

  /**
   * Derive the deposit address at `${hdPath}/${index}` from the mnemonic. The
   * mapping index → address is deterministic, so the sweep pipeline can later
   * re-derive the signing key from the stored index.
   */
  async deriveDepositAddress(index: number): Promise<DerivedAddress> {
    const account = this.deriveAccount(index);
    return { index, address: this.toBase58(account.address) };
  }

  // ── TronTreasury ────────────────────────────────────────────────────────────

  /** USDT balance at `address` in micro-USDT (contract stores 6-decimal micros). */
  async trc20BalanceMicro(address: string): Promise<number> {
    const contract = await this.base.contract().at(this.cfg.contractAddress);
    const raw = await contract.balanceOf(address).call();
    // Raw contract value is already in micro units; normalise BigNumber-like → number.
    return Number(this.toDecimalString(raw));
  }

  /** TRX balance at `address` in sun (1 TRX = 1e6 sun). */
  async trxBalanceSun(address: string): Promise<number> {
    const sun = await this.base.trx.getBalance(address);
    return Number(sun);
  }

  /**
   * Total TRX across the whole fee-wallet pool in sun, for balance monitoring/
   * alerts. (With N wallets drained round-robin, set the low-balance threshold
   * to ≈N× the desired per-wallet runway.)
   */
  async feeBalanceSun(): Promise<number> {
    this.feeAddresses ??= this.cfg.feePrivateKeys.map((key) => this.base.address.fromPrivateKey(key));
    const balances = await Promise.all(this.feeAddresses.map((addr) => this.trxBalanceSun(addr)));
    return balances.reduce((sum, b) => sum + b, 0);
  }

  /**
   * Fund `toAddress` with `amountSun` TRX from the NEXT fee wallet in the pool
   * (round-robin), so gas funding is spread across the fixed set of fee
   * addresses rather than hammering one. Returns the txid.
   */
  async fuelGas(toAddress: string, amountSun: number): Promise<string> {
    const feeWallet = this.feePool.next();
    const res = await feeWallet.trx.sendTransaction(toAddress, amountSun);
    const txId = res.txid ?? res.transaction?.txID;
    if (!txId) {
      throw new Error('fuelGas: tronweb sendTransaction returned no transaction id');
    }
    logger.info('fuelled deposit address with gas', { toAddress, amountSun, txId, feeWallets: this.feePool.size });
    return txId;
  }

  /**
   * Sweep `amountMicro` USDT out of the deposit address (re-derived from
   * `depositIndex`) into `toAddress`. A fresh signing instance is built with the
   * deposit key so the deposit address itself authorises the transfer.
   */
  async sweepTrc20(
    depositIndex: number,
    fromAddress: string,
    toAddress: string,
    amountMicro: number,
  ): Promise<string> {
    logger.info('sweeping TRC20 deposit', {
      depositIndex,
      fromAddress,
      toAddress,
      amountMicro,
    });
    const privateKey = this.privateKeyForIndex(depositIndex);
    const signer = new this.TronWeb(this.instanceOptions(privateKey));
    const contract = await signer.contract().at(this.cfg.contractAddress);
    // `.send()` signs with the instance's key and resolves to the txid string.
    const txId = await contract.transfer(toAddress, amountMicro).send();
    return txId;
  }

  /**
   * Whether `txId` has reached {@link TronWebTreasuryConfig.minConfirmations}.
   *
   * Confirmation semantics can be tuned per deployment; this is a robust default:
   * prefer (head block − tx block) ≥ minConfirmations; fall back to the
   * confirmed-transaction lookup (`contractRet === 'SUCCESS'`) when a head/block
   * number is unavailable. NEVER throws — any error/absence yields `false`.
   */
  async isConfirmed(txId: string): Promise<boolean> {
    try {
      const info = await this.base.trx.getTransactionInfo(txId);
      const blockNumber = typeof info.blockNumber === 'number' ? info.blockNumber : undefined;

      if (blockNumber === undefined) {
        // Not yet mined per getTransactionInfo — cross-check the confirmed lookup.
        const confirmed = await this.base.trx.getConfirmedTransaction(txId);
        return confirmed.ret?.[0]?.contractRet === 'SUCCESS';
      }

      const head = (await this.base.trx.getCurrentBlock()).block_header?.raw_data?.number;
      if (typeof head === 'number') {
        return head - blockNumber >= this.cfg.minConfirmations;
      }
      // Mined (have a block number) but head unreadable: honour a ≤1 threshold.
      return this.cfg.minConfirmations <= 1;
    } catch (err) {
      logger.warn('isConfirmed check failed; treating as unconfirmed', {
        txId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Build TronWeb constructor options, attaching the API-key header when set. */
  private instanceOptions(privateKey: string): TronWebOptions {
    const options: TronWebOptions = { fullHost: this.cfg.fullHost, privateKey };
    if (this.cfg.apiKey) {
      options.headers = { 'TRON-PRO-API-KEY': this.cfg.apiKey };
    }
    return options;
  }

  /** Derive the HD account at `${hdPath}/${index}` via TronWeb's static factory. */
  private deriveAccount(index: number): TronMnemonicAccount {
    const path = `${this.hdPath}/${index}`;
    // tronweb v5: `TronWeb.fromMnemonic(mnemonic, path)` → { address, privateKey, ... }
    return this.TronWeb.fromMnemonic(this.cfg.mnemonic, path);
  }

  /** Re-derive the private key for a deposit index (used to sign its sweep). */
  private privateKeyForIndex(index: number): string {
    return this.deriveAccount(index).privateKey;
  }

  /**
   * Normalise a derived address to base58 `T…`. tronweb v5's `fromMnemonic`
   * already returns base58; if a `41…` hex form slips through (older builds), we
   * convert via `tronWeb.address.fromHex`. Assumption: any non-`T…` value is hex.
   */
  private toBase58(address: string): string {
    return address.startsWith('T') ? address : this.base.address.fromHex(address);
  }

  /**
   * Stringify a raw contract return value that may be a `number`, `string`, or a
   * BigNumber-like object exposing `.toString()`, so `Number(...)` is safe.
   */
  private toDecimalString(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'bigint') return raw.toString();
    if (raw != null && typeof (raw as { toString?: unknown }).toString === 'function') {
      return (raw as { toString(): string }).toString();
    }
    return '0';
  }
}
