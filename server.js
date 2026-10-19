import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.YOA_DB || path.join(DATA_DIR, 'yoa.db');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TIME_ZONE = 'Asia/Shanghai';
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 16 * 1024;

// 访问密钥只以 scrypt 哈希形式落库；明文只在首次初始化时短暂出现在内存里。
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16, maxmem: 64 * 1024 * 1024 };
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;
const BOOTSTRAP_KEY = process.env.YOA_LOGIN_KEY || 'admin';
const MIN_FOCUS_SECONDS = 1;
const MAX_FOCUS_SECONDS = 7200;
const MIN_RECORDED_SECONDS = 5;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date TEXT NOT NULL,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_plans_date ON plans (plan_date, id);

  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkin_date TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recurring_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    rule TEXT NOT NULL,
    weekdays TEXT NOT NULL DEFAULT '',
    paused INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    end_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recurring_completions (
    recurring_id INTEGER NOT NULL REFERENCES recurring_plans (id) ON DELETE CASCADE,
    occurrence_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (recurring_id, occurrence_date)
  );

  CREATE TABLE IF NOT EXISTS recurring_skips (
    recurring_id INTEGER NOT NULL REFERENCES recurring_plans (id) ON DELETE CASCADE,
    occurrence_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (recurring_id, occurrence_date)
  );

  CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_date TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ends_at TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    planned_seconds INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_focus_date ON focus_sessions (session_date);
`);

// 老数据库平滑升级：补齐专注会话新增的列，并把历史记录视为已完成。
function ensureColumn(table, name, definition) {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all();
  if (rows.some((row) => row.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn('focus_sessions', 'started_at', 'started_at TEXT');
ensureColumn('focus_sessions', 'ends_at', 'ends_at TEXT');
ensureColumn('focus_sessions', 'status', "status TEXT NOT NULL DEFAULT 'done'");
ensureColumn('focus_sessions', 'planned_seconds', 'planned_seconds INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_focus_status ON focus_sessions (status, ends_at);
  UPDATE focus_sessions SET started_at = created_at WHERE started_at IS NULL;
  UPDATE focus_sessions SET ends_at = created_at WHERE ends_at IS NULL;
  UPDATE focus_sessions
     SET planned_seconds = duration_seconds
   WHERE planned_seconds = 0 AND status = 'done';
`);

