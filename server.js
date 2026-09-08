/**
 * SHHHT Mini App Backend
 * - Telegram initData auth (HMAC-SHA256)
 * - Per-user game state (SQLite)
 * - Full Admin CRUD for tasks / cards / boosters / tiers / settings
 * - Image URL support on cards, boosters, tasks, tiers
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const dbx = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
  .map(Number);

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is required in .env');
  process.exit(1);
}

// ---------- DB (Postgres/Supabase or SQLite via ./db.js) ----------
let dbReady = false;

async function ensureDb() {
  if (dbReady) return;
  await dbx.init();
  if (!dbx.isPg()) {
    // SQLite local schema (Supabase users already ran supabase-schema.sql)
    await dbx.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    language_code TEXT,
    is_premium INTEGER DEFAULT 0,
    handle TEXT,
    clan TEXT DEFAULT 'Samurai Sons',
    level INTEGER DEFAULT 1,
    level_pct REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    per_tap INTEGER DEFAULT 1,
    per_hour INTEGER DEFAULT 0,
    to_lvl_up INTEGER DEFAULT 1000,
    energy INTEGER DEFAULT 1000,
    max_energy INTEGER DEFAULT 1000,
    streak_day INTEGER DEFAULT 1,
    spins INTEGER DEFAULT 1,
    mining_timer_hrs INTEGER DEFAULT 3,
    char_emoji TEXT DEFAULT '',
    last_claim_daily INTEGER DEFAULT 0,
    last_active INTEGER DEFAULT 0,
    wallet TEXT DEFAULT '',
    og_pass INTEGER DEFAULT 0,
    friend_earnings REAL DEFAULT 0,
    tap_extra INTEGER DEFAULT 0,
    claimed_milestones TEXT DEFAULT '{}',
    photo_url TEXT DEFAULT '',
    ref_code TEXT DEFAULT '',
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS user_cards (
    telegram_id INTEGER, card_id TEXT, level INTEGER DEFAULT 1,
    PRIMARY KEY (telegram_id, card_id)
  );
  CREATE TABLE IF NOT EXISTS user_boosters (
    telegram_id INTEGER, booster_id TEXT, level INTEGER DEFAULT 1,
    PRIMARY KEY (telegram_id, booster_id)
  );
  CREATE TABLE IF NOT EXISTS user_tasks (
    telegram_id INTEGER, task_id TEXT, done INTEGER DEFAULT 0,
    PRIMARY KEY (telegram_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS friends (
    inviter_id INTEGER, friend_id INTEGER, premium INTEGER DEFAULT 0, joined_at INTEGER,
    PRIMARY KEY (inviter_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS referrals (
    telegram_id INTEGER PRIMARY KEY, referred_by INTEGER
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, section TEXT NOT NULL, name TEXT NOT NULL,
    reward INTEGER DEFAULT 0, icon TEXT DEFAULT '', img TEXT DEFAULT '',
    link TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
    per_hour INTEGER DEFAULT 0, cost INTEGER DEFAULT 0, locked INTEGER DEFAULT 0,
    lock_text TEXT DEFAULT '', img TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS boosters (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, desc TEXT DEFAULT '', metric TEXT DEFAULT '',
    icon TEXT DEFAULT '', img TEXT DEFAULT '', base_cost INTEGER DEFAULT 0,
    effect_type TEXT DEFAULT '', effect_value INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS tiers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, img TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS referral_tiers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, reward INTEGER DEFAULT 0,
    icon TEXT DEFAULT '', img TEXT DEFAULT '', requires_premium INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL, amount REAL NOT NULL, fee_pct REAL DEFAULT 5,
    receive_amount REAL NOT NULL, wallet TEXT NOT NULL, status TEXT DEFAULT 'pending',
    created_at INTEGER, updated_at INTEGER
  );
`);
  }
  dbReady = true;
}

// Seed defaults if empty
async function seedIfEmpty() {
  const row = await dbx.get('SELECT COUNT(*) as c FROM tasks', []);
  const taskCount = Number(row && row.c) || 0;
  if (taskCount === 0) {
    const tasks = [
      ['t1', 'daily', 'Daily rewards', 2500, '', '', '', 1],
      ['t2', 'watch', 'Watch ad', 100000, '', '', '', 1],
      ['t3', 'watch', 'Visit website', 100000, '', '', '', 2],
      ['t4', 'social', 'Join community', 25000, '', '', 'https://t.me/', 1],
    ];
    for (const t of tasks) {
      await dbx.run(
        'INSERT INTO tasks (id,section,name,reward,icon,img,link,sort_order) VALUES (?,?,?,?,?,?,?,?)',
        t
      );
    }
  }

  const crow = await dbx.get('SELECT COUNT(*) as c FROM cards', []);
  if (!(Number(crow && crow.c) || 0)) {
    const cards = [
      ['c1', 'finance', 'Starter Card', 50, 200, 0, '', '', 1],
      ['c2', 'welfare', 'Welfare Card', 80, 400, 0, '', '', 1],
      ['c3', 'special', 'Special Card', 120, 800, 0, '', '', 1],
    ];
    for (const c of cards) {
      await dbx.run(
        'INSERT INTO cards (id,category,name,per_hour,cost,locked,lock_text,img,sort_order) VALUES (?,?,?,?,?,?,?,?,?)',
        c
      );
    }
  }

  const brow = await dbx.get('SELECT COUNT(*) as c FROM boosters', []);
  if (!(Number(brow && brow.c) || 0)) {
    const boosters = [
      ['b1', 'Multi-tap', 'Increase coins per tap', '+1 per tap', '', '', 500, 'multitap', 1, 1],
      ['b2', 'Energy limit', 'Raise max energy', '+500 energy', '', '', 800, 'energy_limit', 500, 2],
    ];
    for (const b of boosters) {
      await dbx.run(
        'INSERT INTO boosters (id,name,desc,metric,icon,img,base_cost,effect_type,effect_value,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)',
        b
      );
    }
  }

  const trow = await dbx.get('SELECT COUNT(*) as c FROM tiers', []);
  if (!(Number(trow && trow.c) || 0)) {
    const tiers = [
      ['rookie', 'Rookie', '', 1],
      ['bronze', 'Bronze', '', 2],
      ['silver', 'Silver', '', 3],
    ];
    for (const t of tiers) {
      await dbx.run('INSERT INTO tiers (id,name,img,sort_order) VALUES (?,?,?,?)', t);
    }
  }

  // settings
  const defaults = {
    daily_rewards: JSON.stringify([2500, 5000, 7500, 10000, 15000, 20000, 30000]),
    total_players: '1.6M',
    app_title: 'SHHHT',
    og_pass_desc: '+50% mining rate, exclusive Special Cards, and daily bonus spins.',
    withdrawal_min: '1000',
    withdrawal_fee_pct: '5',
    og_pass_stars_price: '100',
    og_pass_gram_price: '5',
    spin_price: '1',
  };
  for (const [k, v] of Object.entries(defaults)) {
    const exists = await dbx.get('SELECT key FROM settings WHERE key = ?', [k]);
    if (!exists) {
      await dbx.run('INSERT INTO settings (key, value) VALUES (?, ?)', [k, v]);
    }
  }
}

async function getTasks() {
  return await dbx.all('SELECT * FROM tasks WHERE active = 1 ORDER BY section, sort_order, id', []);
}
async function getCards() {
  return await dbx.all('SELECT * FROM cards WHERE active = 1 ORDER BY category, sort_order, id', []);
}
async function getBoosters() {
  return await dbx.all('SELECT * FROM boosters WHERE active = 1 ORDER BY sort_order, id', []);
}
async function getTiers() {
  return await dbx.all('SELECT * FROM tiers WHERE active = 1 ORDER BY sort_order, id', []);
}
async function getReferralTiers() {
  return await dbx.all('SELECT * FROM referral_tiers WHERE active = 1 ORDER BY sort_order, id', []);
}
async function getSetting(key, fallback = null) {
  const row = await dbx.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  const exists = await dbx.get('SELECT key FROM settings WHERE key = ?', [key]);
  if (exists) {
    await dbx.run('UPDATE settings SET value = ? WHERE key = ?', [v, key]);
  } else {
    await dbx.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, v]);
  }
}

async function loadGameConfig() {
  let dailyRewards = [2500, 5000, 7500, 10000, 15000, 20000, 30000];
  try {
    const raw = await getSetting('daily_rewards', '[]');
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed) && parsed.length) dailyRewards = parsed;
  } catch (_) {}
  const tasks = await getTasks();
  const cards = await getCards();
  const boosters = await getBoosters();
  const tiers = await getTiers();
  const referralTiers = await getReferralTiers();
  return {
    dailyRewards,
    tasks: tasks.map(t => ({
      id: t.id, section: t.section, name: t.name, reward: t.reward,
      icon: t.icon, img: t.img || '', link: t.link || ''
    })),
    cards: cards.map(c => ({
      id: c.id, category: c.category, name: c.name, perHour: c.per_hour,
      cost: c.cost, locked: !!c.locked, lockText: c.lock_text || '', img: c.img || ''
    })),
    boosters: boosters.map(b => ({
      id: b.id, name: b.name, desc: b.desc, metric: b.metric, icon: b.icon,
      img: b.img || '', cost: b.base_cost, effectType: b.effect_type,
      effectValue: b.effect_value, level: 1
    })),
    tiers: tiers.map(t => ({ id: t.id, name: t.name, img: t.img || '' })),
    referralTiers: referralTiers.map(r => ({
      id: r.id, name: r.name, reward: r.reward, icon: r.icon,
      img: r.img || '', requiresPremium: !!r.requires_premium
    })),
    totalPlayers: await getSetting('total_players', '1.6M'),
    appTitle: await getSetting('app_title', 'SHHHT'),
    ogPassDesc: await getSetting('og_pass_desc', ''),
    withdrawalMin: Number(await getSetting('withdrawal_min', '1000')) || 1000,
    withdrawalFeePct: Number(await getSetting('withdrawal_fee_pct', '5')) || 5,
    ogPassStarsPrice: Number(await getSetting('og_pass_stars_price', '100')) || 100,
    ogPassGramPrice: Number(await getSetting('og_pass_gram_price', '5')) || 5,
    spinPrice: Number(await getSetting('spin_price', '1')) || 1,
  };
}



// ---------- Auth: Validate Telegram initData ----------
function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const entries = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(entries).digest('hex');

  try {
    const a = Buffer.from(computedHash, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 86400) return null;

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !user.id) return null;

  return {
    user,
    authDate,
    queryId: params.get('query_id') || null,
    startParam: params.get('start_param') || null
  };
}

// ---------- Middleware ----------
app.use(cors({ origin: true }));
app.use(express.json({ limit: '200kb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 150, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

function authMiddleware(req, res, next) {
  // Telegram WebApp initData only (no JWT)
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  const validated = validateInitData(initData);
  if (!validated) {
    return res.status(401).json({ error: 'Invalid or expired Telegram auth. Open the Mini App inside Telegram.' });
  }
  req.tg = validated;
  next();
}

function adminMiddleware(req, res, next) {
  if (!req.tg) return res.status(401).json({ error: 'Unauthorized' });
  const uid = req.tg.user.id;
  if (!ADMIN_TELEGRAM_IDS.includes(uid)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ---------- User helpers ----------
async function getOrCreateUser(tgUser, startParam = null) {
  const id = tgUser.id;
  let row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [id]);

  if (!row) {
    const handle = tgUser.username
      ? `@${tgUser.username}`
      : (tgUser.first_name || 'Player').slice(0, 32);

    await dbx.run(`
      INSERT INTO users (
        telegram_id, username, first_name, last_name, language_code, is_premium,
        handle, balance, energy, max_energy, per_tap, last_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1000, 1000, 1, ?)
    `, [id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null,
      tgUser.language_code || null, tgUser.is_premium ? 1 : 0, handle, Math.floor(Date.now() / 1000)]);

    if (startParam && startParam.startsWith('ref_')) {
      const inviterId = parseInt(startParam.replace('ref_', ''), 10);
      if (inviterId && inviterId !== id) {
        const inviterExists = await dbx.get('SELECT 1 FROM users WHERE telegram_id = ?', [inviterId]);
        if (inviterExists) {
          await dbx.run('INSERT OR IGNORE INTO referrals (telegram_id, referred_by) VALUES (?, ?)', [id, inviterId]);
          await dbx.run('INSERT OR IGNORE INTO friends (inviter_id, friend_id, premium) VALUES (?, ?, ?)', [inviterId, id, tgUser.is_premium ? 1 : 0]);
          const reward = tgUser.is_premium ? 25000 : 5000;
          await dbx.run('UPDATE users SET balance = balance + ? WHERE telegram_id = ?', [reward, inviterId]);
        }
      }
    }
    row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [id]);
  } else {
    await dbx.run(`
      UPDATE users SET username=?, first_name=?, last_name=?, language_code=?,
        is_premium=?, last_active=?, updated_at=?
      WHERE telegram_id=?
    `, [tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null,
      tgUser.language_code || null, tgUser.is_premium ? 1 : 0,
      Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), id]);
    row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [id]);
  }
  return row;
}

function userToClient(row) {
  return {
    telegramId: row.telegram_id,
    handle: row.handle,
    firstName: row.first_name,
    username: row.username,
    clan: row.clan,
    level: row.level,
    levelPct: row.level_pct,
    balance: Math.floor(row.balance || 0),
    perTap: row.per_tap,
    perHour: row.per_hour,
    toLvlUp: row.to_lvl_up,
    energy: Math.floor(row.energy || 0),
    maxEnergy: row.max_energy,
    streakDay: row.streak_day,
    spins: row.spins,
    miningTimerHrs: row.mining_timer_hrs,
    charEmoji: row.char_emoji,
    isPremium: !!row.is_premium,
    isAdmin: ADMIN_TELEGRAM_IDS.includes(row.telegram_id),
    wallet: row.wallet || '',
    ogPass: !!row.og_pass,
    friendEarnings: row.friend_earnings || 0,
    tapExtra: row.tap_extra || 0,
    photo: row.photo_url || ''
  };
}

// ---------- Routes ----------
// health registered after db init

// Auth + full state
app.post('/api/auth', authMiddleware, async (req, res) => {
  const { user, startParam } = req.tg;
  const row = await getOrCreateUser(user, startParam);
  const config = await loadGameConfig();

  // Offline earnings
  const now = Math.floor(Date.now() / 1000);
  const lastActive = row.last_active || now;
  const hoursOffline = Math.min((now - lastActive) / 3600, row.mining_timer_hrs || 3);
  let offlineEarned = 0;
  if (hoursOffline > 0.05 && row.per_hour > 0) {
    offlineEarned = Math.floor(hoursOffline * row.per_hour);
    if (offlineEarned > 0) {
      await dbx.run('UPDATE users SET balance = balance + ?, last_active = ? WHERE telegram_id = ?', [offlineEarned, now, row.telegram_id]);
      row.balance += offlineEarned;
    }
  } else {
    await dbx.run('UPDATE users SET last_active = ? WHERE telegram_id = ?', [now, row.telegram_id]);
  }

  const ownedCards = await dbx.all('SELECT card_id, level FROM user_cards WHERE telegram_id = ?', [row.telegram_id]);
  const ownedBoosters = await dbx.all('SELECT booster_id, level FROM user_boosters WHERE telegram_id = ?', [row.telegram_id]);
  const doneTasks = await dbx.all('SELECT task_id FROM user_tasks WHERE telegram_id = ? AND done = 1', [row.telegram_id]).map(t => t.task_id);

  const friends = await dbx.all(`
    SELECT f.friend_id, u.handle, u.username, f.premium, f.joined_at
    FROM friends f LEFT JOIN users u ON u.telegram_id = f.friend_id
    WHERE f.inviter_id = ? ORDER BY f.joined_at DESC LIMIT 50
  `, [row.telegram_id]);

  const leaderboard = await dbx.all(`
    SELECT handle, balance as total, per_hour as hourly,
      (SELECT COUNT(*) FROM friends WHERE inviter_id = users.telegram_id) as friends
    FROM users ORDER BY balance DESC LIMIT 20
  `, []);

  // Attach per-user booster levels
  const boostersWithLevel = config.boosters.map(b => {
    const owned = ownedBoosters.find(o => o.booster_id === b.id);
    return { ...b, level: owned ? owned.level : 1 };
  });

  const isAdmin = ADMIN_TELEGRAM_IDS.includes(user.id);

  const playerPayload = userToClient(row);
  res.json({
    isAdmin,
    player: playerPayload,
    user: playerPayload,
    offlineEarned,
    config: {
      ...config,
      tasks: config.tasks.map(t => ({ ...t, done: doneTasks.includes(t.id) })),
      boosters: boostersWithLevel
    },
    ownedCards,
    friends: friends.map(f => ({
      id: f.friend_id,
      name: f.handle || (f.username ? `@${f.username}` : `User ${f.friend_id}`),
      premium: !!f.premium,
      joined: new Date(f.joined_at * 1000).toLocaleDateString()
    })),
    season1Friends: '-',
    season2Friends: friends.length,
    leaderboard: leaderboard.map((p, i) => ({
      id: `l${i}`,
      name: p.handle,
      total: Math.floor(p.total),
      hourly: p.hourly,
      friends: p.friends,
      isYou: p.handle === row.handle
    }))
  });
});

// Tap
app.post('/api/tap', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const taps = Math.min(Math.max(parseInt(req.body.taps || 1, 10), 1), 20);
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const cost = row.per_tap * taps;
  if (row.energy < cost) return res.status(400).json({ error: 'Not enough energy', energy: row.energy });

  await dbx.run(`
    UPDATE users SET energy = energy - ?, balance = balance + ?, last_active = ?, updated_at = ?
    WHERE telegram_id = ?
  `, [cost, cost, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), user.id]);

  const updated = await dbx.get('SELECT balance, energy FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ balance: Math.floor(updated.balance), energy: Math.floor(updated.energy), earned: cost });
});

// Daily claim
app.post('/api/daily/claim', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const now = Math.floor(Date.now() / 1000);
  if (now - (row.last_claim_daily || 0) < 20 * 3600) {
    return res.status(400).json({ error: 'Already claimed today' });
  }

  const config = await loadGameConfig();
  const dayIndex = Math.min(row.streak_day - 1, config.dailyRewards.length - 1);
  const amount = config.dailyRewards[dayIndex] || config.dailyRewards[0] || 1000;

  await dbx.run(`
    UPDATE users SET balance = balance + ?, streak_day = streak_day + 1,
      last_claim_daily = ?, last_active = ?, updated_at = ?
    WHERE telegram_id = ?
  `, [amount, now, now, now, user.id]);

  const updated = await dbx.get('SELECT balance, streak_day FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ amount, balance: Math.floor(updated.balance), streakDay: updated.streak_day });
});

// Buy card
app.post('/api/shop/card', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const cardId = req.body.cardId;
  const card = await dbx.get('SELECT * FROM cards WHERE id = ? AND active = 1', [cardId]);
  if (!card || card.locked) return res.status(400).json({ error: 'Card not available' });

  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });
  if (row.balance < card.cost) return res.status(400).json({ error: 'Not enough balance' });

  await dbx.run('UPDATE users SET balance = balance - ?, per_hour = per_hour + ?, updated_at = ? WHERE telegram_id = ?', [card.cost, card.per_hour, Math.floor(Date.now() / 1000), user.id]);

  await dbx.run(`
    INSERT INTO user_cards (telegram_id, card_id, level) VALUES (?, ?, 1)
    ON CONFLICT(telegram_id, card_id) DO UPDATE SET level = level + 1
  `, [user.id, cardId]);

  const updated = await dbx.get('SELECT balance, per_hour FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ balance: Math.floor(updated.balance), perHour: updated.per_hour });
});

// Buy booster
app.post('/api/shop/booster', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const boosterId = req.body.boosterId;
  const booster = await dbx.get('SELECT * FROM boosters WHERE id = ? AND active = 1', [boosterId]);
  if (!booster) return res.status(400).json({ error: 'Booster not found' });

  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const cost = booster.base_cost || 0;
  if (cost > 0 && row.balance < cost) return res.status(400).json({ error: 'Not enough balance' });

  let newPerTap = row.per_tap;
  let newMaxEnergy = row.max_energy;
  let newMining = row.mining_timer_hrs;
  let newEnergy = row.energy;

  if (booster.effect_type === 'multitap') newPerTap += (booster.effect_value || 1);
  if (booster.effect_type === 'energy_limit') newMaxEnergy += (booster.effect_value || 500);
  if (booster.effect_type === 'mining_timer') newMining += (booster.effect_value || 1);
  if (booster.effect_type === 'full_energy') newEnergy = newMaxEnergy;

  await dbx.run(`
    UPDATE users SET balance = balance - ?, per_tap = ?, max_energy = ?,
      mining_timer_hrs = ?, energy = ?, updated_at = ?
    WHERE telegram_id = ?
  `, [cost, newPerTap, newMaxEnergy, newMining, newEnergy, Math.floor(Date.now() / 1000), user.id]);

  await dbx.run(`
    INSERT INTO user_boosters (telegram_id, booster_id, level) VALUES (?, ?, 1)
    ON CONFLICT(telegram_id, booster_id) DO UPDATE SET level = level + 1
  `, [user.id, boosterId]);

  const updated = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ player: userToClient(updated) });
});

// Complete task
app.post('/api/tasks/complete', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const taskId = req.body.taskId;
  const task = await dbx.get('SELECT * FROM tasks WHERE id = ? AND active = 1', [taskId]);
  if (!task) return res.status(400).json({ error: 'Task not found' });

  const already = await dbx.get('SELECT 1 FROM user_tasks WHERE telegram_id = ? AND task_id = ? AND done = 1', [user.id, taskId]);
  if (already) return res.status(400).json({ error: 'Already completed' });

  await dbx.run(`
    INSERT INTO user_tasks (telegram_id, task_id, done) VALUES (?, ?, 1)
    ON CONFLICT(telegram_id, task_id) DO UPDATE SET done = 1
  `, [user.id, taskId]);

  await dbx.run('UPDATE users SET balance = balance + ?, updated_at = ? WHERE telegram_id = ?', [task.reward, Math.floor(Date.now() / 1000), user.id]);

  const updated = await dbx.get('SELECT balance FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ reward: task.reward, balance: Math.floor(updated.balance) });
});

// Spin
app.post('/api/spin', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });
  if (row.spins <= 0) return res.status(400).json({ error: 'No spins left' });

  const prizes = [500, 1000, 2500, 5000, 10000, 25000];
  const win = prizes[Math.floor(Math.random() * prizes.length)];

  await dbx.run('UPDATE users SET spins = spins - 1, balance = balance + ?, updated_at = ? WHERE telegram_id = ?', [win, Math.floor(Date.now() / 1000), user.id]);

  const updated = await dbx.get('SELECT balance, spins FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ win, balance: Math.floor(updated.balance), spins: updated.spins });
});

app.get('/api/user/me', authMiddleware, async (req, res) => {
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ user: userToClient(row), player: userToClient(row) });
});

app.get('/api/config', authMiddleware, async (req, res) => {
  res.json(await loadGameConfig());
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({ player: userToClient(row) });
});

/* =========================================================================
   ADMIN API  (requires ADMIN_TELEGRAM_IDS)
========================================================================= */

