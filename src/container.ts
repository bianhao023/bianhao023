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
  MemoryUserRepository,
} from './storage/memoryStore';
import {
  Locker,
  OrderRepository,
  ProcessedEventStore,
  RefundRepository,
  SubscriptionRepository,
  UserRepository,
} from './storage/repository';
import { PlanCatalog } from './services/plans';
import { SubscriptionService } from './services/subscriptionService';
import { PaymentService } from './services/paymentService';
import { RefundService } from './services/refundService';
import { ReportService } from './services/reportService';
import { ExpiryService } from './services/expiryService';
import { ExpiryWatcher } from './services/expiryWatcher';
import { UsdtWatcher } from './services/usdtWatcher';
import { UserService } from './services/userService';
import { ReconciliationService } from './services/reconciliationService';
import { AuditLog, InMemoryAuditLog } from './audit/auditLog';
import { WebhookDispatcher, MemoryWebhookRepository, OutboundEmitter } from './webhooks/outbound';
import { WebhookWatcher } from './webhooks/webhookWatcher';
import { Alert } from './alerting/alertFormatter';
import { ReadinessAggregator, HealthCheck } from './health/readiness';
import { sqlHealthCheck, redisHealthCheck, PingableRedis } from './health/dependencyChecks';
import { SqlClient } from './storage/sql/sqlStore';
import { logger } from './utils/logger';
import { PricingService } from './pricing/pricingService';
import { StaticExchangeRateProvider, DEMO_RATES_FROM_CNY, ExchangeRateProvider } from './pricing/exchangeRates';
import { CachingExchangeRateProvider, HttpRateFeed } from './pricing/cachingExchangeRates';
import { SecurityOptions } from './api/http';
import { LoggerNotifier, Notifier } from './notifications/notifier';
import { TemplatedEmailNotifier } from './notifications/emailNotifier';
import { SmtpMailSender } from './notifications/smtpMailSender';
import { Metrics } from './observability/metrics';
import { RouterMetrics, RateLimitOptions } from './api/http';
import { RateLimiter } from './api/rateLimiter';

/** Overrides used by tests to inject fakes / fixed clocks. */
export interface ContainerOverrides {
  httpClient?: HttpClient;
  chainClient?: TronChainClient;
  orders?: OrderRepository;
  refunds?: RefundRepository;
  subscriptions?: SubscriptionRepository;
  users?: UserRepository;
  processedEvents?: ProcessedEventStore;
  locker?: Locker;
  plans?: PlanCatalog;
  notifier?: Notifier;
  audit?: AuditLog;
  now?: () => number;
  /** Force-enable/replace providers regardless of config (test convenience). */
  providers?: Map<PaymentMethod, PaymentProvider>;
  /** SQL client to include as a critical `/readyz` ping (SQL-backed deploys). */
  readinessSql?: SqlClient;
  /** Redis client to include as a non-critical `/readyz` ping. */
  readinessRedis?: PingableRedis;
}

export interface Container {
  config: AppConfig;
  orders: OrderRepository;
  payments: PaymentService;
  refunds: RefundService;
  reports: ReportService;
  expiry: ExpiryService;
  expiryWatcher: ExpiryWatcher;
  users: UserService;
  reconciliation: ReconciliationService;
  audit: AuditLog;
  pricing: PricingService;
  /** Deep readiness checks for GET /readyz. */
  readiness: ReadinessAggregator;
  /** Dispatches an alert to the log and (when configured) the outbound webhook. */
  alertSink: (alert: Alert) => Promise<void>;
  /** Present only when a live FX feed is configured; call start()/stop() to refresh. */
  fxProvider?: CachingExchangeRateProvider;
  processedEvents: ProcessedEventStore;
  plans: PlanCatalog;
  metrics: Metrics;
  routerMetrics: RouterMetrics;
  rateLimit?: RateLimitOptions;
  security: SecurityOptions;
  usdtWatcher?: UsdtWatcher;
  webhooks?: WebhookDispatcher;
  webhookWatcher?: WebhookWatcher;
  enabledMethods: PaymentMethod[];
}

