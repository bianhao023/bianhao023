# VPN Payment Backend

A commercial-grade payment backend for a VPN service, supporting **WeChat Pay**,
**Alipay**, and **USDT (TRC20)**. Written in TypeScript with **zero runtime
dependencies** (only Node.js ≥ 20 built-ins: `crypto`, `http`, `fetch`), which
keeps it auditable, easy to deploy, and free of payment-SDK supply-chain risk.

> Status: builds clean (`tsc`, strict mode) and passes **218 automated tests**
> covering signing, callbacks, the order state machine, idempotency & dedupe
> retention, concurrency, amount validation, USDT reconciliation, refunds
> (full/partial/manual and asynchronous PROCESSING→final settlement), subscription
> expiry & notifications, accounts (register/login/API-key auth), multi-currency
> pricing (static + cached live feed), admin reporting, CSV export,
> financial-consistency reconciliation, an audit log (in-memory + SQL), outbound
> webhooks with retry/dead-letter, an OpenAPI spec, Prometheus metrics, in-process
> & Redis rate limiting, HTTP hardening (CORS/security headers/timeout/body caps),
> SMTP email delivery, localized billing emails, monitoring artifacts, the SQL row
> mappers, a full end-to-end journey test, and the HTTP API end-to-end.

## Why one coherent codebase

This project was scoped as "8 assistants collaborating". Rather than producing 8
disconnected pieces that wouldn't integrate, the work is organised into the **8
functional roles** a payment team would own, all sharing one set of interfaces:

| # | Role | Where it lives |
|---|------|----------------|
| 1 | Architecture & domain model | `src/domain`, `src/core` |
| 2 | WeChat Pay integration | `src/providers/wechat` |
| 3 | Alipay integration | `src/providers/alipay` |
| 4 | USDT (TRC20) integration | `src/providers/usdt` |
| 5 | Orders, state machine & fulfilment | `src/services`, `src/core/orderStateMachine.ts` |
| 6 | HTTP API & webhooks | `src/api` |
| 7 | Security (signing, replay, idempotency) | `src/utils/crypto.ts`, `src/storage` |
| 8 | QA / automated testing | `test/` |

## Architecture

```
HTTP (node:http) ──► Router ──► PaymentService ──► PaymentProvider (wechat/alipay/usdt)
                                      │
                                      ├─► OrderRepository      (state machine, idempotency)
                                      ├─► ProcessedEventStore  (replay/dedupe)
                                      ├─► Locker               (per-order serialisation)
                                      └─► SubscriptionService  (grants VPN access)
```

Every payment method implements the same `PaymentProvider` interface, and **both**
webhook settlement (WeChat/Alipay) and polling settlement (USDT) flow through the
single `PaymentService.applyPayment` path, so behaviour is identical and
consistent regardless of method.

### Money handling

