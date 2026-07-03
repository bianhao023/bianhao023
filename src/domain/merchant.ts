/**
 * Merchant (tenant) domain model for multi-tenant isolation.
 *
 * A merchant is an isolated tenant of the platform with:
 *   - its own API key (authentication / API-call isolation),
 *   - its own payment-provider credentials (key isolation) — resolved at runtime
 *     via the provider registry, keyed by merchant id, so a merchant signs and
 *     verifies with ITS OWN WeChat/Alipay/USDT keys,
 *   - its own USDT deposit-address namespace (`usdtHdPath`) so addresses never
 *     collide across tenants,
 *   - and data scoping: every {@link Order} carries a `merchantId`, and the
 *     merchant-facing API only ever sees/acts on its own orders.
 *
 * Single-tenant deployments transparently use the auto-provisioned
 * {@link DEFAULT_MERCHANT_ID} tenant, so nothing changes for them.
 */

/** The implicit tenant used by single-tenant deployments and legacy rows. */
export const DEFAULT_MERCHANT_ID = 'default';

export type MerchantStatus = 'active' | 'suspended';

export interface Merchant {
  id: string;
  name: string;
  status: MerchantStatus;
  /** Opaque API key the merchant presents to authenticate its API calls. */
  apiKey: string;
  /** Previous API key, still accepted during rotation (grace window). */
  apiKeyPrevious?: string;
  /**
   * BIP44 account path prefix isolating this merchant's USDT deposit-address
   * space (per-order address = `${usdtHdPath}/${index}`). Distinct per merchant
   * so address spaces never overlap. Absent → the platform default path.
   */
  usdtHdPath?: string;
  createdAt: number;
  updatedAt: number;
}

/** Public projection of a merchant (never exposes the API key to other tenants). */
export interface PublicMerchant {
  id: string;
  name: string;
  status: MerchantStatus;
  usdtHdPath?: string;
  createdAt: number;
  updatedAt: number;
}

export function toPublicMerchant(m: Merchant): PublicMerchant {
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    usdtHdPath: m.usdtHdPath,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}
