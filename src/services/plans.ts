import { Plan } from '../domain/types';

/**
 * Static VPN plan catalogue. In production this would live in a database; the
 * interface (getPlan/listPlans) stays the same.
 */
const PLANS: Plan[] = [
  {
    id: 'monthly',
    name: 'Monthly',
    durationDays: 30,
    trafficGb: 200,
    deviceLimit: 3,
    priceCnyFen: 1500, // ¥15.00
    priceUsdtMicro: 2_000_000, // 2.000000 USDT
    enabled: true,
  },
  {
    id: 'quarterly',
    name: 'Quarterly',
    durationDays: 90,
    trafficGb: 700,
    deviceLimit: 4,
    priceCnyFen: 3900, // ¥39.00
    priceUsdtMicro: 5_500_000, // 5.500000 USDT
    enabled: true,
  },
  {
    id: 'yearly',
    name: 'Yearly',
    durationDays: 365,
    trafficGb: 0, // unlimited
    deviceLimit: 5,
    priceCnyFen: 12800, // ¥128.00
    priceUsdtMicro: 18_000_000, // 18.000000 USDT
    enabled: true,
  },
];

export class PlanCatalog {
  constructor(private readonly plans: Plan[] = PLANS) {}

  listPlans(): Plan[] {
    return this.plans.filter((p) => p.enabled).map((p) => ({ ...p }));
  }

  getPlan(id: string): Plan | undefined {
    const p = this.plans.find((x) => x.id === id && x.enabled);
    return p ? { ...p } : undefined;
  }
}