// ---- Tasks ----
app.get('/api/admin/tasks', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ tasks: await dbx.all('SELECT * FROM tasks ORDER BY section, sort_order, id', []) });
});

app.post('/api/admin/tasks', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, section, name, reward, icon, img, link, sort_order, active } = req.body;
  const taskId = id || ('t' + Date.now());
  if (!name || !section) return res.status(400).json({ error: 'name and section required' });

  await dbx.run(`
    INSERT INTO tasks (id, section, name, reward, icon, img, link, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      section=excluded.section, name=excluded.name, reward=excluded.reward,
      icon=excluded.icon, img=excluded.img, link=excluded.link,
      sort_order=excluded.sort_order, active=excluded.active
  `, [taskId,
    section || 'social',
    name,
    Number(reward) || 0,
    icon || '⭐',
    img || '',
    link || '',
    Number(sort_order) || 0,
    active === undefined || active === true || active === 1 ? 1 : 0]);
  res.json({ ok: true, id: taskId, tasks: await dbx.all('SELECT * FROM tasks ORDER BY section, sort_order, id', []) });
});

app.delete('/api/admin/tasks/:id', authMiddleware, adminMiddleware, async (req, res) => {
  await dbx.run('DELETE FROM tasks WHERE id = ?', [req.params.id]);
  res.json({ ok: true, tasks: await dbx.all('SELECT * FROM tasks ORDER BY section, sort_order, id', []) });
});

