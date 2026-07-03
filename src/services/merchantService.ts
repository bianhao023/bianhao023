import { randomBytes } from 'node:crypto';
import { Merchant, MerchantStatus, DEFAULT_MERCHANT_ID } from '../domain/merchant';
import { MerchantRepository } from '../storage/repository';
import { NotFoundError } from '../domain/errors';
import { AuditLog } from '../audit/auditLog';
import { uuid } from '../utils/ids';

function newMerchantApiKey(): string {
  return `mk_${randomBytes(24).toString('hex')}`;
}

export interface CreateMerchantInput {
  name: string;
  /** Optional explicit id (else generated). */
  id?: string;
  /** BIP44 account path prefix isolating this merchant's USDT address space. */
  usdtHdPath?: string;
}

/**
 * Manages merchants/tenants: provisioning, API-key authentication (with a
 * rotation grace window), key rotation and suspension. A `default` merchant is
 * auto-provisioned so single-tenant deployments need no configuration.
 */
export class MerchantService {
  constructor(
    private readonly repo: MerchantRepository,
    private readonly now: () => number = Date.now,
    private readonly audit?: AuditLog,
  ) {}

  /** Ensure the implicit default tenant exists; return it. Idempotent. */
  async ensureDefault(): Promise<Merchant> {
    const existing = await this.repo.findById(DEFAULT_MERCHANT_ID);
    if (existing) return existing;
    const now = this.now();
    return this.repo.create({
      id: DEFAULT_MERCHANT_ID,
      name: 'Default',
      status: 'active',
      apiKey: newMerchantApiKey(),
      createdAt: now,
      updatedAt: now,
    });
  }

  async create(input: CreateMerchantInput): Promise<Merchant> {
    const now = this.now();
    const merchant: Merchant = {
      id: input.id ?? uuid(),
      name: input.name,
      status: 'active',
      apiKey: newMerchantApiKey(),
      usdtHdPath: input.usdtHdPath,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.repo.create(merchant);
    await this.audit?.record({ action: 'merchant.created', subjectId: created.id, metadata: { name: created.name } });
    return created;
  }

  findById(id: string): Promise<Merchant | undefined> {
    return this.repo.findById(id);
  }

  list(): Promise<Merchant[]> {
    return this.repo.list();
  }

  /**
   * Resolve the ACTIVE merchant for an API key (current or previous key). A
   * suspended merchant does not authenticate. Returns undefined on no match.
   */
  async authenticate(apiKey: string): Promise<Merchant | undefined> {
    if (!apiKey) return undefined;
    const merchant = await this.repo.findByApiKey(apiKey);
    if (!merchant || merchant.status !== 'active') return undefined;
    return merchant;
  }

  /** Rotate the API key, keeping the old one valid during the grace window. */
  async rotateKey(id: string): Promise<Merchant> {
    const merchant = await this.repo.findById(id);
    if (!merchant) throw new NotFoundError(`merchant not found: ${id}`);
    const updated: Merchant = {
      ...merchant,
      apiKeyPrevious: merchant.apiKey,
      apiKey: newMerchantApiKey(),
      updatedAt: this.now(),
    };
    const saved = await this.repo.update(updated);
    await this.audit?.record({ action: 'merchant.key_rotated', subjectId: id });
    return saved;
  }

  async setStatus(id: string, status: MerchantStatus): Promise<Merchant> {
    const merchant = await this.repo.findById(id);
    if (!merchant) throw new NotFoundError(`merchant not found: ${id}`);
    const saved = await this.repo.update({ ...merchant, status, updatedAt: this.now() });
    await this.audit?.record({ action: 'merchant.status_changed', subjectId: id, metadata: { status } });
    return saved;
  }
}
