# VPN Payment Backend

A commercial-grade payment backend for a VPN service, supporting **WeChat Pay**,
**Alipay**, and **USDT (TRC20)**. Written in TypeScript with **zero runtime
dependencies** (only Node.js ≥ 20 built-ins: `crypto`, `http`, `fetch`), which
keeps it auditable, easy to deploy, and free of payment-SDK supply-chain risk.

> Status: builds clean (`tsc`, strict mode) and passes **44 automated tests**
> covering signing, callbacks, the order state machine, idempotency, concurrency,
> amount validation, USDT reconciliation, and the HTTP API end-to-end.

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
| `POST /api/notify/wechat` | WeChat Pay v3 notification webhook |
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

## Production notes

The storage layer is interface-based (`OrderRepository`, `SubscriptionRepository`,
`ProcessedEventStore`, `Locker`). The included in-memory implementations are used
for tests and single-process demos; for production, provide Postgres/Redis-backed
implementations of those same interfaces — no business-logic changes required.
Run the server behind HTTPS, keep private keys in a secret manager, and configure
the provider `notify_url`s to your public webhook endpoints.

## Testing

```bash
npm test
```

The suite (`test/`) uses Node's built-in test runner and generates throwaway RSA
keys at runtime to verify real signing/verification round-trips — no secrets or
network access required.
