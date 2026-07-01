-- PostgreSQL schema for the VPN payment backend.
-- Apply with: psql "$DATABASE_URL" -f src/storage/sql/schema.sql

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_orders_status_method ON orders (status, method);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);

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
