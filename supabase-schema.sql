-- ShhhToshi / SHHHT schema for Supabase (Postgres)
-- Run in Supabase SQL editor when you are ready to migrate off SQLite.

CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_premium INT DEFAULT 0,
  handle TEXT,
  clan TEXT DEFAULT 'Samurai Sons',
  level INT DEFAULT 1,
  level_pct REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  per_tap INT DEFAULT 1,
  per_hour INT DEFAULT 0,
  to_lvl_up INT DEFAULT 1000,
  energy INT DEFAULT 1000,
  max_energy INT DEFAULT 1000,
  streak_day INT DEFAULT 1,
  spins INT DEFAULT 1,
  mining_timer_hrs INT DEFAULT 3,
  char_emoji TEXT DEFAULT '',
  last_claim_daily BIGINT DEFAULT 0,
  last_active BIGINT DEFAULT 0,
  wallet TEXT DEFAULT '',
  og_pass INT DEFAULT 0,
  og_pass_expires_at BIGINT DEFAULT 0,
  friend_earnings REAL DEFAULT 0,
  tap_extra INT DEFAULT 0,
  claimed_milestones TEXT DEFAULT '{}',
  photo_url TEXT DEFAULT '',
  ref_code TEXT DEFAULT '',
  banned INT DEFAULT 0,
  created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE TABLE IF NOT EXISTS user_cards (
  telegram_id BIGINT,
  card_id TEXT,
  level INT DEFAULT 1,
  PRIMARY KEY (telegram_id, card_id)
);

CREATE TABLE IF NOT EXISTS user_boosters (
  telegram_id BIGINT,
  booster_id TEXT,
  level INT DEFAULT 1,
  PRIMARY KEY (telegram_id, booster_id)
);

CREATE TABLE IF NOT EXISTS user_tasks (
  telegram_id BIGINT,
  task_id TEXT,
  done INT DEFAULT 0,
  PRIMARY KEY (telegram_id, task_id)
);

CREATE TABLE IF NOT EXISTS friends (
  inviter_id BIGINT,
  friend_id BIGINT,
  premium INT DEFAULT 0,
  joined_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  PRIMARY KEY (inviter_id, friend_id)
);

CREATE TABLE IF NOT EXISTS referrals (
  telegram_id BIGINT PRIMARY KEY,
  referred_by BIGINT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL,
  name TEXT NOT NULL,
  reward INT DEFAULT 0,
  icon TEXT DEFAULT '',
  img TEXT DEFAULT '',
  link TEXT DEFAULT '',
  sort_order INT DEFAULT 0,
  active INT DEFAULT 1,
  type TEXT DEFAULT 'social',
  chat_id TEXT DEFAULT '',
  block_id TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  per_hour INT DEFAULT 0,
  cost INT DEFAULT 0,
  locked INT DEFAULT 0,
  lock_text TEXT DEFAULT '',
  img TEXT DEFAULT '',
  sort_order INT DEFAULT 0,
  active INT DEFAULT 1,
  stars_price INT DEFAULT 0,
  gram_price REAL DEFAULT 0,
  max_level INT DEFAULT 8
);

CREATE TABLE IF NOT EXISTS boosters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "desc" TEXT DEFAULT '',
  metric TEXT DEFAULT '',
  icon TEXT DEFAULT '',
  img TEXT DEFAULT '',
  base_cost INT DEFAULT 0,
  effect_type TEXT DEFAULT '',
  effect_value INT DEFAULT 1,
  sort_order INT DEFAULT 0,
  active INT DEFAULT 1,
  stars_price INT DEFAULT 0,
  gram_price REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS spin_packs (
  id TEXT PRIMARY KEY,
  spins INT NOT NULL,
  stars_price INT DEFAULT 0,
  gram_price REAL DEFAULT 0,
  sort_order INT DEFAULT 0,
  active INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  img TEXT DEFAULT '',
  sort_order INT DEFAULT 0,
  active INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS referral_tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  reward INT DEFAULT 0,
  icon TEXT DEFAULT '',
  img TEXT DEFAULT '',
  requires_premium INT DEFAULT 0,
  sort_order INT DEFAULT 0,
  active INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  amount REAL NOT NULL,
  fee_pct REAL DEFAULT 5,
  receive_amount REAL NOT NULL,
  wallet TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(telegram_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance DESC);

CREATE TABLE IF NOT EXISTS stars_invoices (
  payload TEXT PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT DEFAULT '',
  stars_amount INT NOT NULL,
  status TEXT DEFAULT 'pending',
  telegram_payment_charge_id TEXT DEFAULT '',
  created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE TABLE IF NOT EXISTS ton_payments (
  memo TEXT PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT DEFAULT '',
  ton_amount REAL NOT NULL,
  status TEXT DEFAULT 'pending',
  tx_hash TEXT DEFAULT '',
  created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_stars_invoices_user ON stars_invoices(telegram_id);
CREATE INDEX IF NOT EXISTS idx_ton_payments_user ON ton_payments(telegram_id);
