-- PostgreSQL schema for the VPN payment backend.
-- Apply with: psql "$DATABASE_URL" -f src/storage/sql/schema.sql

-- Merchants / tenants (multi-tenant isolation). A `default` row is
-- auto-provisioned by the app for single-tenant deployments.
CREATE TABLE IF NOT EXISTS merchants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL,
  api_key           TEXT NOT NULL UNIQUE,
  api_key_previous  TEXT,
  usdt_hd_path      TEXT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchants_api_key_prev ON merchants (api_key_previous);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL DEFAULT 'default',
  out_trade_no     TEXT NOT NULL UNIQUE,
  user_id          TEXT NOT NULL,
  plan_id          TEXT NOT NULL,
  method           TEXT NOT NULL,
  currency         TEXT NOT NULL,
  amount           BIGINT NOT NULL,
  status           TEXT NOT NULL,
  provider_txn_id  TEXT,
  idempotency_key  TEXT UNIQUE,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  paid_at          BIGINT,
  refunded_amount  BIGINT NOT NULL DEFAULT 0,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Backfill for pre-existing deployments (idempotent).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_orders_status_method ON orders (status, method);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders (merchant_id);

CREATE TABLE IF NOT EXISTS refunds (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders (id),
  out_refund_no      TEXT NOT NULL UNIQUE,
  amount             BIGINT NOT NULL,
  currency           TEXT NOT NULL,
  reason             TEXT,
  status             TEXT NOT NULL,
  provider_refund_id TEXT,
  raw_status         TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds (order_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  starts_at     BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  traffic_gb    INTEGER NOT NULL,
  device_limit  INTEGER NOT NULL,
  active             BOOLEAN NOT NULL,
  order_ids          JSONB NOT NULL DEFAULT '[]'::jsonb,
  expiry_notified_at BIGINT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL
);

-- One active subscription per user (matches MemorySubscriptionRepository).
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_active_user
  ON subscriptions (user_id) WHERE active;

-- Processed provider events / transactions, for replay & dedupe.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id    TEXT PRIMARY KEY,
  created_at  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  at          BIGINT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT,
  subject_id  TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events (action);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_events (subject_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events (at);

-- Registered accounts. The UNIQUE constraints on email and api_key back
-- findByEmail / findByApiKey, so no extra indexes are needed.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  locale        TEXT NOT NULL,
  name          TEXT,
  password_hash TEXT NOT NULL,
  api_key       TEXT NOT NULL UNIQUE,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

-- Per-order USDT deposit addresses + sweep ("二次归集") jobs.
CREATE SEQUENCE IF NOT EXISTS deposit_address_index_seq;

CREATE TABLE IF NOT EXISTS deposit_addresses (
  index      BIGINT PRIMARY KEY,
  address    TEXT NOT NULL UNIQUE,
  order_id   TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sweep_jobs (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL UNIQUE,
  deposit_index      BIGINT NOT NULL,
  deposit_address    TEXT NOT NULL,
  collection_address TEXT NOT NULL,
  amount_micro       BIGINT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL,
  gas_tx_id          TEXT,
  sweep_tx_id        TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  next_attempt_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sweep_jobs_due ON sweep_jobs (next_attempt_at)
  WHERE status IN ('PENDING','GAS_FUELING','SWEEPING');
