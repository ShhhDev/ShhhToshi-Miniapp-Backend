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
// Express 4 doesn't catch async errors -> wrap handlers so a DB error returns 500 instead of hanging/crashing
['get','post','put','delete'].forEach(m=>{const o=app[m].bind(app);app[m]=(p,...h)=>o(p,...h.map(f=>typeof f==='function'&&f.length<4?(q,r,n)=>Promise.resolve(f(q,r,n)).catch(e=>{console.error(m,p,e);if(!r.headersSent)r.status(500).json({error:'Server error'});}):f));});
process.on('unhandledRejection',e=>console.error('unhandledRejection',e));
const PORT = process.env.PORT || 3000;
const DEFAULT_INVITE_MSG = 'Join me on ShhhToshi 🚀 Tap, earn $SHHHT, spin & climb the ranks!';
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
    id TEXT PRIMARY KEY, name TEXT NOT NULL, "desc" TEXT DEFAULT '', metric TEXT DEFAULT '',
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
  if (!dbx.isPg()) {
    try { await dbx.exec('ALTER TABLE users ADD COLUMN last_reminder_at INTEGER DEFAULT 0'); } catch (_) { /* already exists */ }
  }
  if (!dbx.isPg()) {
    try { await dbx.exec('ALTER TABLE users ADD COLUMN energy_bonus INTEGER'); } catch (_) {}
    try { await dbx.exec('ALTER TABLE friends ADD COLUMN reward INTEGER DEFAULT 0'); } catch (_) {}
    try { await dbx.exec('ALTER TABLE users ADD COLUMN og_expires_at INTEGER DEFAULT 0'); } catch (_) {}
    try { await dbx.exec('ALTER TABLE users ADD COLUMN last_income_at INTEGER DEFAULT 0'); } catch (_) {}
    try { await dbx.exec("ALTER TABLE tasks ADD COLUMN block_id TEXT DEFAULT ''"); } catch (_) {}
  }
  await dbx.exec('CREATE TABLE IF NOT EXISTS ton_orders (nonce TEXT PRIMARY KEY, telegram_id BIGINT, kind TEXT, amount_ton REAL, created_at BIGINT, status TEXT, tx_hash TEXT)');
  await dbx.exec('CREATE TABLE IF NOT EXISTS task_claims (telegram_id BIGINT, task_id TEXT, day INTEGER, cnt INTEGER DEFAULT 0, last_at BIGINT DEFAULT 0, PRIMARY KEY (telegram_id, task_id, day))');
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
        'INSERT INTO boosters (id,name,"desc",metric,icon,img,base_cost,effect_type,effect_value,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)',
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
    referral_reward: '5000',
    referral_reward_premium: '25000',
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
    spinPacks: await getSpinPackages(),
    inviteMessage: String(await getSetting('invite_message', DEFAULT_INVITE_MSG)).replace(/<[^>]+>/g, ''),
    inviteButtonText: await getSetting('invite_button_text', 'Join Me'),
    shopBoosts: boosters.map(b => ({
      id: b.id, title: b.name, name: b.name, desc: b.desc, description: b.desc, image: b.img || '',
      kind: b.effect_type === 'multitap' ? 'tap_power' : b.effect_type, boost: b.effect_value,
      spPrice: b.base_cost, requirement: 'sp', pay_methods: ['sp']
    })),
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
app.set('trust proxy', 1);
app.options('*', cors({ origin: true }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: '200kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});
app.use(limiter);

function authMiddleware(req, res, next) {
  // Telegram WebApp initData only (no JWT)
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  const validated = validateInitData(initData);
  if (!validated) {
    console.warn('[auth] rejected:', !initData ? 'no initData sent (not opened inside Telegram?)' : (BOT_TOKEN ? 'bad signature or older than 24h — BOT_TOKEN may not match this bot' : 'BOT_TOKEN env var is NOT set'), req.method, req.path);
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


async function tgSend(chatId, text, replyMarkup) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
      }).then(x => x.json());
      if (r && r.ok) return true;
      if (r && r.error_code === 429 && attempt === 0) { await new Promise(z => setTimeout(z, ((r.parameters && r.parameters.retry_after) || 2) * 1000 + 500)); continue; }
      return false; // e.g. user blocked the bot
    } catch (e) { console.error('tgSend', e.message); return false; }
  }
  return false;
}
const escHtml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Count a referral exactly once, pay the inviter, and DM them "New Refer Joined" + total count. */
async function registerReferral(inviterId, tgUser) {
  if (!inviterId || inviterId === tgUser.id) return false;
  const inviter = await dbx.get('SELECT telegram_id, balance FROM users WHERE telegram_id = ?', [inviterId]);
  if (!inviter) return false;
  const r = await dbx.run('INSERT OR IGNORE INTO referrals (telegram_id, referred_by) VALUES (?, ?)', [tgUser.id, inviterId]);
  if (!r.changes) return false; // already referred -> never double count
  const now = Math.floor(Date.now() / 1000);
  const rr = await refRewardsFor(inviter.balance);
  const reward = tgUser.is_premium ? rr.premium : rr.normal;
  await dbx.run('INSERT OR IGNORE INTO friends (inviter_id, friend_id, premium, joined_at, reward) VALUES (?, ?, ?, ?, ?)', [inviterId, tgUser.id, tgUser.is_premium ? 1 : 0, now, reward]);
  await dbx.run('UPDATE users SET friend_earnings = friend_earnings + ?, updated_at = ? WHERE telegram_id = ?', [reward, now, inviterId]);
  const cnt = await dbx.get('SELECT COUNT(*) AS c FROM friends WHERE inviter_id = ?', [inviterId]);
  const name = escHtml(tgUser.first_name || tgUser.username || 'Someone') + (tgUser.username ? ' (@' + escHtml(tgUser.username) + ')' : '');
  await tgSend(inviterId,
    '🎉 <b>New Refer Joined through your link!</b>\n\n' +
    '👤 ' + name + (tgUser.is_premium ? ' ⭐' : '') + '\n' +
    '🎁 Reward: <b>+' + reward.toLocaleString('en-US') + '</b> SHHHT (tap Collect in the Friends tab)\n\n' +
    '👥 <b>Total Referrals: ' + Number(cnt.c) + '</b>');
  return true;
}