// ---- Cards ----
app.get('/api/admin/cards', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ cards: await dbx.all('SELECT * FROM cards ORDER BY category, sort_order, id', []) });
});

app.post('/api/admin/cards', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, category, name, perHour, cost, locked, lockText, img, sort_order, active } = req.body;
  const cardId = id || ('c' + Date.now());
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });

  await dbx.run(`
    INSERT INTO cards (id, category, name, per_hour, cost, locked, lock_text, img, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category=excluded.category, name=excluded.name, per_hour=excluded.per_hour,
      cost=excluded.cost, locked=excluded.locked, lock_text=excluded.lock_text,
      img=excluded.img, sort_order=excluded.sort_order, active=excluded.active
  `, [cardId,
    category || 'finance',
    name,
    Number(perHour) || 0,
    Number(cost) || 0,
    locked ? 1 : 0,
    lockText || '',
    img || '',
    Number(sort_order) || 0,
    active === undefined || active === true || active === 1 ? 1 : 0]);
  res.json({ ok: true, id: cardId, cards: await dbx.all('SELECT * FROM cards ORDER BY category, sort_order, id', []) });
});

app.delete('/api/admin/cards/:id', authMiddleware, adminMiddleware, async (req, res) => {
  await dbx.run('DELETE FROM cards WHERE id = ?', [req.params.id]);
  res.json({ ok: true, cards: await dbx.all('SELECT * FROM cards ORDER BY category, sort_order, id', []) });
});

