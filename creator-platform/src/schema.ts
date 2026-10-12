export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('user','creator')),
  region TEXT NOT NULL,
  kyc_status TEXT NOT NULL DEFAULT 'NONE' CHECK (kyc_status IN ('NONE','PENDING','VERIFIED','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 원장 계정. 사용자/크리에이터 지갑 = 내부 계정(온체인 키 아님)
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('USER_WALLET','CREATOR_WALLET','ESCROW','PLATFORM_REVENUE','PAYOUT_HOLD','ISSUANCE')),
  owner_user_id TEXT REFERENCES users(id),
  address TEXT NOT NULL UNIQUE,
  balance BIGINT NOT NULL DEFAULT 0,
  allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (allow_negative OR balance >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_wallet_per_user ON ledger_accounts(owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  memo JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  tx_id TEXT NOT NULL REFERENCES ledger_transactions(id),
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  amount BIGINT NOT NULL CHECK (amount <> 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS ledger_entries_tx ON ledger_entries(tx_id);

-- 원장 기록은 수정/삭제 불가. 정정은 반대 분개로만 한다.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger rows are immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS entries_immutable ON ledger_entries;
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
DROP TRIGGER IF EXISTS tx_immutable ON ledger_transactions;
CREATE TRIGGER tx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  coins BIGINT NOT NULL CHECK (coins > 0),
  region TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  price_version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','FAILED')),
  pg_payment_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  price_coins BIGINT NOT NULL CHECK (price_coins > 0),
  period_days INT NOT NULL CHECK (period_days > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  receipt_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','CANCELLED')),
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_sub ON subscriptions(user_id, plan_id) WHERE status = 'ACTIVE';

-- 에스크로 일할 정산 일정. 불변식: ESCROW 잔액 = SUM(total - released - refunded)
CREATE TABLE IF NOT EXISTS escrow_schedules (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
  total BIGINT NOT NULL,
  released BIGINT NOT NULL DEFAULT 0,
  refunded BIGINT NOT NULL DEFAULT 0,
  days INT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  CHECK (released >= 0 AND refunded >= 0 AND released + refunded <= total)
);

CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  storage_key TEXT NOT NULL,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 구독자별 전달 기록. wm_id -> 이 테이블 -> 계정 으로 유출 추적
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  content_id TEXT NOT NULL REFERENCES contents(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  wm_id TEXT NOT NULL UNIQUE,
  access_count INT NOT NULL DEFAULT 1,
  first_at TIMESTAMPTZ NOT NULL,
  last_at TIMESTAMPTZ NOT NULL,
  UNIQUE (receipt_id, content_id)
);

CREATE TABLE IF NOT EXISTS leak_reports (
  id TEXT PRIMARY KEY,
  wm_id TEXT NOT NULL,
  content_id TEXT,
  source_url TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  delivery_id TEXT REFERENCES deliveries(id),
  resolved_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','DISMISSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  coins BIGINT NOT NULL CHECK (coins > 0),
  currency TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  price_version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CANCELLED','FAILED')),
  release_at TIMESTAMPTZ NOT NULL,
  external_id TEXT,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

INSERT INTO ledger_accounts (id, kind, address, allow_negative) VALUES
  ('sys_issuance','ISSUANCE','sys_issuance', TRUE),
  ('sys_escrow','ESCROW','sys_escrow', FALSE),
  ('sys_platform_revenue','PLATFORM_REVENUE','sys_platform_revenue', FALSE),
  ('sys_payout_hold','PAYOUT_HOLD','sys_payout_hold', FALSE)
ON CONFLICT (id) DO NOTHING;
`;