// ---------- User helpers ----------
async function getOrCreateUser(tgUser, startParam = null) {
  const id = tgUser.id;
  let row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [id]);

  if (!row) {
    const handle = (tgUser.first_name || tgUser.username || 'Player').toString().slice(0, 32);

    const nowTs = Math.floor(Date.now() / 1000);
    const ins = await dbx.run(`
      INSERT OR IGNORE INTO users (
        telegram_id, username, first_name, last_name, language_code, is_premium,
        handle, balance, energy, max_energy, per_tap, last_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1000, 1000, 1, ?, ${nowTs}, ${nowTs})
    `, [id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null,
      tgUser.language_code || null, tgUser.is_premium ? 1 : 0, handle, Math.floor(Date.now() / 1000)]);

    if (ins.changes && startParam && /^ref_\d+$/.test(startParam)) {
      await registerReferral(parseInt(startParam.slice(4), 10), tgUser);
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


const LEVEL_TABLE = [
  { name: "Rookie",   min: 0,        baseTap: 1, energy: 1000 },
  { name: "Bronze",   min: 10000,    baseTap: 2, energy: 1500 },
  { name: "Silver",   min: 50000,    baseTap: 3, energy: 2000 },
  { name: "Gold",     min: 150000,   baseTap: 4, energy: 2500 },
  { name: "Platinum", min: 400000,   baseTap: 5, energy: 3000 },
  { name: "Diamond",  min: 1000000,  baseTap: 6, energy: 3500 },
  { name: "Master",   min: 2500000,  baseTap: 7, energy: 4000 },
  { name: "Legend",   min: 5000000,  baseTap: 8, energy: 5000 }
];
// Referral reward scales with the inviter's level: base x (1 + step x levelIndex)
let REF_CFG = { base: 1000, step: 0, at: 0 };
async function loadRefCfg() {
  if (Date.now() - REF_CFG.at < 30000) return;
  const step = Number(await getSetting('referral_level_step', '0.5'));
  REF_CFG = { base: Number(await getSetting('referral_base_reward', '1000')) || 1000, step, at: Date.now() };
}
function refRewardsSync(balance) {
  const idx = Math.max(0, LEVEL_TABLE.indexOf(levelFromBalance(balance)));
  const normal = Math.round(REF_CFG.base * Math.pow(1.5, idx));
  return { normal, premium: Math.round(normal * 1.5) };
}
app.use('/api', async (req, res, next) => { try { await loadRefCfg(); } catch (_) {} next(); });
async function refRewardsFor(balance) {
  REF_CFG.at = 0; await loadRefCfg();
  return refRewardsSync(balance);
}
async function _unusedRefRewardsFor(balance) {
  const lv = levelFromBalance(balance);
  const idx = Math.max(0, LEVEL_TABLE.indexOf(lv));
  const step = Number(await getSetting('referral_level_step', '0.5'));
  const mult = 1 + (isNaN(step) ? 0.5 : step) * idx;
  const base = Number(await getSetting('referral_reward', '5000')) || 5000;
  const prem = Number(await getSetting('referral_reward_premium', '25000')) || 25000;
  return { normal: Math.round(base * mult), premium: Math.round(prem * mult) };
}
function levelFromBalance(bal) {
  const n = Number(bal) || 0;
  let lv = LEVEL_TABLE[0];
  for (const row of LEVEL_TABLE) {
    if (n >= row.min) lv = row;
  }
  return lv;
}

// Friendly TON addresses: EQ../UQ.. = mainnet, kQ../0Q.. = testnet. Raw (0:hex) can't be told apart, so it is allowed.
function isTestnetAddr(a) {
  a = String(a || '').trim();
  return /^[A-Za-z0-9_-]{48}$/.test(a) && !'EU'.includes(a[0]);
}
// Max energy = level cap (LEVEL_TABLE.energy) + permanent booster bonus. Follows the player's level up AND down.
// OG Pass lasts 30 days. Active = flag set AND not expired.
const OG_DAYS = 30;
function ogActive(row, now) { return !!row.og_pass && Number(row.og_expires_at) > (now || Math.floor(Date.now() / 1000)); }
function effPerHour(row, now) { return (Number(row.per_hour) || 0) * (ogActive(row, now) ? 2 : 1); }
async function normalizeOg(row, now) {
  if (row.og_pass && !Number(row.og_expires_at)) { // legacy pass without expiry -> 30 days from now
    row.og_expires_at = now + OG_DAYS * 86400;
    await dbx.run('UPDATE users SET og_expires_at = ? WHERE telegram_id = ?', [row.og_expires_at, row.telegram_id]);
  } else if (row.og_pass && Number(row.og_expires_at) <= now) { // expired -> benefits are gone
    row.og_pass = 0;
    await dbx.run('UPDATE users SET og_pass = 0 WHERE telegram_id = ?', [row.telegram_id]);
  }
}
async function grantOgPass(uid) {
  const now = Math.floor(Date.now() / 1000);
  const row = await dbx.get('SELECT og_pass, og_expires_at FROM users WHERE telegram_id = ?', [uid]);
  if (!row) return;
  const base = ogActive(row, now) ? Number(row.og_expires_at) : now;
  await dbx.run('UPDATE users SET og_pass = 1, og_expires_at = ?, spins = spins + 20, updated_at = ? WHERE telegram_id = ?', [base + OG_DAYS * 86400, now, uid]);
}
// Hourly income: credited while online AND offline (offline capped by mining_timer_hrs, default 3h)
async function accrueIncome(row, now) {
  const ph = effPerHour(row, now);
  const prev = Number(row.last_income_at) || 0;
  const last = prev || Number(row.last_active) || now;
  if (ph <= 0) { if (!prev) await dbx.run('UPDATE users SET last_income_at = ? WHERE telegram_id = ?', [now, row.telegram_id]); row.last_income_at = now; return 0; }
  const capSec = Math.max(1, Number(row.mining_timer_hrs) || 3) * 3600;
  const dt = Math.max(0, Math.min(now - last, capSec));
  const gain = Math.floor(ph * dt / 3600);
  if (gain <= 0) return 0; // keep accumulating fractions
  const r = await dbx.run('UPDATE users SET balance = balance + ?, last_income_at = ? WHERE telegram_id = ? AND COALESCE(last_income_at, 0) = ?', [gain, now, row.telegram_id, prev]);
  if (!r.changes) return 0; // another request already credited it
  row.balance = (Number(row.balance) || 0) + gain; row.last_income_at = now;
  return gain;
}
async function takeDailyRefill(uid, row, now) {
  const cap = ogActive(row, now) ? 2 : 1, day = Math.floor(now / 86400);
  await dbx.run('INSERT OR IGNORE INTO task_claims (telegram_id, task_id, day, cnt, last_at) VALUES (?, ?, ?, 0, 0)', [uid, '__refill', day]);
  const r = await dbx.run('UPDATE task_claims SET cnt = cnt + 1, last_at = ? WHERE telegram_id = ? AND task_id = ? AND day = ? AND cnt < ?', [now, uid, '__refill', day, cap]);
  return r.changes > 0;
}
function energyBonusOf(row) { return row.energy_bonus != null ? (Number(row.energy_bonus) || 0) : Math.max(0, (Number(row.max_energy) || 1000) - 1000); }
function effMaxEnergy(row) { return levelFromBalance(row.balance).energy + energyBonusOf(row); }
function regenEnergy(row, now) {
  const dt = Math.max(0, now - (Number(row.last_active) || now));
  return Math.min(effMaxEnergy(row), (Number(row.energy) || 0) + dt);
}
function userToClient(row) {
  return {
    telegramId: row.telegram_id,
    handle: row.first_name || row.handle || row.username || 'Player',
    firstName: row.first_name || '',
    username: row.username || '',
    clan: row.clan,
    level: row.level,
    levelPct: row.level_pct,
    balance: Math.floor(row.balance || 0),
    perTap: row.per_tap,
    perHour: effPerHour(row),
    basePerHour: row.per_hour,
    toLvlUp: row.to_lvl_up,
    energy: Math.min(Math.floor(row.energy || 0), effMaxEnergy(row)),
    maxEnergy: effMaxEnergy(row),
    energyBonus: energyBonusOf(row),
    streakDay: (row.last_claim_daily && Math.floor(Date.now() / 1000) - row.last_claim_daily > 48 * 3600) ? 1 : row.streak_day,
    lastClaimDaily: row.last_claim_daily || 0,
    lastClaimAt: row.last_claim_daily || 0,
    spins: row.spins,
    miningTimerHrs: row.mining_timer_hrs,
    charEmoji: row.char_emoji,
    isPremium: !!row.is_premium,
    isAdmin: ADMIN_TELEGRAM_IDS.includes(row.telegram_id),
    wallet: row.wallet || '',
    ogPass: ogActive(row),
    ogPassExpires: ogActive(row) ? new Date(Number(row.og_expires_at) * 1000).toISOString() : null,
    friendEarnings: row.friend_earnings || 0,
    tapExtra: row.tap_extra || 0,
    photo: row.photo_url || '',
    refReward: refRewardsSync(row.balance).normal,
    refRewardPremium: refRewardsSync(row.balance).premium,
    claimedMilestones: (() => { try { return JSON.parse(row.claimed_milestones || '{}') || {}; } catch (_) { return {}; } })()
  };
}

// ---------- Routes ----------
// health registered after db init

// Auth + full state
app.post('/api/auth', authMiddleware, async (req, res) => {
  const { user, startParam } = req.tg;
  console.log('[auth] ok user', user.id);
  const row = await getOrCreateUser(user, startParam);
  const config = await loadGameConfig();

  // Offline earnings
  const now = Math.floor(Date.now() / 1000);
  const lastActive = row.last_active || now;
  const _bonus = energyBonusOf(row);
  row.energy_bonus = _bonus;
  row.energy = regenEnergy(row, now);
  row.max_energy = effMaxEnergy(row);
  await dbx.run('UPDATE users SET energy = ?, max_energy = ?, energy_bonus = ? WHERE telegram_id = ?', [row.energy, row.max_energy, _bonus, row.telegram_id]);
  await normalizeOg(row, now);
  const gap = now - lastActive;
  const gained = await accrueIncome(row, now);
  let offlineEarned = gap > 120 ? gained : 0; // shown in the "while you were offline" popup
  await dbx.run('UPDATE users SET last_active = ? WHERE telegram_id = ?', [now, row.telegram_id]);

  const ownedCards = await dbx.all('SELECT card_id, level FROM user_cards WHERE telegram_id = ?', [row.telegram_id]);
  const ownedBoosters = await dbx.all('SELECT booster_id, level FROM user_boosters WHERE telegram_id = ?', [row.telegram_id]);
  const doneTasksRows = await dbx.all('SELECT task_id FROM user_tasks WHERE telegram_id = ? AND done = 1', [row.telegram_id]);
  const doneTasks = (doneTasksRows || []).map(t => t.task_id);

  const friends = await dbx.all(`
    SELECT f.friend_id, u.handle, u.username, u.first_name, f.premium, f.joined_at, f.reward, u.og_pass, u.og_expires_at
    FROM friends f LEFT JOIN users u ON u.telegram_id = f.friend_id
    WHERE f.inviter_id = ? ORDER BY f.joined_at DESC LIMIT 50
  `, [row.telegram_id]);

  const leaderboard = await dbx.all(`
    SELECT telegram_id, first_name, username, handle, balance as total, balance, per_hour as hourly,
      CASE WHEN og_pass = 1 AND og_expires_at > ${Math.floor(Date.now() / 1000)} THEN 1 ELSE 0 END AS og,
      (SELECT COUNT(*) FROM friends WHERE inviter_id = users.telegram_id) as friends
    FROM users ORDER BY balance DESC LIMIT 50
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
      tasks: config.tasks.map(t => { const rep = t.section === 'watch'; return { ...t, blockId: t.block_id || '', repeatable: rep, done: rep ? false : doneTasks.includes(t.id) }; }),
      boosters: boostersWithLevel
    },
    ownedCards,
    friends: friends.map(f => ({
      id: f.friend_id,
      name: (f.first_name || f.handle || f.username || ('User ' + f.friend_id)).toString().replace(/^@/, ''),
      premium: !!f.premium,
      reward: Number(f.reward) || 0,
      og: ogActive(f),
      joined: new Date(f.joined_at * 1000).toLocaleDateString()
    })),
    season1Friends: '-',
    season2Friends: friends.length,
    leaderboard: leaderboard.map((p, i) => ({
      id: p.telegram_id,
      telegram_id: p.telegram_id,
      name: (p.first_name || p.handle || p.username || 'Player').toString().replace(/^@/, ''),
      score: Math.floor(Number(p.total != null ? p.total : p.balance) || 0),
      total: Math.floor(Number(p.total != null ? p.total : p.balance) || 0),
      balance: Math.floor(Number(p.total != null ? p.total : p.balance) || 0),
      hourly: (Number(p.hourly) || 0) * (Number(p.og) ? 2 : 1),
      og: !!Number(p.og),
      friends: Number(p.friends) || 0,
      rank: i + 1,
      isYou: Number(p.telegram_id) === Number(row.telegram_id)
    }))
  });
});

// Tap
app.post('/api/tap', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const taps = Math.min(Math.max(parseInt(req.body.taps || 1, 10), 1), 20);
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const nowT = Math.floor(Date.now() / 1000);
  await normalizeOg(row, nowT);
  await accrueIncome(row, nowT);
  const lv = levelFromBalance(row.balance);
  const perTap = Math.max(Number(row.per_tap) || 1, lv.baseTap) + (ogActive(row, nowT) ? 2 : 0);
  const gain = perTap * taps;
  const curEnergy = regenEnergy(row, nowT);
  if (curEnergy < taps) return res.status(400).json({ error: 'Not enough energy', energy: Math.floor(curEnergy) });
  const newMax = effMaxEnergy({ balance: (Number(row.balance) || 0) + gain, max_energy: row.max_energy, energy_bonus: row.energy_bonus });
  await dbx.run('UPDATE users SET energy = ?, max_energy = ?, energy_bonus = ?, balance = balance + ?, last_active = ?, updated_at = ? WHERE telegram_id = ?',
    [Math.min(newMax, curEnergy - taps), newMax, energyBonusOf(row), gain, nowT, nowT, user.id]);
  const updated = await dbx.get('SELECT balance, energy FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ balance: Math.floor(updated.balance), energy: Math.floor(updated.energy), earned: gain });
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
  if (now - (row.last_claim_daily || 0) > 48 * 3600 && row.last_claim_daily) row.streak_day = 1;
  const dayIndex = Math.min(Math.max(0, (row.streak_day || 1) - 1), (config.dailyRewards || [1000]).length - 1);
  const amount = config.dailyRewards[dayIndex] || config.dailyRewards[0] || 1000;

  await dbx.run(`
    UPDATE users SET balance = balance + ?, streak_day = ?,
      last_claim_daily = ?, last_active = ?, updated_at = ?
    WHERE telegram_id = ?
  `, [amount, (row.streak_day || 1) + 1, now, now, now, user.id]);

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

  const paid = await dbx.run('UPDATE users SET balance = balance - ?, per_hour = per_hour + ?, updated_at = ? WHERE telegram_id = ? AND balance >= ?', [card.cost, card.per_hour, Math.floor(Date.now() / 1000), user.id, card.cost]);
  if (!paid.changes) return res.status(400).json({ error: 'Not enough balance' });

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
  let newBonus = energyBonusOf(row);
  if (booster.effect_type === 'energy_limit') newBonus += (booster.effect_value || 500);
  if (booster.effect_type === 'mining_timer') newMining += (booster.effect_value || 1);
  newMaxEnergy = levelFromBalance((Number(row.balance) || 0) - cost).energy + newBonus;
  if (booster.effect_type === 'full_energy') {
    if (!(await takeDailyRefill(user.id, row, Math.floor(Date.now() / 1000)))) return res.status(400).json({ error: 'Daily refill used — come back tomorrow' });
    newEnergy = newMaxEnergy;
  }

  await dbx.run(`
    UPDATE users SET balance = balance - ?, per_tap = ?, max_energy = ?, energy_bonus = ?,
      mining_timer_hrs = ?, energy = ?, updated_at = ?
    WHERE telegram_id = ? AND balance >= ?
  `, [cost, newPerTap, newMaxEnergy, newBonus, newMining, newEnergy, Math.floor(Date.now() / 1000), user.id, cost]);

  await dbx.run(`
    INSERT INTO user_boosters (telegram_id, booster_id, level) VALUES (?, ?, 1)
    ON CONFLICT(telegram_id, booster_id) DO UPDATE SET level = level + 1
  `, [user.id, boosterId]);

  const updated = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ player: userToClient(updated) });
});

// Complete task (atomic: reward can only be paid once)
async function completeTask(req, res) {
  const { user } = req.tg;
  const task = await dbx.get('SELECT * FROM tasks WHERE id = ? AND active = 1', [req.body.taskId]);
  if (!task) return res.status(400).json({ error: 'Task not found' });
  const now = Math.floor(Date.now() / 1000);
  if (task.section === 'daily') return res.status(400).json({ error: 'Use the Daily Check-in' });
  if (task.section === 'watch') {
    // repeatable (ads): per-day cap + cooldown, enforced atomically
    const cooldown = Number(await getSetting('watch_cooldown_sec', '30')) || 30;
    const cap = Number(await getSetting('watch_daily_cap', '20')) || 20;
    const day = Math.floor(now / 86400);
    await dbx.run('INSERT OR IGNORE INTO task_claims (telegram_id, task_id, day, cnt, last_at) VALUES (?, ?, ?, 0, 0)', [user.id, task.id, day]);
    const c = await dbx.run('UPDATE task_claims SET cnt = cnt + 1, last_at = ? WHERE telegram_id = ? AND task_id = ? AND day = ? AND cnt < ? AND last_at <= ?',
      [now, user.id, task.id, day, cap, now - cooldown]);
    if (!c.changes) {
      const st = await dbx.get('SELECT cnt, last_at FROM task_claims WHERE telegram_id = ? AND task_id = ? AND day = ?', [user.id, task.id, day]);
      if (st && st.cnt >= cap) return res.status(429).json({ error: 'Daily limit reached — come back tomorrow' });
      return res.status(429).json({ error: 'Wait ' + Math.max(1, cooldown - (now - (st ? st.last_at : 0))) + 's before the next one' });
    }
  } else {
    const claim = await dbx.run(`INSERT INTO user_tasks (telegram_id, task_id, done) VALUES (?, ?, 1)
      ON CONFLICT(telegram_id, task_id) DO UPDATE SET done = 1 WHERE user_tasks.done = 0`, [user.id, task.id]);
    if (!claim.changes) return res.status(400).json({ error: 'Already completed' });
  }
  const urow = await dbx.get('SELECT og_pass, og_expires_at FROM users WHERE telegram_id = ?', [user.id]);
  const payout = Math.round(task.reward * (urow && ogActive(urow, now) ? 1.1 : 1));
  await dbx.run('UPDATE users SET balance = balance + ?, updated_at = ? WHERE telegram_id = ?', [payout, now, user.id]);
  const full = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ reward: payout, balance: Math.floor(full.balance), repeatable: task.section === 'watch', user: userToClient(full) });
}
app.post('/api/tasks/complete', authMiddleware, completeTask);
app.post('/api/task/complete', authMiddleware, completeTask);

// Spin
app.post('/api/spin', authMiddleware, async (req, res) => {
  const { user } = req.tg;
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });
  if ((Number(row.spins) || 0) <= 0) return res.status(400).json({ error: 'No spins left', spins: 0 });

  const TABLE = [['miss', 24], ['coin', 26], ['battery', 10], ['hand', 5], ['watch', 9], ['bolt', 14], ['wheel', 12]];
  let roll = Math.random() * TABLE.reduce((s, x) => s + x[1], 0), seg = 'miss';
  for (const [id, w] of TABLE) { if ((roll -= w) < 0) { seg = id; break; } }
  const now = Math.floor(Date.now() / 1000);
  const sets = ['spins = spins - 1 + ?', 'updated_at = ?'], par = [seg === 'wheel' ? 2 : 0, now];
  let amount = 0, message = 'No luck this time';
  if (seg === 'coin') {
    const P = [[500, 40], [1000, 30], [2500, 18], [5000, 9], [10000, 3]];
    let r2 = Math.random() * 100; amount = 500;
    for (const [v, w] of P) { if ((r2 -= w) < 0) { amount = v; break; } }
    sets.push('balance = balance + ?'); par.push(amount); message = 'You won ' + amount.toLocaleString('en-US') + ' $SHHHT';
  } else if (seg === 'battery') {
    const nb = energyBonusOf(row) + 100;
    sets.push('energy_bonus = ?', 'max_energy = ?'); par.push(nb, effMaxEnergy({ balance: row.balance, energy_bonus: nb, max_energy: row.max_energy }));
    message = '+100 max energy';
  } else if (seg === 'hand') { sets.push('per_tap = per_tap + 1'); message = '+1 per tap'; }
  else if (seg === 'watch') { sets.push('mining_timer_hrs = CASE WHEN mining_timer_hrs < 12 THEN mining_timer_hrs + 1 ELSE mining_timer_hrs END'); message = '+1 hour offline mining'; }
  else if (seg === 'bolt') { sets.push('energy = max_energy'); message = 'Energy fully refilled'; }
  else if (seg === 'wheel') message = '+2 free spins';

  const sp = await dbx.run(`UPDATE users SET ${sets.join(', ')} WHERE telegram_id = ? AND spins > 0`, [...par, user.id]);
  if (!sp.changes) return res.status(400).json({ error: 'No spins left', spins: 0 });

  const updated = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  res.json({ segment: seg, amount, win: amount, message, balance: Math.floor(updated.balance), spins: updated.spins, user: userToClient(updated) });
});

app.get('/api/user/me', authMiddleware, async (req, res) => {
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const nowM = Math.floor(Date.now() / 1000);
  await normalizeOg(row, nowM);
  await accrueIncome(row, nowM);
  res.json({ user: userToClient(row), player: userToClient(row) });
});

app.get('/api/config', authMiddleware, async (req, res) => {
  const config = await loadGameConfig();
  const rows = await dbx.all('SELECT task_id FROM user_tasks WHERE telegram_id = ? AND done = 1', [req.tg.user.id]);
  const done = (rows || []).map(r => r.task_id);
  config.tasks = config.tasks.map(t => { const rep = t.section === 'watch'; return { ...t, blockId: t.block_id || '', repeatable: rep, done: rep ? false : done.includes(t.id) }; });
  res.json(config);
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
  const { id, section, name, reward, icon, img, link, sort_order, active, block_id } = req.body;
  const taskId = id || ('t' + Date.now());
  if (!name || !section) return res.status(400).json({ error: 'name and section required' });

  await dbx.run(`
    INSERT INTO tasks (id, section, name, reward, icon, img, link, block_id, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      section=excluded.section, name=excluded.name, reward=excluded.reward,
      icon=excluded.icon, img=excluded.img, link=excluded.link, block_id=excluded.block_id,
      sort_order=excluded.sort_order, active=excluded.active
  `, [taskId,
    section || 'social',
    name,
    Number(reward) || 0,
    icon || '⭐',
    img || '',
    link || '',
    String(block_id || '').trim(),
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
    INSERT INTO boosters (id, name, "desc", metric, icon, img, base_cost, effect_type, effect_value, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, "desc"=excluded."desc", metric=excluded.metric,
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
  const amount = Math.floor(Number(req.body.amount)) || 0;
  const wallet = String(req.body.wallet || '').trim();
  if (!wallet || wallet.length < 10) return res.status(400).json({ error: 'Invalid wallet' });
  if (isTestnetAddr(wallet)) return res.status(400).json({ error: 'Testnet wallets are not allowed. Use a Mainnet wallet.' });

  const minAmt = Number(await getSetting('withdrawal_min', '1000')) || 1000;
  if (amount < minAmt) return res.status(400).json({ error: 'Below minimum (' + minAmt + ')' });

  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
  if (!row) return res.status(404).json({ error: 'User not found' });
  if (row.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const isOg = ogActive(row); // never trust client-sent isOg
  const feePct = Number(await getSetting('withdrawal_fee_pct', '5')) || 5;
  const fee = Math.floor(amount * feePct / 100);
  const receive = amount - fee;
  const now = Math.floor(Date.now() / 1000);

  const taken = await dbx.run('UPDATE users SET balance = balance - ?, updated_at = ? WHERE telegram_id = ? AND balance >= ?', [amount, now, user.id, amount]);
  if (!taken.changes) return res.status(400).json({ error: 'Insufficient balance' });
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
  const expected = process.env.ADMIN_PANEL_PASSWORD || '';
  if (!expected) return res.status(503).json({ ok: false, error: 'ADMIN_PANEL_PASSWORD not set on server' });
  const ok = String(req.body?.password || '') === expected;
  if (!ok) return res.status(403).json({ ok: false, error: 'Wrong password' });
  res.json({ ok: true });
});

// Save wallet
app.post('/api/wallet', authMiddleware, async (req, res) => {
  const wallet = String(req.body?.wallet || '').trim();
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  if (isTestnetAddr(wallet)) return res.status(400).json({ error: 'Testnet wallets are not allowed. Use a Mainnet wallet.' });
  await dbx.run('UPDATE users SET wallet = ?, updated_at = ? WHERE telegram_id = ?', [wallet, Math.floor(Date.now() / 1000), req.tg.user.id]);
  res.json({ ok: true, wallet });
});


// ---- User sync ----
app.post('/api/user/sync', authMiddleware, async (req, res) => {
  const id = req.tg.user.id;
  const bal = req.body.balance != null ? Number(req.body.balance) : (req.body.shhhtoshi != null ? Number(req.body.shhhtoshi) : null);
  const energy = req.body.energy != null ? Number(req.body.energy) : null;
  const spins = req.body.spins != null ? Number(req.body.spins) : null;
  const wallet = req.body.wallet_address || req.body.wallet;
  const now = Math.floor(Date.now() / 1000);
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // SECURITY: balance/spins are server-authoritative; only wallet is accepted from the client
  if (wallet && !isTestnetAddr(wallet)) await dbx.run('UPDATE users SET wallet=?, last_active=?, updated_at=? WHERE telegram_id=?', [String(wallet).slice(0, 128), now, now, id]);
  const updated = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [id]);
  res.json({ ok: true, player: userToClient(updated), user: userToClient(updated) });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const q = String(req.query.q || req.query.search || '').trim().replace(/^@/, '');
  let rows;
  if (q) {
    if (/^\d+$/.test(q)) {
      rows = await dbx.all('SELECT * FROM users WHERE telegram_id = ? LIMIT 20', [Number(q)]);
    } else {
      const like = '%' + q + '%';
      rows = await dbx.all(
        "SELECT * FROM users WHERE lower(coalesce(username,'')) LIKE lower(?) OR lower(coalesce(first_name,'')) LIKE lower(?) OR lower(coalesce(handle,'')) LIKE lower(?) ORDER BY balance DESC LIMIT ?",
        [like, like, like, limit]
      );
    }
  } else {
    rows = await dbx.all('SELECT * FROM users ORDER BY balance DESC LIMIT ?', [limit]);
  }
  res.json({
    users: (rows || []).map(r => ({
      telegram_id: r.telegram_id,
      first_name: r.first_name,
      username: r.username,
      handle: r.handle,
      balance: Math.floor(r.balance || 0),
      shhhtoshi: Math.floor(r.balance || 0),
      spins: r.spins
    }))
  });
});

app.post('/api/admin/user/:id/balance', authMiddleware, adminMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  const bal = Number(req.body.balance != null ? req.body.balance : req.body.shhhtoshi);
  if (Number.isNaN(bal)) return res.status(400).json({ error: 'Invalid balance' });
  const now = Math.floor(Date.now() / 1000);
  const lv = levelFromBalance(bal);
  const extraTap = 0;
  await dbx.run(
    'UPDATE users SET balance = ?, per_tap = ?, max_energy = ?, energy = ?, updated_at = ? WHERE telegram_id = ?',
    [bal, lv.baseTap + extraTap, lv.energy, lv.energy, now, id]
  );
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [id]);
  res.json({ ok: true, user: row ? userToClient(row) : null });
});

app.get('/api/admin/user/:id/history', authMiddleware, adminMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  const tasks = await dbx.all('SELECT task_id, done FROM user_tasks WHERE telegram_id = ?', [id]);
  res.json({ tasksCompleted: (tasks || []).filter(t => t.done) });
});

app.post('/api/admin/user/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ ok: true });
});
app.post('/api/admin/user/:id/unban', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ ok: true });
});

const DEFAULT_SPIN_PACKAGES = [
  { id: 'sp15', name: '15 Spins', spins: 15, price_sp: 0, price_stars: 50, price_gram: 0 },
  { id: 'sp100', name: '100 Spins', spins: 100, price_sp: 0, price_stars: 250, price_gram: 0 },
  { id: 'sp330', name: '330 Spins', spins: 330, price_sp: 0, price_stars: 800, price_gram: 0 },
  { id: 'sp1000', name: '1000 Spins', spins: 1000, price_sp: 0, price_stars: 2250, price_gram: 0 },
  { id: 'sp5000', name: '5000 Spins', spins: 5000, price_sp: 0, price_stars: 10000, price_gram: 0 },
  { id: 'sp15000', name: '15000 Spins', spins: 15000, price_sp: 0, price_stars: 25000, price_gram: 0 }
];
async function getSpinPackages() {
  try {
    const raw = await getSetting('spin_packages', '[]');
    let arr = [];
    try { arr = JSON.parse(raw || '[]'); } catch(_) { arr = []; }
    if (!Array.isArray(arr) || arr.length === 0) {
      arr = DEFAULT_SPIN_PACKAGES.slice();
      try { await setSetting('spin_packages', JSON.stringify(arr)); } catch(_) {}
    }
    // normalize stars field for frontend
    return arr.map(p => ({
      ...p,
      stars: Number(p.stars != null ? p.stars : p.price_stars) || 0,
      price_stars: Number(p.price_stars != null ? p.price_stars : p.stars) || 0,
      gram: Number(p.gram != null ? p.gram : p.price_gram) || 0
    }));
  } catch (_) {
    return DEFAULT_SPIN_PACKAGES.map(p => ({ ...p, stars: p.price_stars, gram: p.price_gram }));
  }
}
async function saveSpinPackages(arr) {
  await setSetting('spin_packages', JSON.stringify(arr));
}

app.get('/api/admin/spin-packages', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ packages: await getSpinPackages() });
});
app.get('/api/spin-packages', authMiddleware, async (req, res) => {
  res.json({ packages: await getSpinPackages() });
});
app.post('/api/admin/spin-packages', authMiddleware, adminMiddleware, async (req, res) => {
  const packs = await getSpinPackages();
  const p = {
    id: String(req.body.id || ('spin_' + Date.now())),
    name: String(req.body.name || 'Spins'),
    spins: Number(req.body.spins) || 1,
    price_sp: Number(req.body.price_sp) || 0,
    price_stars: Number(req.body.price_stars) || 0,
    price_gram: Number(req.body.price_gram) || 0
  };
  const i = packs.findIndex(x => x.id === p.id);
  if (i >= 0) packs[i] = p; else packs.push(p);
  await saveSpinPackages(packs);
  res.json({ ok: true, packages: packs });
});
app.delete('/api/admin/spin-packages/:id', authMiddleware, adminMiddleware, async (req, res) => {
  let packs = await getSpinPackages();
  packs = packs.filter(x => x.id !== req.params.id);
  await saveSpinPackages(packs);
  res.json({ ok: true, packages: packs });
});

app.get('/api/leaderboard', authMiddleware, async (req, res) => {
  const rows = await dbx.all(
    "SELECT telegram_id, first_name, username, handle, balance, per_hour as hourly, CASE WHEN og_pass = 1 AND og_expires_at > " + Math.floor(Date.now() / 1000) + " THEN 1 ELSE 0 END AS og, (SELECT COUNT(*) FROM friends WHERE inviter_id = users.telegram_id) as friends FROM users ORDER BY balance DESC LIMIT 50",
    []
  );
  const mapped = (rows || []).map(p => ({
    telegram_id: p.telegram_id,
    first_name: p.first_name,
    name: (p.first_name || p.handle || p.username || 'Player').toString().replace(/^@/, ''),
    balance: Math.floor(p.balance || 0),
    total: Math.floor(p.balance || 0),
    score: Math.floor(p.balance || 0),
    hourly: (p.hourly || 0) * (Number(p.og) ? 2 : 1),
    og: !!Number(p.og),
    friends: p.friends || 0
  }));
  res.json({ users: mapped, leaderboard: mapped });
});


// ---------- Daily check-in reminder (DM via bot) ----------
let reminderRunning = false;
async function sendCheckinReminders() {
  if (reminderRunning) return;
  reminderRunning = true;
  try {
    if (String(await getSetting('checkin_reminder_enabled', '1')) === '0') return;
    const hrs = Number(await getSetting('checkin_reminder_hours', '21')) || 21; // claim opens at 20h
    const now = Math.floor(Date.now() / 1000);
    const rows = await dbx.all(
      `SELECT telegram_id, first_name, handle, streak_day, last_claim_daily FROM users
       WHERE last_claim_daily > 0 AND last_claim_daily <= ? AND last_claim_daily > ?
         AND COALESCE(last_reminder_at, 0) < last_claim_daily
       LIMIT 500`, [now - hrs * 3600, now - 48 * 3600]);
    const webapp = process.env.WEBAPP_URL || '';
    for (const u of rows) {
      // atomic lock: only one instance/run can send the reminder for this claim
      const lock = await dbx.run('UPDATE users SET last_reminder_at = ? WHERE telegram_id = ? AND COALESCE(last_reminder_at, 0) < last_claim_daily', [now, u.telegram_id]);
      if (!lock.changes) continue;
      const streak = Math.max(1, (Number(u.streak_day) || 2) - 1); // streak_day is the NEXT day to claim
      const name = escHtml(u.first_name || u.handle || 'there');
      const text = '⏰ <b>Daily Check-in Reminder</b>\n\n' +
        `Hey ${name}! You haven't claimed your daily reward yet.\n\n` +
        `🔥 Your current streak is <b>${streak} day${streak === 1 ? '' : 's'}</b> — don't lose it!\n\n` +
        '🎁 Open the app and tap Check In to collect your $SHHHT bonus!';
      const kb = webapp ? { inline_keyboard: [[{ text: '🎁 Check In Now', web_app: { url: webapp } }]] } : undefined;
      await tgSend(u.telegram_id, text, kb);
      await new Promise(z => setTimeout(z, 60)); // stay under Telegram's ~30 msg/s
    }
  } catch (e) {
    console.error('checkin reminder job', e);
  } finally {
    reminderRunning = false;
  }
}
function startReminderJob() {
  setTimeout(sendCheckinReminders, 30 * 1000);
  setInterval(sendCheckinReminders, 10 * 60 * 1000);
}

// Start
(async () => {
  try {
    await ensureDb();
    await seedIfEmpty();
    await getSpinPackages(); // seeds default spin packs on first run
    
// ---------- Aliases frontend expects ----------
app.post('/api/user/checkin', authMiddleware, async (req, res) => {
  try {
    const { user } = req.tg;
    const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
    if (!row) return res.status(404).json({ error: 'User not found' });

    const now = Math.floor(Date.now() / 1000);
    if (now - (row.last_claim_daily || 0) < 20 * 3600) {
      return res.status(400).json({ error: 'Already claimed today', check_in: { streak: row.streak_day || 0, lastDay: 'today' } });
    }

    const config = await loadGameConfig();
    const rewards = config.dailyRewards || [2500, 5000, 7500, 10000, 15000, 20000, 30000];
    let streak = Math.max(1, Number(row.streak_day) || 1);
    if (row.last_claim_daily && now - row.last_claim_daily > 48 * 3600) streak = 1;
    const dayIndex = Math.min(streak - 1, rewards.length - 1);
    const amount = rewards[dayIndex] || rewards[0] || 2500;

    await dbx.run(`
      UPDATE users SET balance = balance + ?, streak_day = ?,
        last_claim_daily = ?, last_active = ?, updated_at = ?
      WHERE telegram_id = ?
    `, [amount, streak + 1, now, now, now, user.id]);

    const updated = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
    res.json({
      ok: true,
      reward_given: amount,
      reward: amount,
      amount,
      balance: Math.floor(updated.balance),
      streakDay: updated.streak_day,
      check_in: { streak: updated.streak_day, lastDay: new Date().toISOString().slice(0, 10), claimedDays: [] },
      user: userToClient(updated)
    });
  } catch (e) {
    console.error('checkin', e);
    res.status(500).json({ error: e.message || 'checkin failed' });
  }
});

app.post('/api/stars/invoice', authMiddleware, async (req, res) => {
  try {
    const kind = String(req.body.kind || 'spinpack');
    let stars = 0;
    if (kind === 'ogpass') stars = Number(await getSetting('og_pass_stars_price', '100')) || 100;
    else if (kind === 'spinpack') { const pk = (await getSpinPackages()).find(p => p.id === req.body.packId); stars = pk ? Number(pk.price_stars) : 0; }
    else if (kind === 'incomecard') { const c = await dbx.get('SELECT cost FROM cards WHERE id = ?', [req.body.cardId]); stars = c ? Math.max(1, Math.ceil(c.cost / 100)) : 0; }
    else stars = Number(req.body.stars) || 0;
    const title = kind === 'ogpass' ? 'OG Pass' : kind === 'spinpack' ? 'Spin Pack' : 'Purchase';
    const description = title + ' — ShhhToshi';
    const payload = JSON.stringify({
      kind,
      packId: req.body.packId || null,
      cardId: req.body.cardId || null,
      boost_id: req.body.boost_id || null,
      uid: req.tg.user.id
    });

    // Telegram Stars invoice via Bot API (currency XTR)
    if (BOT_TOKEN && stars > 0) {
      try {
        const body = {
          title: title.slice(0, 32),
          description: description.slice(0, 255),
          payload: payload.slice(0, 128),
          currency: 'XTR',
          prices: [{ label: title.slice(0, 32), amount: Math.max(1, Math.floor(stars)) }]
        };
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await r.json();
        if (data.ok && data.result) {
          return res.json({ invoiceLink: data.result, stars });
        }
        console.error('createInvoiceLink', data);
      } catch (e) {
        console.error('invoice fetch', e);
      }
    }
    // Soft fail so frontend can fall back to SHHHT purchase / grant
    res.json({ invoiceLink: null, skip: true, stars, message: 'Stars invoice unavailable — try again or use balance' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'invoice failed' });
  }
});

app.post('/api/shop/spin-pack', authMiddleware, async (req, res) => {
  try {
    const { user } = req.tg;
    const packId = String(req.body.packId || '');
    const packs = await getSpinPackages();
    const pack = packs.find(p => p.id === packId) || {
      id: packId,
      spins: Number(req.body.spins) || 0,
      price_sp: 0,
      price_stars: Number(req.body.stars) || 0
    };
    const spins = Math.max(0, Number(pack.spins) || Number(req.body.spins) || 0);
    if (spins <= 0) return res.status(400).json({ error: 'Invalid pack' });

    const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [user.id]);
    if (!row) return res.status(404).json({ error: 'User not found' });

    const costSp = Number(pack.price_sp) || 0;
    if (costSp <= 0) return res.status(402).json({ error: 'Pay with Stars — spins are granted automatically after payment' });
    if (costSp > 0 && (row.balance || 0) < costSp) {
      return res.status(400).json({ error: 'Not enough balance' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (costSp > 0) {
      const pd = await dbx.run('UPDATE users SET balance = balance - ?, spins = spins + ?, updated_at = ? WHERE telegram_id = ? AND balance >= ?',
        [costSp, spins, now, user.id, costSp]);
      if (!pd.changes) return res.status(400).json({ error: 'Not enough balance' });
    }
    const updated = await dbx.get('SELECT balance, spins FROM users WHERE telegram_id = ?', [user.id]);
    res.json({ ok: true, spins: updated.spins, balance: Math.floor(updated.balance) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'spin pack failed' });
  }
});

app.post('/api/user/wallet', authMiddleware, async (req, res) => {
  const addr = String(req.body.wallet_address || req.body.wallet || '').trim();
  if (!addr) return res.status(400).json({ error: 'wallet required' });
  if (isTestnetAddr(addr)) return res.status(400).json({ error: 'Testnet wallets are not allowed. Use a Mainnet wallet.' });
  await dbx.run('UPDATE users SET wallet = ?, updated_at = ? WHERE telegram_id = ?',
    [addr, Math.floor(Date.now() / 1000), req.tg.user.id]);
  res.json({ ok: true, wallet: addr });
});


// ---------- Endpoints the frontend calls that were missing ----------
const INTERNAL_SECRET = crypto.createHash('sha256').update('internal:' + BOT_TOKEN).digest('hex');
app.post('/api/internal/payment', async (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  const { charge_id, payload } = req.body || {};
  let p; try { p = JSON.parse(payload); } catch (_) { return res.status(400).json({ error: 'bad payload' }); }
  const seen = await dbx.get('SELECT key FROM settings WHERE key = ?', ['paid_' + charge_id]);
  if (seen) return res.json({ ok: true, duplicate: true });
  await dbx.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['paid_' + charge_id, '1']);
  const now = Math.floor(Date.now() / 1000), uid = Number(p.uid);
  if (p.kind === 'ogpass') await grantOgPass(uid);
  else if (p.kind === 'spinpack') {
    const pk = (await getSpinPackages()).find(x => x.id === p.packId);
    if (pk) await dbx.run('UPDATE users SET spins = spins + ?, updated_at = ? WHERE telegram_id = ?', [Number(pk.spins) || 0, now, uid]);
  } else if (p.kind === 'incomecard' && p.cardId) {
    const c = await dbx.get('SELECT * FROM cards WHERE id = ?', [p.cardId]);
    if (c) {
      await dbx.run('UPDATE users SET per_hour = per_hour + ?, updated_at = ? WHERE telegram_id = ?', [c.per_hour, now, uid]);
      await dbx.run('INSERT INTO user_cards (telegram_id, card_id, level) VALUES (?, ?, 1) ON CONFLICT(telegram_id, card_id) DO UPDATE SET level = user_cards.level + 1', [uid, c.id]);
    }
  }
  res.json({ ok: true });
});
app.post('/api/internal/referral', async (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  const u = (req.body && req.body.user) || {};
  const inviterId = Number(req.body && req.body.inviter_id);
  if (!u.id || !inviterId) return res.status(400).json({ error: 'bad request' });
  const now = Math.floor(Date.now() / 1000);
  const handle = String(u.first_name || u.username || 'Player').slice(0, 32);
  const ins = await dbx.run(`INSERT OR IGNORE INTO users (telegram_id, username, first_name, language_code, is_premium, handle, balance, energy, max_energy, per_tap, last_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1000, 1000, 1, ?, ?, ?)`, [u.id, u.username || null, u.first_name || null, u.language_code || null, u.is_premium ? 1 : 0, handle, now, now, now]);
  // only brand-new players count as referrals (stops farming with old accounts)
  const counted = ins.changes ? await registerReferral(inviterId, u) : false;
  res.json({ ok: true, counted });
});
// Payment is granted by the bot webhook above; confirm just reports current state
app.post('/api/stars/confirm', authMiddleware, async (req, res) => {
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  res.json({ ok: true, user: userToClient(row), player: userToClient(row) });
});
const FRIEND_MILESTONES = { 1: 500, 3: 1500, 5: 3000, 10: 8000, 20: 20000, 50: 50000 };
async function withRefRewards(u, row) {
  const rr = await refRewardsFor(row.balance);
  u.refReward = rr.normal; u.refRewardPremium = rr.premium;
  return u;
}
app.post('/api/friends/collect', authMiddleware, async (req, res) => {
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  const amount = Math.floor(Number(row.friend_earnings) || 0);
  if (amount <= 0) return res.status(400).json({ error: 'Nothing to collect' });
  const r = await dbx.run('UPDATE users SET balance = balance + ?, friend_earnings = friend_earnings - ?, updated_at = ? WHERE telegram_id = ? AND friend_earnings >= ?',
    [amount, amount, Math.floor(Date.now() / 1000), row.telegram_id, amount]);
  if (!r.changes) return res.status(409).json({ error: 'Try again' });
  const u = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [row.telegram_id]);
  res.json({ ok: true, amount, user: await withRefRewards(userToClient(u), u) });
});

let BOT_USERNAME_CACHE = process.env.BOT_USERNAME || '';
async function botUsername() {
  if (BOT_USERNAME_CACHE) return BOT_USERNAME_CACHE.replace('@', '');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then(x => x.json()).catch(() => null);
  if (r && r.ok) BOT_USERNAME_CACHE = r.result.username;
  return BOT_USERNAME_CACHE;
}
app.post('/api/internal/invite-msg', async (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  const { type, file_id, text } = req.body || {};
  const t = ['photo', 'animation', 'video'].includes(type) ? type : 'text';
  await setSetting('invite_message', String(text || '').slice(0, t === 'text' ? 3500 : 1000));
  await setSetting('invite_media_type', t);
  await setSetting('invite_media_id', t === 'text' ? '' : String(file_id || ''));
  res.json({ ok: true });
});
// Prepared share message: admin text/media + inline "Join Me" button (Bot API savePreparedInlineMessage -> WebApp.shareMessage)
app.post('/api/invite/prepare', authMiddleware, async (req, res) => {
  const uid = req.tg.user.id;
  const bot = await botUsername();
  if (!bot) return res.status(500).json({ error: 'Bot username unavailable' });
  const text = (await getSetting('invite_message', DEFAULT_INVITE_MSG)) || DEFAULT_INVITE_MSG;
  const btn = (await getSetting('invite_button_text', 'Join Me')) || 'Join Me';
  const mtype = await getSetting('invite_media_type', 'text');
  const fid = await getSetting('invite_media_id', '');
  const reply_markup = { inline_keyboard: [[{ text: btn, url: `https://t.me/${bot}?start=ref_${uid}` }]] };
  const id = 'invite_' + uid;
  let result;
  if (mtype === 'photo' && fid) result = { type: 'photo', id, photo_file_id: fid, caption: text, parse_mode: 'HTML', reply_markup };
  else if (mtype === 'animation' && fid) result = { type: 'gif', id, gif_file_id: fid, caption: text, parse_mode: 'HTML', reply_markup };
  else if (mtype === 'video' && fid) result = { type: 'video', id, video_file_id: fid, title: btn, caption: text, parse_mode: 'HTML', reply_markup };
  else result = { type: 'article', id, title: btn, description: text.replace(/<[^>]+>/g, '').slice(0, 100), input_message_content: { message_text: text, parse_mode: 'HTML' }, reply_markup };
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/savePreparedInlineMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: uid, result, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true, allow_bot_chats: false })
  }).then(x => x.json()).catch(() => null);
  if (!r || !r.ok) return res.status(502).json({ error: (r && r.description) || 'Could not prepare message' });
  res.json({ ok: true, id: r.result.id });
});
app.post('/api/friends/milestone', authMiddleware, async (req, res) => {
  const need = Number(req.body.need), reward = FRIEND_MILESTONES[need];
  if (!reward) return res.status(400).json({ error: 'Invalid milestone' });
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  const cnt = await dbx.get('SELECT COUNT(*) AS c FROM friends WHERE inviter_id = ?', [row.telegram_id]);
  if (Number(cnt.c) < need) return res.status(400).json({ error: 'Invite more friends' });
  let cm = {}; try { cm = JSON.parse(row.claimed_milestones || '{}') || {}; } catch (_) {}
  const key = 'fm_' + need;
  if (cm[key]) return res.status(400).json({ error: 'Already claimed' });
  cm[key] = true;
  const ok = await dbx.run('UPDATE users SET claimed_milestones = ?, balance = balance + ?, updated_at = ? WHERE telegram_id = ? AND claimed_milestones = ?',
    [JSON.stringify(cm), reward, Math.floor(Date.now() / 1000), row.telegram_id, row.claimed_milestones || '{}']);
  if (!ok.changes) return res.status(409).json({ error: 'Try again' });
  const u = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [row.telegram_id]);
  res.json({ ok: true, reward, user: userToClient(u) });
});
app.get('/api/spin/status', authMiddleware, async (req, res) => {
  const row = await dbx.get('SELECT spins FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  res.json({ spins: row ? row.spins : 0, price: Number(await getSetting('spin_price', '1')) || 1 });
});
app.get('/api/income-cards', authMiddleware, async (req, res) => {
  const cards = await getCards();
  const owned = await dbx.all('SELECT card_id, level FROM user_cards WHERE telegram_id = ?', [req.tg.user.id]);
  res.json({ cards: cards.map(c => { const o = owned.find(x => x.card_id === c.id); return { id: c.id, title: c.name, sp_per_hour: c.per_hour, image_url: c.img || '', category: c.category, name: c.name, per_hour: c.per_hour, perHour: c.per_hour, cost: c.cost, price_sp: c.cost, locked: !!c.locked, img: c.img || '', level: o ? o.level : 0, pay_methods: ['sp'] }; }) });
});
app.post('/api/income-cards/buy', authMiddleware, async (req, res) => {
  const card = await dbx.get('SELECT * FROM cards WHERE id = ? AND active = 1', [req.body.card_id]);
  if (!card || card.locked) return res.status(400).json({ error: 'Card not available' });
  if (req.body.method && req.body.method !== 'sp') return res.status(400).json({ error: 'Use Stars (paid via bot) or balance' });
  const paid = await dbx.run('UPDATE users SET balance = balance - ?, per_hour = per_hour + ?, updated_at = ? WHERE telegram_id = ? AND balance >= ?', [card.cost, card.per_hour, Math.floor(Date.now() / 1000), req.tg.user.id, card.cost]);
  if (!paid.changes) return res.status(400).json({ error: 'Not enough balance' });
  await dbx.run('INSERT INTO user_cards (telegram_id, card_id, level) VALUES (?, ?, 1) ON CONFLICT(telegram_id, card_id) DO UPDATE SET level = user_cards.level + 1', [req.tg.user.id, card.id]);
  const u = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [req.tg.user.id]);
  res.json({ ok: true, balance: Math.floor(u.balance), perHour: u.per_hour, user: userToClient(u) });
});
app.post('/api/settings', authMiddleware, adminMiddleware, async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) if (/^[a-z0-9_]+$/i.test(k) && !k.startsWith('paid_')) await setSetting(k, v);
  res.json({ ok: true });
});
app.post('/api/task/verify-telegram', authMiddleware, async (req, res) => {
  const task = await dbx.get('SELECT * FROM tasks WHERE id = ? AND active = 1', [req.body.taskId]);
  if (!task) return res.status(400).json({ error: 'Task not found' });
  const chat = req.body.chatId || (String(task.link || '').match(/t\.me\/([A-Za-z0-9_]+)/) || [])[1];
  if (!chat) return res.json({ ok: true });
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: String(chat).startsWith('-') || /^\d+$/.test(chat) ? chat : '@' + chat, user_id: req.tg.user.id }) }).then(x => x.json()).catch(() => null);
  if (!r || !r.ok) return res.json({ ok: true, unverified: true }); // bot not admin in chat: can't verify
  if (['left', 'kicked'].includes(r.result.status)) return res.status(400).json({ error: 'Join the channel first' });
  res.json({ ok: true });
});
const TON_TREASURY = process.env.TON_TREASURY || 'UQAimXfztHcVa_bipWpbYWRL5eE217KkdwENqZseXVDDlOWQ';
app.post('/api/ogpass/prepare', authMiddleware, async (req, res) => {
  const uid = req.tg.user.id;
  const row = await dbx.get('SELECT og_pass, og_expires_at FROM users WHERE telegram_id = ?', [uid]);
  if (row && ogActive(row)) return res.status(400).json({ error: 'OG Pass already active' });
  const price = Number(await getSetting('og_pass_gram_price', '5')) || 5;
  const nonce = crypto.randomBytes(6).toString('hex');
  await dbx.run('INSERT INTO ton_orders (nonce, telegram_id, kind, amount_ton, created_at, status) VALUES (?, ?, ?, ?, ?, ?)', [nonce, uid, 'ogpass', price, Math.floor(Date.now() / 1000), 'pending']);
  res.json({ ok: true, nonce, price, address: TON_TREASURY });
});
// Verifies the on-chain transfer (amount + comment containing the nonce) via toncenter before granting
app.post('/api/ogpass/buy', authMiddleware, async (req, res) => {
  const uid = req.tg.user.id;
  const order = await dbx.get('SELECT * FROM ton_orders WHERE nonce = ? AND telegram_id = ?', [String(req.body.nonce || ''), uid]);
  if (!order) return res.status(400).json({ error: 'Order not found' });
  const grantResp = async () => { const u = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [uid]); return res.json({ ok: true, user: userToClient(u) }); };
  if (order.status === 'paid') return grantResp();
  const key = process.env.TONCENTER_API_KEY ? '&api_key=' + process.env.TONCENTER_API_KEY : '';
  const j = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${TON_TREASURY}&limit=40${key}`).then(x => x.json()).catch(() => null);
  if (!j || !j.ok) return res.status(202).json({ pending: true });
  const need = Math.floor(Number(order.amount_ton) * 1e9 * 0.99);
  const tx = (j.result || []).find(t => {
    const m = t.in_msg || {};
    let txt = String(m.message || '');
    try { if (!txt && m.msg_data && m.msg_data.text) txt = Buffer.from(m.msg_data.text, 'base64').toString('utf8'); } catch (_) {}
    return txt.includes(order.nonce) && Number(m.value) >= need;
  });
  if (!tx) return res.status(202).json({ pending: true });
  const claim = await dbx.run("UPDATE ton_orders SET status = 'paid', tx_hash = ? WHERE nonce = ? AND status = 'pending'", [String(tx.transaction_id && tx.transaction_id.hash || ''), order.nonce]);
  if (claim.changes) await grantOgPass(uid);
  return grantResp();
});
app.post('/api/shop-boosts/claim', authMiddleware, async (req, res) => {
  if (req.body.payment_ok) return res.status(402).json({ error: 'Payment not verified' });
  const b = await dbx.get('SELECT * FROM boosters WHERE id = ? AND active = 1', [req.body.boost_id]);
  if (!b) return res.status(400).json({ error: 'Booster not available' });
  const uid = req.tg.user.id, now = Math.floor(Date.now() / 1000), cost = Number(b.base_cost) || 0, v = Number(b.effect_value) || 1;
  const row = await dbx.get('SELECT * FROM users WHERE telegram_id = ?', [uid]);
  const col = { multitap: 'per_tap', energy_limit: 'max_energy', mining_timer: 'mining_timer_hrs' }[b.effect_type];
  const isEn = b.effect_type === 'energy_limit';
  const sets = isEn ? 'max_energy = max_energy + ?, energy_bonus = COALESCE(energy_bonus, max_energy - 1000) + ?' : (col ? `${col} = ${col} + ?` : (b.effect_type === 'full_energy' ? 'energy = max_energy' : null));
  if (!sets) return res.status(400).json({ error: 'Booster not available' });
  if (b.effect_type === 'full_energy' && !(await takeDailyRefill(uid, row, now))) return res.status(400).json({ error: 'Daily refill used — come back tomorrow' });
  const r = await dbx.run(`UPDATE users SET balance = balance - ?, ${sets}, updated_at = ? WHERE telegram_id = ? AND balance >= ?`,
    isEn ? [cost, v, v, now, uid, cost] : (col ? [cost, v, now, uid, cost] : [cost, now, uid, cost]));
  if (!r.changes) return res.status(400).json({ error: 'Not enough balance' });
  await dbx.run('INSERT INTO user_boosters (telegram_id, booster_id, level) VALUES (?, ?, 1) ON CONFLICT(telegram_id, booster_id) DO UPDATE SET level = user_boosters.level + 1', [uid, b.id]);
  res.json({ ok: true });
});

app.get('/api/health', async (req, res) => {
      res.json({ ok: true, ts: Date.now(), db: dbx.isPg() ? 'postgres' : 'sqlite' });
    });
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`SHHHT backend on :${PORT}  db=${dbx.isPg() ? 'postgres/supabase' : 'sqlite'}`);
      startReminderJob();
      console.log(`Admin IDs: ${ADMIN_TELEGRAM_IDS.join(', ') || '(none set)'}`);
    });
  } catch (e) {
    console.error('Failed to start', e);
    process.exit(1);
  }
})();