// ---- Boosters ----
app.get('/api/admin/boosters', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ boosters: await dbx.all('SELECT * FROM boosters ORDER BY sort_order, id', []) });
});

app.post('/api/admin/boosters', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, name, desc, metric, icon, img, base_cost, effect_type, effect_value, sort_order, active } = req.body;
  const boosterId = id || ('b' + Date.now());
  if (!name) return res.status(400).json({ error: 'name required' });

  await dbx.run(`
    INSERT INTO boosters (id, name, desc, metric, icon, img, base_cost, effect_type, effect_value, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, desc=excluded.desc, metric=excluded.metric,
      icon=excluded.icon, img=excluded.img, base_cost=excluded.base_cost,
      effect_type=excluded.effect_type, effect_value=excluded.effect_value,
      sort_order=excluded.sort_order, active=excluded.active
  `, [boosterId,
    name,
    desc || '',
    metric || '',
    icon || '⚡',
    img || '',
    Number(base_cost) || 0,
    effect_type || 'custom',
    Number(effect_value) || 1,
    Number(sort_order) || 0,
    active === undefined || active === true || active === 1 ? 1 : 0]);
  res.json({ ok: true, id: boosterId, boosters: await dbx.all('SELECT * FROM boosters ORDER BY sort_order, id', []) });
});

