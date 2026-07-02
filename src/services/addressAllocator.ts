import { DepositAddress } from '../domain/deposit';
import { DepositAddressRepository } from '../storage/repository';
import { TronWallet } from '../providers/usdt/tronTreasury';

/**
 * Allocates a unique, deterministic TRON deposit address per order (per-order
 * USDT mode). The repository hands out a monotonic raw index; we offset it by
 * `hdStartIndex` (to avoid colliding with other uses of the same seed) and
 * derive the address at that HD index. Allocation is idempotent per order, so a
 * retried order creation reuses the same address rather than burning indices.
 */
export class AddressAllocator {
  constructor(
    private readonly wallet: TronWallet,
    private readonly repo: DepositAddressRepository,
    private readonly hdStartIndex = 0,
    private readonly now: () => number = Date.now,
  ) {}

  /** Return the order's deposit address, deriving and persisting one if needed. */
  async allocate(orderId: string): Promise<DepositAddress> {
    const existing = await this.repo.findByOrderId(orderId);
    if (existing) return existing;

    const raw = await this.repo.nextIndex();
    const index = this.hdStartIndex + raw;
    const { address } = await this.wallet.deriveDepositAddress(index);
    return this.repo.save({ index, address, orderId, createdAt: this.now() });
  }
}
