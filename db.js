/**
 * DB adapter: Postgres (Supabase) when DATABASE_URL is set, else SQLite.
 * All methods are async. Placeholders use `?` — converted to $1,$2 for PG.
 */
require('dotenv').config();
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = !!(DATABASE_URL && process.env.USE_SQLITE !== 'true');

let sqlite = null;
let pool = null;

function toPgParams(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => '$' + (++n));
}

/** Soft-translate common SQLite-isms for Postgres */
function adaptSql(sql) {
  if (!USE_PG) return sql;
  let s = sql;
  // INSERT OR IGNORE → ON CONFLICT DO NOTHING (basic cases)
  s = s.replace(/INSERT OR IGNORE INTO (\w+)/gi, 'INSERT INTO $1');
  // strftime in DEFAULT already handled in schema
  return s;
}

async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 10,
    });
    // quick ping
    await pool.query('SELECT 1');
    console.log('[db] Connected to Postgres / Supabase');
    await migratePg();
    return { driver: 'postgres' };
  }

  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(__dirname, 'shhht.db'));
  sqlite.pragma('journal_mode = WAL');
  console.log('[db] Using SQLite shhht.db');
  return { driver: 'sqlite' };
}

async function migratePg() {
  // Extra columns if schema was older
  const alters = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet TEXT DEFAULT ''",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS og_pass INT DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_earnings REAL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS tap_extra INT DEFAULT 0',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_milestones TEXT DEFAULT '{}'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_code TEXT DEFAULT ''",
  ];
  for (const sql of alters) {
    try { await pool.query(sql); } catch (e) { /* ignore */ }
  }
}

async function get(sql, params = []) {
  if (USE_PG) {
    const q = toPgParams(adaptSql(sql));
    const r = await pool.query(q, params);
    return r.rows[0] || undefined;
  }
  return sqlite.prepare(sql).get(...params);
}

async function all(sql, params = []) {
  if (USE_PG) {
    const q = toPgParams(adaptSql(sql));
    const r = await pool.query(q, params);
    return r.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

async function run(sql, params = []) {
  if (USE_PG) {
    let s = adaptSql(sql);
    // SQLite INSERT OR IGNORE
    if (/INSERT OR IGNORE INTO/i.test(sql)) {
      // try to add ON CONFLICT DO NOTHING if not present
      s = sql.replace(/INSERT OR IGNORE INTO/i, 'INSERT INTO');
      if (!/ON CONFLICT/i.test(s)) s += ' ON CONFLICT DO NOTHING';
      s = toPgParams(s);
    } else {
      s = toPgParams(s);
    }
    const r = await pool.query(s, params);
    return { changes: r.rowCount || 0, lastInsertRowid: r.rows?.[0]?.id };
  }
  const info = sqlite.prepare(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

async function exec(sql) {
  if (USE_PG) {
    await pool.query(sql);
    return;
  }
  sqlite.exec(sql);
}

function isPg() {
  return USE_PG;
}

/** For INSERT OR IGNORE helpers */
async function insertIgnore(table, columns, values) {
  const cols = columns.join(', ');
  const ph = columns.map(() => '?').join(', ');
  if (USE_PG) {
    const sql = `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT DO NOTHING`;
    return run(sql, values);
  }
  return run(`INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${ph})`, values);
}

module.exports = { init, get, all, run, exec, isPg, insertIgnore, USE_PG };