All amounts are integer **minor units** to avoid floating-point errors:
- CNY → *fen* (1 CNY = 100)
- USDT → *micro* (1 USDT = 1,000,000, matching TRC20's 6 decimals)

### Reliability & security properties

- **Signature verification** is mandatory for every WeChat (SHA256-RSA + AES-GCM
  notification decryption) and Alipay (RSA2) callback; bad signatures are rejected.
- **Replay defence**: WeChat notification timestamps outside ±5 min are rejected;
  every callback/transaction is deduplicated via `ProcessedEventStore`.
- **Idempotency**: order creation is idempotent by `Idempotency-Key`; duplicate
  and concurrent callbacks fulfil an order **exactly once** (per-order lock +
  state machine).
- **Amount/currency validation**: underpayment and currency mismatches are
  rejected before any access is granted; overpayment is accepted and logged.
- **Order expiry**: pending orders auto-expire; a late callback cannot revive them.
- **USDT matching**: deposits to a shared address are matched to orders by a
  unique exact amount, with confirmation and time-window checks.

## Getting started

```bash
npm install          # dev dependencies only (typescript, @types/node)
cp .env.example .env # fill in your provider credentials
npm run build        # compile to dist/
npm start            # start the server
npm test             # build + run the full test suite
```

A method is enabled only when its environment variables are present, so you can
run with any subset of WeChat / Alipay / USDT configured.

## HTTP API

| Method & path | Description |
|---|---|
| `GET /healthz` | Liveness + enabled methods |
| `GET /version` | App/API version + supported API versions |
| `GET /openapi.json` | OpenAPI 3.0.3 specification |
| `GET /docs` | Swagger UI (interactive API docs) |
| `GET /api/plans` | List VPN plans with prices |
| `GET /api/pricing/quote` | Convert a minor-unit amount between currencies (`amount`,`from`,`to`) |
| `POST /api/users/register` | Create an account. Body: `{ email, password, locale?, name? }` |
| `POST /api/users/login` | Authenticate; returns the account's API key |
| `GET /api/users/me` | Current account (auth: `Authorization: Bearer <apiKey>`) |
| `POST /api/users/me/rotate-key` | Rotate the API key (invalidates the old one) 🔑 |
| `POST /api/orders` | Create an order. Body: `{ userId, planId, method }`; optional `Idempotency-Key` header |
| `GET /api/orders/:id` | Order status + pay info |
| `POST /api/orders/:id/sync` | Force a status re-check (used while waiting on USDT) |
| `POST /api/orders/:id/refund` | Refund an order (full or partial). Body: `{ amount?, reason?, outRefundNo? }` |
| `GET /api/orders/:id/refunds` | List refunds issued against an order |
| `POST /api/notify/wechat` | WeChat Pay v3 payment notification webhook |
| `POST /api/notify/wechat/refund` | WeChat Pay v3 async refund-result webhook |
| `POST /api/notify/alipay` | Alipay async notification webhook |
| `POST /internal/usdt/reconcile` | Trigger a USDT reconciliation pass (e.g. from cron) |
| `GET /admin/reports/summary` | Reconciliation summary (filters: `from`,`to`,`method`,`status`) 🔒 |
| `GET /admin/orders` | Paginated orders (`limit`,`offset`,filters) 🔒 |
| `GET /admin/refunds` | Paginated refunds (`limit`,`offset`) 🔒 |
| `POST /admin/expiry/run` | Run subscription reminders + deactivation pass 🔒 |
| `POST /admin/reconciliation` | Run a financial-consistency audit (`?heal=true` to expire stale) 🔒 |
| `GET /admin/audit` | Query the audit log (filters: `action`,`actor`,`subjectId`,`from`,`to`) 🔒 |
| `GET /admin/orders.csv` | Export orders as CSV 🔒 |
| `GET /admin/refunds.csv` | Export refunds as CSV 🔒 |
| `GET /admin/webhooks` | List outbound webhook deliveries (filter `status`) 🔒 |
| `POST /admin/webhooks/{id}/retry` | Requeue a dead-lettered delivery 🔒 |
| `POST /internal/webhooks/process` | Drain due webhook deliveries (cron) |
| `POST /internal/maintenance/sweep` | Delete expired dedupe records (cron) |
| `GET /metrics` | Prometheus metrics (HTTP + business gauges) |

🔒 = requires `Authorization: Bearer $ADMIN_TOKEN`. Admin endpoints are disabled
(HTTP 403) until `ADMIN_TOKEN` is set.

### Example: create an order

```bash
curl -X POST http://localhost:3000/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 7f3c…' \
  -d '{"userId":"user_42","planId":"monthly","method":"wechat"}'
```

```json
{
  "orderId": "…", "outTradeNo": "VPN…", "status": "PENDING",
  "currency": "CNY", "amount": 1500, "amountDisplay": "15.00",
  "payInfo": { "renderAs": "qrcode", "payTarget": "weixin://wxpay/…", "extra": { "currency": "CNY" } }
}
```

For USDT, `payInfo.renderAs` is `address` and `payInfo.extra.amount` is the exact
amount the user must send so the deposit can be matched automatically.

## Refunds

Full and partial refunds are supported per method:

- **WeChat Pay** — `POST /v3/refund/domestic/refunds` (signed).
- **Alipay** — `alipay.trade.refund`.
- **USDT** — there is no automatic on-chain refund; the service records a
  `MANUAL` refund so an operator can return funds and the order is marked
  `REFUNDED`.

Refunds are idempotent by `outRefundNo`, reject over-refunding, accumulate
partial amounts, and only move an order to `REFUNDED` once fully refunded.

### Asynchronous refund settlement

WeChat refunds can return `PROCESSING` and settle later. The system handles this
safely with a **reserve-then-confirm** model:

1. When a refund is created, its amount is **reserved** on the order
   (`refundedAmount` increases, blocking double-refunds) but the order is **not**
   yet marked `REFUNDED` if the refund is still `PENDING`.
2. WeChat later POSTs the result to `/api/notify/wechat/refund`. The signed,
   AES-GCM-encrypted notification is verified and deduplicated, then:
   - `SUCCESS` → the refund is finalised and the order becomes `REFUNDED` if now
     fully refunded;
   - `CLOSED`/`ABNORMAL` → the refund is marked `FAILED` and the **reserved
     amount is released**, so the order can be refunded again.

Synchronous methods (Alipay) settle immediately and never enter `PENDING`; USDT
records a `MANUAL` refund (settled, operator-driven).

```bash
curl -X POST http://localhost:3000/api/orders/<id>/refund \
  -H 'Content-Type: application/json' \
  -d '{"amount":500,"reason":"partial refund","outRefundNo":"RF-001"}'
```

## Accounts

`UserService` (`src/services/userService.ts`) provides registration, login and
API-key authentication. Passwords are hashed with scrypt (salted, constant-time
verification); API keys are opaque `vpk_…` tokens. Because accounts store an
email and preferred locale, the expiry notifier can deliver **localized billing
emails automatically**: when `SMTP_*` is configured, the container wires
`TemplatedEmailNotifier` with the user directory as its lookup — no extra glue
code needed.

## Outbound webhooks (retry + dead-letter)

When `WEBHOOK_URL` is set, business events (`order.fulfilled`, `refund.updated`)
are published to the merchant endpoint by `WebhookDispatcher`
(`src/webhooks/outbound.ts`):

- each delivery is **persisted** (never lost on crash) and signed with
  `X-Webhook-Signature: sha256=<hmac>` over `timestamp.body` (verify with
  `WEBHOOK_SECRET`), plus `X-Webhook-Id`/`-Event`/`-Timestamp` headers;
- failures **retry with exponential backoff**, and after `WEBHOOK_MAX_ATTEMPTS`
  a delivery is **dead-lettered**;
- a background worker drains due deliveries; you can also trigger
  `POST /internal/webhooks/process` from cron, inspect the queue/DLQ via
  `GET /admin/webhooks?status=dead`, and requeue with
  `POST /admin/webhooks/{id}/retry`.

## Load & performance testing

`scripts/loadtest.ts` (`npm run loadtest`) spins up an in-process server with a
stub provider and drives a realistic mix (reads, registrations, full order+pay
flow) through a fixed-size worker pool, reporting throughput and p50/p90/p99/max
latency plus a status-code breakdown:

```bash
npm run build
LOAD_CONCURRENCY=50 LOAD_TOTAL=5000 npm run loadtest
# or time-boxed: LOAD_DURATION_SEC=30 npm run loadtest
```

## HTTP security hardening

Every response carries security headers (`X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`X-DNS-Prefetch-Control: off`). CORS is configurable via `CORS_ORIGINS`
(`*` = any, empty = disabled, else an allow-list) with automatic `OPTIONS`
preflight handling. Requests have a configurable timeout (`REQUEST_TIMEOUT_MS`
→ 503) and body-size cap (`MAX_BODY_BYTES` → 413).

## CSV export

`GET /admin/orders.csv` and `GET /admin/refunds.csv` stream RFC 4180 CSV
(`src/reporting/csv.ts`, properly escaped, CRLF line endings) for bookkeeping and
reconciliation. They honour the same filters as the JSON listing endpoints.

## Multi-currency pricing

`PricingService` (`src/pricing/`) converts integer minor-unit amounts between
currencies using an injectable `ExchangeRateProvider` (a `StaticExchangeRateProvider`
with a demo CNY-based rate table ships by default). Conversion is decimal-safe
(handles differing decimal places, half-up rounding). Query it via
`GET /api/pricing/quote?amount=<minor>&from=CNY&to=USDT`.

For live rates, set `FX_RATES_URL`: the container wires a
`CachingExchangeRateProvider` (`src/pricing/cachingExchangeRates.ts`) that
refreshes over HTTP on a TTL, serves the last good cache synchronously, and
**falls back to the static table** if the feed is unreachable — so pricing never
hard-fails on an FX outage.

## Idempotency & dedupe retention

Payment callbacks and polled settlements are deduplicated by a
`ProcessedEventStore`. Records now carry a timestamp and are swept past a
retention window (`PROCESSED_EVENT_TTL_DAYS`, default 7) to bound growth — the
window only needs to exceed a provider's retry window. The hourly maintenance
tick sweeps automatically; `POST /internal/maintenance/sweep` triggers it from
cron. The SQL store sweeps with `DELETE … WHERE created_at < cutoff`.

## End-to-end smoke test

`test/e2e.test.ts` boots the real HTTP server and walks the full journey —
register → login → `/me` → create order → pay (callback) → verify fulfilled →
refund → verify refunded → admin summary → audit log → metrics → OpenAPI —
asserting each step. Runs as part of `npm test`.

## API documentation

The full API is described by an OpenAPI 3.0.3 spec at `GET /openapi.json`, with
interactive Swagger UI at `GET /docs`. The spec (`src/api/openapi.ts`) covers
every endpoint with schemas, tags, and the `bearerAuth` security scheme.

## Audit log & consistency checks

- **Audit log** (`src/audit/auditLog.ts`) records significant actions
  (`order.created`, `order.fulfilled`, `refund.issued`, `user.registered`,
  `user.login`, `admin.access`). Query it via `GET /admin/audit` with
  action/actor/subject/time filters and pagination. Swap the in-memory store
  for a durable `AuditLog` implementation in production.
- **Reconciliation** (`src/services/reconciliationService.ts`, `POST
  /admin/reconciliation`) audits financial consistency across orders and
  refunds — flagging paid-but-unfulfilled, fulfilled-without-payment,
  over-refund, refund-ledger drift, and stale-pending orders. It is read-only
  unless `?heal=true`, which expires stale pending orders. Drive it from cron.
- **Alerting** (`src/alerting/alertFormatter.ts`): when a reconciliation run
  finds discrepancies, the result is formatted into an `Alert` (severity
  `critical` for money/state inconsistencies, `warning` for drift) and
  dispatched via `alertSink` — always logged, and published to the merchant
  webhook as a `reconciliation.alert` event when one is configured.
- **Dead-letter alerting**: the webhook watcher raises a (log-only) alert when
  the dead-letter queue grows — deliberately not via the merchant webhook, since
  that channel is the one failing. It alerts once per depth change, not per tick.

### API versioning

The current API is `v1` (see `GET /version`), and every response carries an
`X-API-Version` header. Every public `/api/*` route is **also** served under an
explicit `/api/v1/*` alias (both canonical for this major version). Breaking
changes will ship under a new prefix; the router's `markDeprecated(pattern,
sunset)` advertises `Deprecation`/`Sunset` (RFC 8594) headers on sunsetting
routes.

### Verifying outbound webhooks (merchant side)

Merchants verify our signed webhooks with `verifyWebhookSignature`
(`src/webhooks/verify.ts`): read the `X-Webhook-Timestamp` and
`X-Webhook-Signature` headers and the raw body, then
`verifyWebhookSignature(WEBHOOK_SECRET, timestamp, body, signature)` — it
recomputes the HMAC (constant-time compare) and rejects stale timestamps
(replay guard, default ±300s).

## Reconciliation & reporting

Admin endpoints (bearer-token protected) provide reconciliation data:

- `GET /admin/reports/summary` returns order counts by status, and **per-currency**
  gross revenue, settled refunds and net revenue (CNY and USDT are never summed
  together), plus a per-method breakdown. Supports `from`/`to`/`method`/`status`
  filters.
- `GET /admin/orders` and `GET /admin/refunds` return newest-first paginated
  listings (`limit`, `offset`).

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/admin/reports/summary?from=1735689600000&method=wechat"
```

## Subscription expiry & notifications

A background `ExpiryWatcher` (or the cron-friendly `POST /admin/expiry/run`):

- sends a **one-time renewal reminder** to users whose subscription expires
  within `EXPIRY_REMINDER_DAYS` (reset on renewal so each period reminds once);
- **deactivates** subscriptions once expired and emits a notification.

Delivery goes through the `Notifier` interface (`src/notifications/notifier.ts`).
The default `LoggerNotifier` just logs; swap in an email/SMS/push/webhook
implementation in production — no other code changes required.

## Monitoring & metrics

`GET /metrics` exposes Prometheus metrics (dependency-free registry in
`src/observability/metrics.ts`):

- `vpn_http_requests_total{method,route,code}` and
  `vpn_http_request_duration_ms{route}` (histogram) — auto-recorded by the
  router, labelled by route **pattern** (not raw path) to keep cardinality low;
- `vpn_orders{status}`, `vpn_refunds{status}`, `vpn_subscriptions_active` —
  gauges recomputed at scrape time from the repositories.

Point a Prometheus scraper at `/metrics`; restrict access via your network
policy (it is intentionally unauthenticated for scrapers).

Ready-to-use dashboards and alerts live in `monitoring/`:

- `monitoring/grafana-dashboard.json` — import into Grafana (request rate, 5xx
  ratio, p95 latency, orders by status, active subscriptions, refunds, rate
  limiting).
- `monitoring/prometheus-alerts.yml` — alert rules (high 5xx rate, high p95
  latency, sustained rate limiting, pending-order backlog, scrape-down).

## Rate limiting

A fixed-window limiter (`src/api/rateLimiter.ts`) caps requests per client IP +
route. Over-limit requests get `429` with `Retry-After` and `X-RateLimit-*`
headers; `/healthz` and `/metrics` are exempt. Configure with `RATE_LIMIT_*`
(disable via `RATE_LIMIT_ENABLED=false`). Rejections are counted in
`vpn_rate_limited_total{route}`. The in-process limiter suits a single node.

For a cluster, use the **Redis-backed** `RedisRateLimiter`
(`src/api/redisRateLimiter.ts`) — a drop-in `RateLimiterLike` using a
fixed-window `INCR`/`PEXPIRE` scheme. It depends only on an injected `RedisLike`
interface (`incr`/`pexpire`/`pttl`), so it works with `node-redis` or `ioredis`
without adding a hard dependency:

```ts
const limiter = new RedisRateLimiter(
  { incr: (k) => client.incr(k), pexpire: (k, ms) => client.pExpire(k, ms), pttl: (k) => client.pTTL(k) },
  config.rateLimit.max, config.rateLimit.windowMs,
);
```

## Outbound email (SMTP)

`SmtpMailSender` (`src/notifications/smtpMailSender.ts`) is a dependency-free
SMTP client (EHLO, optional AUTH LOGIN, direct-TLS or plaintext) that sends the
localized MIME emails. Wire it into the expiry notifier with your own user
lookup (the app does not store user emails itself):

```ts
import { SmtpMailSender } from './notifications/smtpMailSender';
import { TemplatedEmailNotifier } from './notifications/emailNotifier';

const notifier = new TemplatedEmailNotifier({
  sender: new SmtpMailSender(config.smtp!),
  plans,
  users: async (userId) => myUserDirectory.lookup(userId), // { email, locale, name }
});
const container = buildContainer(config, { notifier });
```

## Billing emails (i18n)

`src/notifications/emailTemplates.ts` renders localized billing emails
(`payment_receipt`, `refund_notice`, `expiry_reminder`, `expired_notice`) in
`zh-CN` and `en`, returning `{ subject, text, html }` (HTML values are escaped;
unknown locales fall back to English). `TemplatedEmailNotifier` is a `Notifier`
that turns expiry events into emails via an injectable `MailSender` and a
`UserLookup` (email + preferred locale) — plug in SMTP/SES/etc. in production.

## Sandbox / live integration scripts

`scripts/` contains runnable CLIs that exercise the **real** provider APIs with
your configured credentials:

```bash
npm run build
USDT_RECEIVING_ADDRESS=<addr> npm run sandbox:usdt      # read-only TronGrid query
ALIPAY_APP_ID=... ALIPAY_PRIVATE_KEY=... npm run sandbox:alipay   # precreate QR
WECHAT_MCH_ID=... WECHAT_PRIVATE_KEY=... npm run sandbox:wechat   # native QR
```

Point `ALIPAY_GATEWAY` at the Alipay sandbox for safe testing. These make live
outbound calls, so run them in an environment with network egress and valid
credentials.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and PR: `npm ci`, typecheck,
build, and the full test suite on Node 20 and 22, followed by a Docker image
build. Keep it green before merging.

## Deployment (Docker)

```bash
docker build -t vpn-payment-backend .
docker run -p 3000:3000 --env-file .env vpn-payment-backend
# or
docker compose up --build
```

The runtime image is a slim `node:22-alpine` containing only the compiled
`dist/` (no runtime `node_modules`, since the app has zero runtime deps), runs
as the unprivileged `node` user, and ships a `/healthz` HEALTHCHECK.

### Kubernetes / Helm

`deploy/` contains production-ready manifests and a Helm chart (`deploy/README.md`
for details):

- `deploy/k8s/` — raw manifests: Deployment (2 replicas, hardened
  securityContext, `/healthz` probes, resource requests/limits), Service,
  Ingress, HPA, ConfigMap, example Secret, and a Prometheus-Operator
  ServiceMonitor.
- `deploy/helm/vpn-payment/` — a parameterized chart (image, ingress,
  autoscaling, serviceMonitor toggles; secrets referenced via `existingSecret`).

```bash
kubectl apply -f deploy/k8s/                       # raw manifests
helm install vpn-payment deploy/helm/vpn-payment   # or via Helm
```

## Production notes

The storage layer is interface-based (`OrderRepository`, `RefundRepository`,
`SubscriptionRepository`, `ProcessedEventStore`, `Locker`). The included
in-memory implementations are used for tests and single-process demos.

For production, **PostgreSQL** implementations are provided in
`src/storage/sql/` (`SqlOrderRepository`, `SqlRefundRepository`,
`SqlSubscriptionRepository`, `SqlProcessedEventStore`) plus `schema.sql`. They
target an injected `SqlClient` interface that is compatible with `node-postgres`,
so the package keeps **zero hard dependencies** — add `pg` only if you use them:

```ts
import { Pool } from 'pg';
import { buildContainer } from './container';
import { SqlOrderRepository, SqlRefundRepository, SqlSubscriptionRepository, SqlProcessedEventStore } from './storage/sql/sqlStore';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const container = buildContainer(config, {
  orders: new SqlOrderRepository(pool),
  refunds: new SqlRefundRepository(pool),
  subscriptions: new SqlSubscriptionRepository(pool),
  processedEvents: new SqlProcessedEventStore(pool),
});
```

`SqlProcessedEventStore.markIfNew` uses `INSERT … ON CONFLICT DO NOTHING`, which
is atomic across multiple application instances, so callbacks are still
processed exactly once when scaled horizontally. A `SqlAuditLog`
(`src/storage/sql/sqlAuditLog.ts`, `audit_events` table) persists the audit log
the same way — pass it as `overrides.audit`.

Run the server behind HTTPS, keep private keys in a secret manager, and configure
the provider `notify_url`s to your public webhook endpoints.

## Testing

```bash
npm test
```

The suite (`test/`) uses Node's built-in test runner and generates throwaway RSA
keys at runtime to verify real signing/verification round-trips — no secrets or
network access required.