const statements = {
  insertSession: db.prepare(
    'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)'
  ),
  findSession: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteAllSessions: db.prepare('DELETE FROM sessions'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  getConfig: db.prepare('SELECT value FROM app_config WHERE key = ?'),
  setConfig: db.prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `),

  listPlans: db.prepare(
    'SELECT * FROM plans WHERE plan_date = ? ORDER BY completed ASC, id ASC'
  ),
  findPlan: db.prepare('SELECT * FROM plans WHERE id = ? AND plan_date = ?'),
  insertPlan: db.prepare(
    'INSERT INTO plans (plan_date, title, completed, created_at, updated_at) VALUES (?, ?, 0, ?, ?)'
  ),
  updatePlan: db.prepare(
    'UPDATE plans SET completed = ?, updated_at = ? WHERE id = ? AND plan_date = ?'
  ),
  deletePlan: db.prepare('DELETE FROM plans WHERE id = ? AND plan_date = ?'),

  listRecurring: db.prepare(
    'SELECT * FROM recurring_plans ORDER BY paused ASC, id ASC'
  ),
  findRecurring: db.prepare('SELECT * FROM recurring_plans WHERE id = ?'),
  insertRecurring: db.prepare(`
    INSERT INTO recurring_plans (title, rule, weekdays, paused, start_date, end_date, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)
  `),
  updateRecurring: db.prepare(
    'UPDATE recurring_plans SET title = ?, paused = ?, end_date = ?, updated_at = ? WHERE id = ?'
  ),
  deleteRecurring: db.prepare('DELETE FROM recurring_plans WHERE id = ?'),

  listCompletions: db.prepare(
    'SELECT recurring_id FROM recurring_completions WHERE occurrence_date = ?'
  ),
  insertCompletion: db.prepare(
    'INSERT OR IGNORE INTO recurring_completions (recurring_id, occurrence_date, created_at) VALUES (?, ?, ?)'
  ),
  deleteCompletion: db.prepare(
    'DELETE FROM recurring_completions WHERE recurring_id = ? AND occurrence_date = ?'
  ),
  listSkips: db.prepare('SELECT recurring_id FROM recurring_skips WHERE occurrence_date = ?'),
  insertSkip: db.prepare(
    'INSERT OR IGNORE INTO recurring_skips (recurring_id, occurrence_date, created_at) VALUES (?, ?, ?)'
  ),
  deleteSkip: db.prepare(
    'DELETE FROM recurring_skips WHERE recurring_id = ? AND occurrence_date = ?'
  ),

  findCheckin: db.prepare('SELECT * FROM checkins WHERE checkin_date = ?'),
  insertCheckin: db.prepare(
    'INSERT OR IGNORE INTO checkins (checkin_date, created_at) VALUES (?, ?)'
  ),
  listCheckinDates: db.prepare(
    'SELECT checkin_date FROM checkins ORDER BY checkin_date DESC LIMIT 400'
  ),

  sumFocus: db.prepare(
    "SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM focus_sessions WHERE session_date = ? AND status = 'done'"
  ),
  insertFocus: db.prepare(`
    INSERT INTO focus_sessions (session_date, duration_seconds, created_at, started_at, ends_at, status, planned_seconds)
    VALUES (?, 0, ?, ?, ?, 'running', ?)
  `),
  findRunningFocus: db.prepare(
    "SELECT * FROM focus_sessions WHERE status = 'running' ORDER BY id DESC LIMIT 1"
  ),
  findFocus: db.prepare('SELECT * FROM focus_sessions WHERE id = ?'),
  listExpiredFocus: db.prepare(
    "SELECT * FROM focus_sessions WHERE status = 'running' AND ends_at <= ?"
  ),
  settleFocus: db.prepare(
    "UPDATE focus_sessions SET status = ?, duration_seconds = ? WHERE id = ? AND status = 'running'"
  ),
};

const htmlDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function todayKey() {
  return htmlDateFormatter.format(new Date());
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shiftDate(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function weekdayOf(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function parseWeekdays(value) {
  const text = String(value || '').trim();
  if (!text) return [];

  return text
    .split(',')
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

function sortWeekdays(days) {
  const unique = [...new Set(days)];
  return WEEKDAY_ORDER.filter((day) => unique.includes(day));
}

function weekdaysLabel(days) {
  const sorted = sortWeekdays(days);

  if (sorted.length === 7) return '每天';
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((day) => sorted.includes(day))) {
    return '工作日';
  }
  if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) return '周末';

  return `每周${sorted.map((day) => WEEKDAY_LABELS[day]).join('、')}`;
}

function recurrenceLabel(row) {
  if (row.rule === 'daily') return '每天';
  if (row.rule === 'weekly') return weekdaysLabel(parseWeekdays(row.weekdays));
  return '重复';
}

function recurringDueOn(row, dateKey) {
  if (!row) return false;
  if (row.paused) return false;
  if (row.start_date > dateKey) return false;
  if (row.end_date && row.end_date < dateKey) return false;
  if (row.rule === 'daily') return true;
  if (row.rule === 'weekly') {
    return parseWeekdays(row.weekdays).includes(weekdayOf(dateKey));
  }
  return false;
}

function computeStreak(today) {
  const dates = new Set(statements.listCheckinDates.all().map((row) => row.checkin_date));
  let cursor = dates.has(today) ? today : shiftDate(today, -1);
  let streak = 0;

  while (dates.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  return streak;
}

/* ------------------------------------------------------------------ */
/* 访问密钥：scrypt 哈希                                                */
/* ------------------------------------------------------------------ */

async function createVerifier(key) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const derived = await scryptAsync(String(key), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

async function verifyKey(key, verifier) {
  const parts = String(verifier || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 1024 || n > 65536) return false;
  if (!Number.isInteger(r) || r < 1 || r > 16) return false;
  if (!Number.isInteger(p) || p < 1 || p > 4) return false;

  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(String(key), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: SCRYPT.maxmem,
  });

  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

async function ensureCredential() {
  const row = statements.getConfig.get('auth.password');
  if (row && row.value) return { created: false };

  const verifier = await createVerifier(BOOTSTRAP_KEY);
  statements.setConfig.run('auth.password', verifier, nowIso());
  // 旧的明文密钥时代签发的会话一并作废，避免历史 Cookie 继续可用。
  statements.deleteAllSessions.run();
  return { created: true, fromEnv: Boolean(process.env.YOA_LOGIN_KEY) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* 专注会话：服务端权威计时                                             */
/* ------------------------------------------------------------------ */

function focusSessionPayload(row) {
  if (!row) return null;
  const endsAt = Date.parse(row.ends_at);
  return {
    id: row.id,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    plannedSeconds: Number(row.planned_seconds) || 0,
    remainingSeconds: Number.isFinite(endsAt)
      ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      : 0,
  };
}

function settleFocusRow(row, mode, stoppedAtMs) {
  const planned = Number(row.planned_seconds) || 0;
  const startedMs = Date.parse(row.started_at);
  const endsMs = Date.parse(row.ends_at);

  if (mode === 'complete') {
    statements.settleFocus.run('done', planned, row.id);
    return { id: row.id, status: 'done', durationSeconds: planned };
  }

  const reference = Number.isFinite(stoppedAtMs) ? stoppedAtMs : Date.now();
  const bounded = Math.min(reference, Number.isFinite(endsMs) ? endsMs : reference);
  const elapsed = Number.isFinite(startedMs)
    ? Math.max(0, Math.floor((bounded - startedMs) / 1000))
    : 0;
  const duration = Math.min(planned, elapsed);

  if (duration < MIN_RECORDED_SECONDS) {
    statements.settleFocus.run('aborted', 0, row.id);
    return { id: row.id, status: 'aborted', durationSeconds: 0 };
  }

  statements.settleFocus.run('done', duration, row.id);
  return { id: row.id, status: 'done', durationSeconds: duration };
}

function settleExpiredFocus() {
  const rows = statements.listExpiredFocus.all(nowIso());
  for (const row of rows) settleFocusRow(row, 'complete');
  return rows.length;
}

function currentFocusSession() {
  settleExpiredFocus();
  return focusSessionPayload(statements.findRunningFocus.get());
}

/* ------------------------------------------------------------------ */
/* 仪表盘                                                              */
/* ------------------------------------------------------------------ */

const SOURCE_ORDER = { once: 0, recurring: 1 };

function comparePlanEntries(a, b) {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  if (a.source !== b.source) return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  return a.id - b.id;
}

function buildPlanEntries(today) {
  const once = statements.listPlans.all(today).map((row) => ({
    key: `once:${row.id}`,
    id: row.id,
    source: 'once',
    title: row.title,
    completed: Boolean(row.completed),
    recurrence: null,
    recurrenceLabel: '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const completedToday = new Set(
    statements.listCompletions.all(today).map((row) => row.recurring_id)
  );
  const skippedToday = new Set(statements.listSkips.all(today).map((row) => row.recurring_id));

  const recurring = [];
  for (const row of statements.listRecurring.all()) {
    if (!recurringDueOn(row, today)) continue;
    if (skippedToday.has(row.id)) continue;

    const weekdays = parseWeekdays(row.weekdays);
    recurring.push({
      key: `rec:${row.id}`,
      id: row.id,
      source: 'recurring',
      title: row.title,
      completed: completedToday.has(row.id),
      recurrence:
        row.rule === 'weekly' ? { rule: 'weekly', weekdays } : { rule: 'daily' },
      recurrenceLabel: recurrenceLabel(row),
      startDate: row.start_date,
      endDate: row.end_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  return [...once, ...recurring].sort(comparePlanEntries);
}

function buildRecurringOverview(today) {
  const completedToday = new Set(
    statements.listCompletions.all(today).map((row) => row.recurring_id)
  );
  const skippedToday = new Set(statements.listSkips.all(today).map((row) => row.recurring_id));

  return statements.listRecurring.all().map((row) => ({
    id: row.id,
    title: row.title,
    rule: row.rule,
    weekdays: parseWeekdays(row.weekdays),
    recurrenceLabel: recurrenceLabel(row),
    paused: Boolean(row.paused),
    startDate: row.start_date,
    endDate: row.end_date,
    dueToday: recurringDueOn(row, today),
    completedToday: completedToday.has(row.id),
    skippedToday: skippedToday.has(row.id),
    ended: Boolean(row.end_date && row.end_date < today),
  }));
}

function buildDashboard() {
  settleExpiredFocus();

  const today = todayKey();
  const plans = buildPlanEntries(today);
  const completed = plans.filter((plan) => plan.completed).length;
  const checkinRow = statements.findCheckin.get(today);
  const focusSeconds = Number(statements.sumFocus.get(today)?.total || 0);
  const activeFocus = focusSessionPayload(statements.findRunningFocus.get());

  return {
    today,
    plans,
    recurring: buildRecurringOverview(today),
    focus: activeFocus,
    stats: {
      total: plans.length,
      completed,
      focusMinutes: Math.round(focusSeconds / 60),
      checkedIn: Boolean(checkinRow),
      streak: computeStreak(today),
    },
    checkin: checkinRow
      ? {
          date: checkinRow.checkin_date,
          createdAt: checkinRow.created_at,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(cookieHeader = '') {
  const cookies = {};

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

function requestIsSecure(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return forwarded === 'https' || Boolean(req.socket.encrypted);
}

function sessionCookie(token, req) {
  const parts = [
    `yoa_session=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];

  if (requestIsSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req) {
  const parts = ['yoa_session=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (requestIsSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie).yoa_session;
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;

  const tokenHash = sha256(token);
  const row = statements.findSession.get(tokenHash);
  if (!row) return null;

  if (Date.parse(row.expires_at) <= Date.now()) {
    statements.deleteSession.run(tokenHash);
    return null;
  }

  return { tokenHash, expiresAt: row.expires_at };
}

function createSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  statements.insertSession.run(sha256(token), createdAt, expiresAt);
  return sessionCookie(token, req);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, '请求内容过大');
    }
    chunks.push(chunk);
  }

  if (size === 0) return {};

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new HttpError(400, '请求格式不正确');
  }
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: '登录已失效，请重新登录', code: 'UNAUTHORIZED' });
    return null;
  }
  return session;
}