/** Wire the whole system together from configuration (and optional overrides). */
export function buildContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const http = overrides.httpClient ?? new FetchHttpClient();
  const now = overrides.now ?? Date.now;
  const orders = overrides.orders ?? new MemoryOrderRepository();
  const refundsRepo = overrides.refunds ?? new MemoryRefundRepository();
  const subscriptionsRepo = overrides.subscriptions ?? new MemorySubscriptionRepository();
  const processedEvents = overrides.processedEvents ?? new MemoryProcessedEventStore(now);
  const usersRepo = overrides.users ?? new MemoryUserRepository();
  const locker = overrides.locker ?? new InProcessLocker();
  const plans = overrides.plans ?? new PlanCatalog();
  const audit = overrides.audit ?? new InMemoryAuditLog(now);

  // Outbound merchant webhooks (optional). When configured, business events are
  // enqueued for signed, retried delivery.
  let webhooks: WebhookDispatcher | undefined;
  let webhookWatcher: WebhookWatcher | undefined;
  let outbound: OutboundEmitter | undefined;
  if (config.webhook) {
    webhooks = new WebhookDispatcher(new MemoryWebhookRepository(), http, config.webhook, now);
    webhookWatcher = new WebhookWatcher(webhooks);
    outbound = webhooks;
  }

  const users = new UserService(usersRepo, now, audit);
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
    audit,
    outbound,
    now,
  });

  const refunds = new RefundService({
    providers,
    orders,
    refunds: refundsRepo,
    processedEvents,
    locker,
    audit,
    outbound,
    now,
  });

  const reports = new ReportService(orders, refundsRepo);
  const reconciliation = new ReconciliationService(orders, refundsRepo, () => payments.expireStaleOrders(), now);
  // Pricing: use a live cached FX feed when configured, else the static demo table.
  const staticRates = new StaticExchangeRateProvider('CNY', DEMO_RATES_FROM_CNY);
  let fxProvider: CachingExchangeRateProvider | undefined;
  let ratesProvider: ExchangeRateProvider = staticRates;
  if (config.fx) {
    fxProvider = new CachingExchangeRateProvider(
      new HttpRateFeed(http, config.fx.url),
      config.fx.base,
      staticRates,
      { ttlMs: config.fx.ttlMs, now },
    );
    ratesProvider = fxProvider;
  }
  const pricing = new PricingService(ratesProvider);

  // Deep readiness checks. 'core' is critical (its failure => 503); the rest are
  // informational (a stale FX feed or a non-empty DLQ does not remove the node
  // from the load balancer — the service still serves requests).
  const readinessChecks: HealthCheck[] = [{ name: 'core', critical: true, run: () => ({ ok: true }) }];
  // Real dependency pings when a SQL/Redis client is injected (SQL-backed
  // deployments). SQL is critical (its outage ejects the node); Redis is not
  // (rate limiting degrades to the in-process limiter).
  if (overrides.readinessSql) {
    readinessChecks.push(sqlHealthCheck(overrides.readinessSql));
  }
  if (overrides.readinessRedis) {
    readinessChecks.push(redisHealthCheck(overrides.readinessRedis));
  }
  if (fxProvider) {
    readinessChecks.push({
      name: 'fx',
      run: () => ({ ok: true, detail: fxProvider!.isStale() ? 'stale (serving fallback)' : 'fresh' }),
    });
  }
  if (webhooks) {
    readinessChecks.push({
      name: 'webhooks',
      run: async () => ({ ok: true, detail: `dead=${(await webhooks!.deadLetterSummary()).count}` }),
    });
  }
  const readiness = new ReadinessAggregator(readinessChecks);

  // Alert dispatch: always log; also publish to the merchant webhook if wired.
  const alertSink = async (alert: Alert): Promise<void> => {
    const meta = { title: alert.title, summary: alert.summary, details: alert.details };
    if (alert.severity === 'critical') logger.error('alert', meta);
    else logger.warn('alert', meta);
    if (webhooks) {
      await webhooks.emit('reconciliation.alert', { ...alert });
    }
  };

  // With SMTP configured we can close the loop: expiry notifications become
  // localized emails addressed via the user directory. Otherwise just log.
  const notifier: Notifier =
    overrides.notifier ??
    (config.smtp
      ? new TemplatedEmailNotifier({
          sender: new SmtpMailSender(config.smtp),
          plans,
          users: users.contactLookup,
        })
      : new LoggerNotifier());
  const expiry = new ExpiryService({
    subscriptions: subscriptionsRepo,
    notifier,
    reminderWindowMs: config.expiryReminderDays * 24 * 60 * 60 * 1000,
    now,
  });
  // Periodic maintenance: sweep dedupe records past their retention window.
  const processedEventTtlMs = config.processedEventTtlDays * 24 * 60 * 60 * 1000;
  const expiryWatcher = new ExpiryWatcher(expiry, 3_600_000, () => processedEvents.sweep(processedEventTtlMs));

  if (providers.has('usdt')) {
    usdtWatcher = new UsdtWatcher(orders, payments);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  const metrics = new Metrics();
  const httpRequests = metrics.counter('vpn_http_requests_total', 'Total HTTP requests', ['method', 'route', 'code']);
  const httpDuration = metrics.histogram('vpn_http_request_duration_ms', 'HTTP request duration in milliseconds', ['route']);
  const rateLimitedCounter = metrics.counter('vpn_rate_limited_total', 'Requests rejected by the rate limiter', ['route']);
  const ordersGauge = metrics.gauge('vpn_orders', 'Current order count by status', ['status']);
  const refundsGauge = metrics.gauge('vpn_refunds', 'Current refund count by status', ['status']);
  const subsGauge = metrics.gauge('vpn_subscriptions_active', 'Currently active subscriptions');
  metrics.addCollector(async () => {
    const allOrders = await orders.all();
    ordersGauge.reset();
    const os: Record<string, number> = {};
    for (const o of allOrders) os[o.status] = (os[o.status] ?? 0) + 1;
    for (const [status, count] of Object.entries(os)) ordersGauge.set({ status }, count);

    const allRefunds = await refundsRepo.all();
    refundsGauge.reset();
    const rs: Record<string, number> = {};
    for (const r of allRefunds) rs[r.status] = (rs[r.status] ?? 0) + 1;
    for (const [status, count] of Object.entries(rs)) refundsGauge.set({ status }, count);

    subsGauge.set({}, (await subscriptionsRepo.listActive()).length);
  });
  const routerMetrics: RouterMetrics = { requests: httpRequests, duration: httpDuration, rateLimited: rateLimitedCounter };

  // ── Rate limiting ───────────────────────────────────────────────────────
  let rateLimit: RateLimitOptions | undefined;
  if (config.rateLimit.enabled) {
    rateLimit = {
      limiter: new RateLimiter(config.rateLimit.max, config.rateLimit.windowMs, now),
      skipRoutes: new Set(['/healthz', '/metrics']),
    };
  }

  const security: SecurityOptions = { ...config.security };

  const enabledMethods = [...providers.keys()];

  return {
    config, orders, payments, refunds, reports, expiry, expiryWatcher, users,
    reconciliation, audit, pricing, readiness, alertSink, fxProvider, processedEvents, plans,
    metrics, routerMetrics, rateLimit, security, usdtWatcher, webhooks, webhookWatcher, enabledMethods,
  };
}
