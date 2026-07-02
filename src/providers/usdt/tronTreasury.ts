/**
 * The TRON "treasury" seam: everything the per-order deposit + sweep pipeline
 * needs from the chain and from key custody, expressed as narrow interfaces.
 *
 * WHY interfaces (and no bundled implementation): correctly deriving TRON
 * addresses (secp256k1 + keccak256) and signing/broadcasting TRC20 transactions
 * is cryptographic, high-stakes code that must not be hand-rolled with zero
 * dependencies — Node's `crypto` does not even expose keccak256. The real
 * implementation lives in an optional-dependency adapter backed by `tronweb`
 * (loaded lazily, like the `pg`/`redis` adapters); a deterministic fake is used
 * for tests and local end-to-end simulation. Callers depend only on these
 * interfaces, so the crypto backend is swappable with no call-site changes.
 */

/** A deposit address derived at a specific HD index. */
export interface DerivedAddress {
  index: number;
  /** Base58 TRON address (`T…`). */
  address: string;
}

/**
 * Deterministically derives per-order deposit addresses from a treasury HD
 * wallet. The same index MUST always yield the same address, because the sweep
 * pipeline re-derives the address/keys from the stored index to move funds.
 */
export interface TronWallet {
  /** Derive the deposit address for the given HD index. */
  deriveDepositAddress(index: number): Promise<DerivedAddress>;
}

/**
 * On-chain operations required to sweep a deposit into the collection wallet.
 *
 * A freshly-funded deposit address holds USDT but no TRX, so it cannot pay the
 * energy/bandwidth for its own TRC20 transfer. The pipeline therefore first
 * fuels it with a little TRX from a fee wallet ({@link fuelGas}), then sweeps
 * the USDT out ({@link sweepTrc20}). Transfers are asynchronous on-chain, so the
 * pipeline polls {@link isConfirmed} between steps.
 */
export interface TronTreasury {
  /** Current TRC20 (USDT) balance at `address`, in micro-USDT. */
  trc20BalanceMicro(address: string): Promise<number>;
  /** Current TRX balance at `address`, in sun (1 TRX = 1e6 sun). */
  trxBalanceSun(address: string): Promise<number>;
  /**
   * Fund `toAddress` with `amountSun` of TRX from the fee wallet, so it can pay
   * for its own outbound TRC20 transfer. Returns the transaction id.
   */
  fuelGas(toAddress: string, amountSun: number): Promise<string>;
  /**
   * Transfer `amountMicro` USDT from the deposit address (identified by its HD
   * `depositIndex`, so the adapter can re-derive the signing key) to
   * `toAddress`. Returns the transaction id.
   */
  sweepTrc20(
    depositIndex: number,
    fromAddress: string,
    toAddress: string,
    amountMicro: number,
  ): Promise<string>;
  /** Whether `txId` has reached the required confirmations. */
  isConfirmed(txId: string): Promise<boolean>;
}