app.delete('/api/admin/boosters/:id', authMiddleware, adminMiddleware, async (req, res) => {
  await dbx.run('DELETE FROM boosters WHERE id = ?', [req.params.id]);
  res.json({ ok: true, boosters: await dbx.all('SELECT * FROM boosters ORDER BY sort_order, id', []) });
});

// ---- Tiers ----
app.get('/api/admin/tiers', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ tiers: await dbx.all('SELECT * FROM tiers ORDER BY sort_order, id', []) });
});

app.post('/api/admin/tiers', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, name, img, sort_order, active } = req.body;
  const tierId = id || ('ti' + Date.now());
  if (!name) return res.status(400).json({ error: 'name required' });

  await dbx.run(`
    INSERT INTO tiers (id, name, img, sort_order, active)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, img=excluded.img,
      sort_order=excluded.sort_order, active=excluded.active
  `, [tierId, name, img || '', Number(sort_order) || 0, active === undefined || active ? 1 : 0]);
  res.json({ ok: true, id: tierId, tiers: await dbx.all('SELECT * FROM tiers ORDER BY sort_order, id', []) });
});

app.delete('/api/admin/tiers/:id', authMiddleware, adminMiddleware, async (req, res) => {
  await dbx.run('DELETE FROM tiers WHERE id = ?', [req.params.id]);
  res.json({ ok: true, tiers: await dbx.all('SELECT * FROM tiers ORDER BY sort_order, id', []) });
});

