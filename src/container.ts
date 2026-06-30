import { AppConfig } from './config';
import { PaymentMethod } from './domain/types';
import { HttpClient, FetchHttpClient, PaymentProvider } from './providers/provider';
import { WechatPayProvider } from './providers/wechat/wechatPay';
import { AlipayProvider } from './providers/alipay/alipay';
import { TronChainClient, TronGridClient, UsdtTronProvider } from './providers/usdt/usdtTron';
import {
  InProcessLocker,
  MemoryOrderRepository,
  MemoryProcessedEventStore,
  MemoryRefundRepository,
  MemorySubscriptionRepository,
} from './storage/memoryStore';
import {
  Locker,
  OrderRepository,
  ProcessedEventStore,
  RefundRepository,
  SubscriptionRepository,
} from './storage/repository';
import { PlanCatalog } from './services/plans';
import { SubscriptionService } from './services/subscriptionService';
import { PaymentService } from './services/paymentService';
import { RefundService } from './services/refundService';
import { UsdtWatcher } from './services/usdtWatcher';

/** Overrides used by tests to inject fakes / fixed clocks. */
export interface ContainerOverrides {
  httpClient?: HttpClient;
  chainClient?: TronChainClient;
  orders?: OrderRepository;
  refunds?: RefundRepository;
  subscriptions?: SubscriptionRepository;
  processedEvents?: ProcessedEventStore;
  locker?: Locker;
  plans?: PlanCatalog;
  now?: () => number;
  /** Force-enable/replace providers regardless of config (test convenience). */
  providers?: Map<PaymentMethod, PaymentProvider>;
}

export interface Container {
  config: AppConfig;
  orders: OrderRepository;
  payments: PaymentService;
  refunds: RefundService;
  plans: PlanCatalog;
  usdtWatcher?: UsdtWatcher;
  enabledMethods: PaymentMethod[];
}

/** Wire the whole system together from configuration (and optional overrides). */
export function buildContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const http = overrides.httpClient ?? new FetchHttpClient();
  const orders = overrides.orders ?? new MemoryOrderRepository();
  const refundsRepo = overrides.refunds ?? new MemoryRefundRepository();
  const subscriptionsRepo = overrides.subscriptions ?? new MemorySubscriptionRepository();
  const processedEvents = overrides.processedEvents ?? new MemoryProcessedEventStore();
  const locker = overrides.locker ?? new InProcessLocker();
  const plans = overrides.plans ?? new PlanCatalog();
  const now = overrides.now ?? Date.now;

  const subscriptions = new SubscriptionService(subscriptionsRepo, plans, now);

  const providers = overrides.providers ?? new Map<PaymentMethod, PaymentProvider>();
  let usdtWatcher: UsdtWatcher | undefined;

  if (!overrides.providers) {
    if (config.wechat) {
      providers.set('wechat', new WechatPayProvider(config.wechat, http, now));
    }
    if (config.alipay) {
      providers.set('alipay', new AlipayProvider(config.alipay, http));
    }
    if (config.usdt) {
      const chain = overrides.chainClient ?? new TronGridClient(config.usdt, http);
      providers.set('usdt', new UsdtTronProvider(config.usdt, chain));
    }
  }

  const payments = new PaymentService({
    providers,
    orders,
    processedEvents,
    locker,
    subscriptions,
    plans,
    orderTtlMinutes: config.orderTtlMinutes,
    usdtUniqueDeltaMax: config.usdt?.uniqueAmountMaxDelta ?? 9999,
    now,
  });

  const refunds = new RefundService({
    providers,
    orders,
    refunds: refundsRepo,
    processedEvents,
    locker,
    now,
  });

  if (providers.has('usdt')) {
    usdtWatcher = new UsdtWatcher(orders, payments);
  }

  const enabledMethods = [...providers.keys()];

  return { config, orders, payments, refunds, plans, usdtWatcher, enabledMethods };
}