/* 跨站请求防护：带 Cookie 的写操作必须来自同源页面。 */
function assertSameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;

  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'same-origin' || site === 'none') return;
  if (site === 'cross-site' || site === 'same-site') {
    throw new HttpError(403, '请求来源不被允许');
  }

  const origin = req.headers.origin;
  if (!origin) return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, '请求来源不被允许');
  }

  const expected = String(
    req.headers['x-forwarded-host'] || req.headers.host || ''
  )
    .split(',')[0]
    .trim();

  if (!expected || originHost !== expected) {
    throw new HttpError(403, '请求来源不被允许');
  }
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  return false;
}

function noteFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }

  if (loginAttempts.size > 2000) {
    for (const [key, value] of loginAttempts) {
      if (value.resetAt <= now) loginAttempts.delete(key);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 输入校验                                                            */
/* ------------------------------------------------------------------ */

function normalizeTitle(value) {
  const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!title) throw new HttpError(400, '计划内容不能为空');
  if ([...title].length > 120) throw new HttpError(400, '计划内容不能超过 120 个字');
  return title;
}

function requireDateKey(value, message) {
  if (!isDateKey(value)) throw new HttpError(400, message);
  return value;
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return [];
  const set = new Set();
  for (const item of value) {
    const day = Number(item);
    if (Number.isInteger(day) && day >= 0 && day <= 6) set.add(day);
  }
  return sortWeekdays([...set]);
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/sw.js', { file: 'sw.js', type: 'text/javascript; charset=utf-8' }],
  ['/manifest.webmanifest', { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
  ['/icon-192.png', { file: 'icon-192.png', type: 'image/png' }],
  ['/icon-512.png', { file: 'icon-512.png', type: 'image/png' }],
  ['/apple-touch-icon.png', { file: 'apple-touch-icon.png', type: 'image/png' }],
  ['/badge-96.png', { file: 'badge-96.png', type: 'image/png' }],
]);

function serveStatic(req, res, pathname) {
  const asset = staticFiles.get(pathname);
  if (!asset) return false;

  const filePath = path.join(PUBLIC_DIR, asset.file);

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: '页面不存在' });
      return;
    }

    const headers = {
      'Content-Type': asset.type,
      'Content-Length': stats.size,
      'Cache-Control':
        pathname === '/' || pathname.endsWith('.html') || pathname === '/sw.js'
          ? 'no-cache'
          : 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

    if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  return true;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function parsePlanId(pathname) {
  const match = /^\/api\/plans\/(\d+)$/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseRecurringId(pathname) {
  const match = /^\/api\/recurring-plans\/(\d+)$/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseRecurringOccurrenceId(pathname) {
  const match = /^\/api\/recurring-plans\/(\d+)\/occurrence$/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseRecurringSkipId(pathname) {
  const match = /^\/api\/recurring-plans\/(\d+)\/skip$/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseFocusId(pathname) {
  const match = /^\/api\/focus-sessions\/(\d+)$/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function handleApi(req, res, pathname) {
  assertSameOrigin(req);

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, time: nowIso() });
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const limitedFor = loginRateLimited(ip);

    if (limitedFor) {
      sendJson(
        res,
        429,
        { error: '尝试次数过多，请稍后再试', retryAfter: limitedFor },
        { 'Retry-After': String(limitedFor) }
      );
      return;
    }

    const body = await readJson(req);
    if (
      typeof body.key !== 'string' ||
      body.key.length === 0 ||
      body.key.length > MAX_KEY_LENGTH
    ) {
      throw new HttpError(400, '请输入访问密钥');
    }

    const verifier = statements.getConfig.get('auth.password')?.value;
    const valid = verifier ? await verifyKey(body.key, verifier) : false;

    if (!valid) {
      noteFailedLogin(ip);
      await delay(250);
      sendJson(res, 401, { error: '访问密钥不正确' });
      return;
    }

    loginAttempts.delete(ip);
    statements.pruneSessions.run(nowIso());
    const cookie = createSession(req, res);

    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const session = getSession(req);
    if (session) statements.deleteSession.run(session.tokenHash);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
    return;
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    sendJson(res, 200, {
      authenticated: Boolean(getSession(req)),
      today: todayKey(),
    });
    return;
  }

  if (pathname === '/api/auth/key' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    const ip = clientIp(req);
    const limitedFor = loginRateLimited(ip);
    if (limitedFor) {
      sendJson(
        res,
        429,
        { error: '尝试次数过多，请稍后再试', retryAfter: limitedFor },
        { 'Retry-After': String(limitedFor) }
      );
      return;
    }

    const body = await readJson(req);
    const currentKey = typeof body.currentKey === 'string' ? body.currentKey : '';
    const newKey = typeof body.newKey === 'string' ? body.newKey : '';

    if (currentKey.length === 0 || currentKey.length > MAX_KEY_LENGTH) {
      throw new HttpError(400, '请输入当前访问密钥');
    }

    const verifier = statements.getConfig.get('auth.password')?.value;
    const valid = verifier ? await verifyKey(currentKey, verifier) : false;

    if (!valid) {
      noteFailedLogin(ip);
      await delay(250);
      throw new HttpError(401, '当前访问密钥不正确');
    }

    if (newKey.length < MIN_KEY_LENGTH) {
      throw new HttpError(400, `新密钥至少需要 ${MIN_KEY_LENGTH} 位`);
    }
    if (newKey.length > MAX_KEY_LENGTH) {
      throw new HttpError(400, `新密钥不能超过 ${MAX_KEY_LENGTH} 位`);
    }
    if (newKey === currentKey) {
      throw new HttpError(400, '新密钥不能与当前密钥相同');
    }

    const nextVerifier = await createVerifier(newKey);
    statements.setConfig.run('auth.password', nextVerifier, nowIso());
    statements.deleteAllSessions.run();
    loginAttempts.delete(ip);

    const cookie = createSession(req, res);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    return;
  }

  if (pathname === '/api/dashboard' && req.method === 'GET') {
    if (!requireSession(req, res)) return;
    sendJson(res, 200, buildDashboard());
    return;
  }

  if (pathname === '/api/plans' && req.method === 'POST') {
    if (!requireSession(req, res)) return;
    const body = await readJson(req);
    const title = normalizeTitle(body.title);
    const timestamp = nowIso();
    statements.insertPlan.run(todayKey(), title, timestamp, timestamp);
    sendJson(res, 201, buildDashboard());
    return;
  }

  if (pathname === '/api/recurring-plans' && req.method === 'POST') {
    if (!requireSession(req, res)) return;
    const body = await readJson(req);
    const title = normalizeTitle(body.title);
    const rule = body.rule === 'weekly' ? 'weekly' : body.rule === 'daily' ? 'daily' : null;

    if (!rule) throw new HttpError(400, '重复方式不正确');

    const weekdays = rule === 'weekly' ? normalizeWeekdays(body.weekdays) : [];
    if (rule === 'weekly' && weekdays.length === 0) {
      throw new HttpError(400, '请至少选择一个重复的星期');
    }

    const startDate = todayKey();
    const endDate = body.endDate
      ? requireDateKey(body.endDate, '结束日期不正确')
      : null;

    if (endDate && endDate < startDate) {
      throw new HttpError(400, '结束日期不能早于今天');
    }

    const timestamp = nowIso();
    statements.insertRecurring.run(
      title,
      rule,
      weekdays.join(','),
      startDate,
      endDate,
      timestamp,
      timestamp
    );

    sendJson(res, 201, buildDashboard());
    return;
  }

  const recurringId = parseRecurringId(pathname);
  if (recurringId && req.method === 'PATCH') {
    if (!requireSession(req, res)) return;
    const row = statements.findRecurring.get(recurringId);
    if (!row) throw new HttpError(404, '未找到这条重复计划');

    const body = await readJson(req);
    let title = row.title;
    if (body.title !== undefined) title = normalizeTitle(body.title);

    let paused = Boolean(row.paused);
    if (typeof body.paused === 'boolean') paused = body.paused;

    let endDate = row.end_date;
    if (body.endDate === null || body.endDate === '') {
      endDate = null;
    } else if (body.endDate !== undefined) {
      endDate = requireDateKey(body.endDate, '结束日期不正确');
      if (endDate < row.start_date) {
        throw new HttpError(400, '结束日期不能早于开始日期');
      }
    }

    statements.updateRecurring.run(title, paused ? 1 : 0, endDate, nowIso(), recurringId);
    sendJson(res, 200, buildDashboard());
    return;
  }

  if (recurringId && req.method === 'DELETE') {
    if (!requireSession(req, res)) return;
    const result = statements.deleteRecurring.run(recurringId);
    if (result.changes === 0) throw new HttpError(404, '未找到这条重复计划');
    sendJson(res, 200, buildDashboard());
    return;
  }

  const occurrenceId = parseRecurringOccurrenceId(pathname);
  if (occurrenceId && req.method === 'PATCH') {
    if (!requireSession(req, res)) return;
    const row = statements.findRecurring.get(occurrenceId);
    if (!row) throw new HttpError(404, '未找到这条重复计划');

    const today = todayKey();
    if (!recurringDueOn(row, today)) {
      throw new HttpError(409, '这条重复计划今天不需要执行');
    }

    const body = await readJson(req);
    if (typeof body.completed !== 'boolean') {
      throw new HttpError(400, '完成状态不正确');
    }

    if (body.completed) {
      statements.deleteSkip.run(occurrenceId, today);
      statements.insertCompletion.run(occurrenceId, today, nowIso());
    } else {
      statements.deleteCompletion.run(occurrenceId, today);
    }

    sendJson(res, 200, buildDashboard());
    return;
  }

  const skipId = parseRecurringSkipId(pathname);
  if (skipId && req.method === 'POST') {
    if (!requireSession(req, res)) return;
    const row = statements.findRecurring.get(skipId);
    if (!row) throw new HttpError(404, '未找到这条重复计划');

    const body = await readJson(req);
    const today = todayKey();

    if (body.skipped === false) {
      statements.deleteSkip.run(skipId, today);
    } else {
      if (!recurringDueOn(row, today)) {
        throw new HttpError(409, '这条重复计划今天不需要执行');
      }
      statements.deleteCompletion.run(skipId, today);
      statements.insertSkip.run(skipId, today, nowIso());
    }

    sendJson(res, 200, buildDashboard());
    return;
  }

  const planId = parsePlanId(pathname);
  if (planId && req.method === 'PATCH') {
    if (!requireSession(req, res)) return;
    const today = todayKey();
    const plan = statements.findPlan.get(planId, today);
    if (!plan) throw new HttpError(404, '未找到这条计划');

    const body = await readJson(req);
    if (typeof body.completed !== 'boolean') {
      throw new HttpError(400, '完成状态不正确');
    }

    statements.updatePlan.run(body.completed ? 1 : 0, nowIso(), planId, today);
    sendJson(res, 200, buildDashboard());
    return;
  }

  if (planId && req.method === 'DELETE') {
    if (!requireSession(req, res)) return;
    const result = statements.deletePlan.run(planId, todayKey());
    if (result.changes === 0) throw new HttpError(404, '未找到这条计划');
    sendJson(res, 200, buildDashboard());
    return;
  }

  if (pathname === '/api/checkins' && req.method === 'POST') {
    if (!requireSession(req, res)) return;
    const today = todayKey();
    statements.insertCheckin.run(today, nowIso());
    sendJson(res, 200, buildDashboard());
    return;
  }

  if (pathname === '/api/focus-sessions' && req.method === 'POST') {
    if (!requireSession(req, res)) return;
    const body = await readJson(req);
    const durationSeconds = Number(body.durationSeconds);

    if (
      !Number.isInteger(durationSeconds) ||
      durationSeconds < MIN_FOCUS_SECONDS ||
      durationSeconds > MAX_FOCUS_SECONDS
    ) {
      throw new HttpError(400, '专注时长不正确');
    }

    settleExpiredFocus();

    // 同一时间只保留一个正在进行的会话：新会话开始前结算旧的。
    const existing = statements.findRunningFocus.get();
    if (existing) settleFocusRow(existing, 'abort', Date.now());

    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + durationSeconds * 1000);
    const result = statements.insertFocus.run(
      todayKey(),
      startedAt.toISOString(),
      startedAt.toISOString(),
      endsAt.toISOString(),
      durationSeconds
    );

    const row = statements.findFocus.get(Number(result.lastInsertRowid));
    sendJson(res, 201, {
      session: focusSessionPayload(row),
      settled: null,
      dashboard: buildDashboard(),
    });
    return;
  }

  if (pathname === '/api/focus-sessions/active' && req.method === 'GET') {
    if (!requireSession(req, res)) return;
    sendJson(res, 200, {
      session: currentFocusSession(),
      settled: null,
      dashboard: buildDashboard(),
    });
    return;
  }

  const focusId = parseFocusId(pathname);
  if (focusId && req.method === 'POST') {
    if (!requireSession(req, res)) return;
    const row = statements.findFocus.get(focusId);
    if (!row) throw new HttpError(404, '未找到这次专注记录');

    const body = await readJson(req);
    const action = body.action === 'abort' ? 'abort' : 'complete';
    let stoppedAtMs = Date.now();

    if (action === 'abort' && typeof body.stoppedAt === 'string') {
      const parsed = Date.parse(body.stoppedAt);
      if (Number.isFinite(parsed)) stoppedAtMs = parsed;
    }

    const settled =
      row.status === 'running'
        ? settleFocusRow(row, action, stoppedAtMs)
        : {
            id: row.id,
            status: row.status,
            durationSeconds: Number(row.duration_seconds) || 0,
          };

    sendJson(res, 200, {
      session: focusSessionPayload(statements.findRunningFocus.get()),
      settled,
      dashboard: buildDashboard(),
    });
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
}

/* ------------------------------------------------------------------ */
/* 服务启动                                                            */
/* ------------------------------------------------------------------ */

const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', securityHeaders['X-Content-Type-Options']);
  res.setHeader('X-Frame-Options', securityHeaders['X-Frame-Options']);
  res.setHeader('Referrer-Policy', securityHeaders['Referrer-Policy']);
  res.setHeader('Permissions-Policy', securityHeaders['Permissions-Policy']);
  res.setHeader('Content-Security-Policy', securityHeaders['Content-Security-Policy']);
  res.setHeader('Cross-Origin-Opener-Policy', securityHeaders['Cross-Origin-Opener-Policy']);
  if (requestIsSecure(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    sendJson(res, 400, { error: '请求地址不正确' });
    return;
  }

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: '请求方法不支持' });
      return;
    }

    if (!serveStatic(req, res, pathname)) {
      sendJson(res, 404, { error: '页面不存在' });
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }

    console.error('[yOA] request failed:', error);
    sendJson(res, 500, { error: '服务暂时不可用，请稍后再试' });
  }
});

server.on('error', (error) => {
  console.error('[yOA] server error:', error.message);
  process.exitCode = 1;
});

const credentialState = await ensureCredential();

server.listen(PORT, HOST, () => {
  console.log(`[yOA] listening on http://${HOST}:${PORT}`);
  console.log(`[yOA] database: ${DB_PATH}`);

  if (credentialState.created) {
    if (credentialState.fromEnv) {
      console.log('[yOA] 已用 YOA_LOGIN_KEY 初始化访问密钥，仅保存 scrypt 哈希');
    } else {
      console.log('[yOA] 首次启动：访问密钥已设为 admin');
      console.log('[yOA] 请登录后在“关于”页修改为更长的密钥');
    }
  } else if (!process.env.YOA_LOGIN_KEY) {
    console.log('[yOA] 访问密钥使用数据库中的 scrypt 哈希校验');
  }
});

function shutdown() {
  server.close(() => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