// ---- Referral tiers ----
app.get('/api/admin/referral-tiers', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ referralTiers: await dbx.all('SELECT * FROM referral_tiers ORDER BY sort_order, id', []) });
});

app.post('/api/admin/referral-tiers', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, name, reward, icon, img, requires_premium, sort_order, active } = req.body;
  const rid = id || ('r' + Date.now());
  if (!name) return res.status(400).json({ error: 'name required' });

  await dbx.run(`
    INSERT INTO referral_tiers (id, name, reward, icon, img, requires_premium, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, reward=excluded.reward,
      icon=excluded.icon, img=excluded.img, requires_premium=excluded.requires_premium,
      sort_order=excluded.sort_order, active=excluded.active
  `, [rid, name, Number(reward) || 0, icon || '🎁', img || '', requires_premium ? 1 : 0,
    Number(sort_order) || 0, active === undefined || active ? 1 : 0]);
  res.json({ ok: true, id: rid, referralTiers: await dbx.all('SELECT * FROM referral_tiers ORDER BY sort_order, id', []) });
});

app.delete('/api/admin/referral-tiers/:id', authMiddleware, adminMiddleware, async (req, res) => {
  await dbx.run('DELETE FROM referral_tiers WHERE id = ?', [req.params.id]);
  res.json({ ok: true, referralTiers: await dbx.all('SELECT * FROM referral_tiers ORDER BY sort_order, id', []) });
});

