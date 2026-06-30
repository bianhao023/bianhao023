# VPN Payment Backend

A commercial-grade payment backend for a VPN service, supporting **WeChat Pay**,
**Alipay**, and **USDT (TRC20)**. Written in TypeScript with **zero runtime
dependencies** (only Node.js ≥ 20 built-ins: `crypto`, `http`, `fetch`), which
keeps it auditable, easy to deploy, and free of payment-SDK supply-chain risk.

> Status: builds clean (`tsc`, strict mode) and passes **66 automated tests**
> covering signing, callbacks, the order state machine, idempotency, concurrency,
> amount validation, USDT reconciliation, refunds (full/partial/manual and
> asynchronous PROCESSING→final settlement), the SQL row mappers, and the HTTP
> API end-to-end.

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
| `GET /api/plans` | List VPN plans with prices |
| `POST /api/orders` | Create an order. Body: `{ userId, planId, method }`; optional `Idempotency-Key` header |
| `GET /api/orders/:id` | Order status + pay info |
| `POST /api/orders/:id/sync` | Force a status re-check (used while waiting on USDT) |
| `POST /api/orders/:id/refund` | Refund an order (full or partial). Body: `{ amount?, reason?, outRefundNo? }` |
| `GET /api/orders/:id/refunds` | List refunds issued against an order |
| `POST /api/notify/wechat` | WeChat Pay v3 payment notification webhook |
| `POST /api/notify/wechat/refund` | WeChat Pay v3 async refund-result webhook |
| `POST /api/notify/alipay` | Alipay async notification webhook |
| `POST /internal/usdt/reconcile` | Trigger a USDT reconciliation pass (e.g. from cron) |

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
processed exactly once when scaled horizontally.

Run the server behind HTTPS, keep private keys in a secret manager, and configure
the provider `notify_url`s to your public webhook endpoints.

## Testing

```bash
npm test
```

The suite (`test/`) uses Node's built-in test runner and generates throwaway RSA
keys at runtime to verify real signing/verification round-trips — no secrets or
network access required.