// ---- Settings ----
app.get('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
  const rows = await dbx.all('SELECT key, value FROM settings', []);
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ settings });
});

app.post('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  await setSetting(key, value);
  res.json({ ok: true });
});

// Bulk load all admin data
app.get('/api/admin/all', authMiddleware, adminMiddleware, async (req, res) => {
  const settingRows = await dbx.all('SELECT key, value FROM settings', []);
  const settings = {};
  settingRows.forEach(r => { settings[r.key] = r.value; });
  res.json({
    tasks: await dbx.all('SELECT * FROM tasks ORDER BY section, sort_order, id', []),
    cards: await dbx.all('SELECT * FROM cards ORDER BY category, sort_order, id', []),
    boosters: await dbx.all('SELECT * FROM boosters ORDER BY sort_order, id', []),
    tiers: await dbx.all('SELECT * FROM tiers ORDER BY sort_order, id', []),
    referralTiers: await dbx.all('SELECT * FROM referral_tiers ORDER BY sort_order, id', []),
    settings
  });
});

// ---------- Withdrawals ----------
app.post('/api/withdrawals', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const amount = Number(req.body.amount) || 0;
  const wallet = String(req.body.wallet || '').trim();
  if (!wallet || wallet.length < 10) return res.status(400).json({ error: 'Invalid wallet' });

  const minAmt = Number(await getSetting('withdrawal_min', '1000')) || 1000;
  if (amount < minAmt) return res.status(400).json({ error: 'Below minimum (' + minAmt + ')' });

  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });
  if (row.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  let isOg = false;
  try { isOg = !!(row.og_pass || row.is_og); } catch (_) {}
  if (req.body && (req.body.isOg === true || req.body.isOg === 1 || req.body.isOg === 'true')) isOg = true;
  const feePct = isOg ? 0 : (Number(await getSetting('withdrawal_fee_pct', '5')) || 5);
  const fee = Math.floor(amount * feePct / 100);
  const receive = amount - fee;
  const now = Math.floor(Date.now() / 1000);

  await dbx.run(
    'UPDATE users SET balance = balance - ?, updated_at = ? WHERE telegram_id = ?',
    [amount, now, user.id]
  );
  await dbx.run(
    `INSERT INTO withdrawals (telegram_id, amount, fee_pct, receive_amount, wallet, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [user.id, amount, feePct, receive, wallet, now, now]
  );

  res.json({
    ok: true,
    amount,
    feePct,
    receive,
    wallet,
    balance: Math.floor(row.balance - amount)
  });
});

app.get('/api/withdrawals/mine', authMiddleware, async (req, res) => {
  const list = await dbx.all(`
    SELECT id, amount, fee_pct, receive_amount, wallet, status, created_at, updated_at
    FROM withdrawals WHERE telegram_id = ? ORDER BY id DESC LIMIT 50
  `, [req.tg.user.id]);
  res.json({ withdrawals: list });
});

app.get('/api/admin/withdrawals', authMiddleware, adminMiddleware, async (req, res) => {
  const list = await dbx.all(`
    SELECT w.*, u.handle, u.username
    FROM withdrawals w
    LEFT JOIN users u ON u.telegram_id = w.telegram_id
    ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END, w.id DESC
    LIMIT 200
  `, []);
  res.json({
    withdrawals: list,
    min_amount: Number(await getSetting('withdrawal_min', '1000')) || 1000
  });
});

app.post('/api/admin/withdrawals/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;
  if (!['approved', 'declined', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const row = await dbx.get('SELECT * FROM withdrawals WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'Not found' });

  if (status === 'declined' && row.status === 'pending') {
    // refund
    await dbx.run('UPDATE users SET balance = balance + ?, updated_at = ? WHERE telegram_id = ?', [row.amount, Math.floor(Date.now() / 1000), row.telegram_id]);
  }
  await dbx.run('UPDATE withdrawals SET status = ?, updated_at = ? WHERE id = ?', [status, Math.floor(Date.now() / 1000), id]);
  res.json({ ok: true });
});


// Admin password verify (optional second gate for panel)
app.post('/api/admin/verify-password', authMiddleware, adminMiddleware, async (req, res) => {
  const expected = process.env.ADMIN_PANEL_PASSWORD || 'ShhhtoshiAdmin2024';
  const ok = String(req.body?.password || '') === expected;
  if (!ok) return res.status(403).json({ ok: false, error: 'Wrong password' });
  res.json({ ok: true });
});

// Save wallet
app.post('/api/wallet', authMiddleware, async (req, res) => {
  const wallet = String(req.body?.wallet || '').trim();
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  await dbx.run('UPDATE users SET wallet = ?, updated_at = ? WHERE telegram_id = ?', [wallet, Math.floor(Date.now() / 1000), req.tg.user.id]);
  res.json({ ok: true, wallet });
});

// Start
(async () => {
  try {
    await ensureDb();
    await seedIfEmpty();
    app.get('/api/health', async (req, res) => {
      res.json({ ok: true, ts: Date.now(), db: dbx.isPg() ? 'postgres' : 'sqlite' });
    });
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`SHHHT backend on :${PORT}  db=${dbx.isPg() ? 'postgres/supabase' : 'sqlite'}`);
      console.log(`Admin IDs: ${ADMIN_TELEGRAM_IDS.join(', ') || '(none set)'}`);
    });
  } catch (e) {
    console.error('Failed to start', e);
    process.exit(1);
  }
})();
