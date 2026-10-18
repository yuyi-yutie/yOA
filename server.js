import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.YOA_DB || path.join(DATA_DIR, 'yoa.db');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const LOGIN_KEY = process.env.YOA_LOGIN_KEY || '28uyhed78430ghf7438';
const TIME_ZONE = 'Asia/Shanghai';
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 16 * 1024;

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

  CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_date TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_focus_date ON focus_sessions (session_date);
`);

const statements = {
  insertSession: db.prepare(
    'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)'
  ),
  findSession: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
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
  findCheckin: db.prepare('SELECT * FROM checkins WHERE checkin_date = ?'),
  insertCheckin: db.prepare(
    'INSERT OR IGNORE INTO checkins (checkin_date, created_at) VALUES (?, ?)'
  ),
  listCheckinDates: db.prepare(
    'SELECT checkin_date FROM checkins ORDER BY checkin_date DESC LIMIT 400'
  ),
  sumFocus: db.prepare(
    'SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM focus_sessions WHERE session_date = ?'
  ),
  insertFocus: db.prepare(
    'INSERT INTO focus_sessions (session_date, duration_seconds, created_at) VALUES (?, ?, ?)'
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

function safeKeyEqual(input, expected) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function shiftDate(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
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

function buildDashboard() {
  const today = todayKey();
  const plans = statements.listPlans.all(today).map((row) => ({
    id: row.id,
    title: row.title,
    completed: Boolean(row.completed),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const completed = plans.filter((plan) => plan.completed).length;
  const checkinRow = statements.findCheckin.get(today);
  const focusSeconds = Number(statements.sumFocus.get(today)?.total || 0);

  return {
    today,
    plans,
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
    return;
  }

  entry.count += 1;
}

const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/manifest.webmanifest', { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
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
      'Cache-Control': pathname === '/' || pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

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

function parsePlanId(pathname) {
  const match = /^\/api\/plans\/(\d+)$/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function handleApi(req, res, pathname) {
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
    if (typeof body.key !== 'string' || body.key.length > 256) {
      throw new HttpError(400, '请输入访问密钥');
    }

    if (!safeKeyEqual(body.key, LOGIN_KEY)) {
      noteFailedLogin(ip);
      sendJson(res, 401, { error: '访问密钥不正确' });
      return;
    }

    loginAttempts.delete(ip);
    statements.pruneSessions.run(nowIso());

    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    statements.insertSession.run(sha256(token), createdAt, expiresAt);

    sendJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': sessionCookie(token, req) }
    );
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const session = getSession(req);
    if (session) statements.deleteSession.run(session.tokenHash);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
    return;
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    if (!getSession(req)) {
      sendJson(res, 401, { authenticated: false, error: '未登录' });
      return;
    }
    sendJson(res, 200, { authenticated: true, today: todayKey() });
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
    const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';

    if (!title) throw new HttpError(400, '计划内容不能为空');
    if ([...title].length > 120) throw new HttpError(400, '计划内容不能超过 120 个字');

    const timestamp = nowIso();
    const today = todayKey();
    statements.insertPlan.run(today, title, timestamp, timestamp);
    sendJson(res, 201, buildDashboard());
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

    if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 7200) {
      throw new HttpError(400, '专注时长不正确');
    }

    statements.insertFocus.run(todayKey(), durationSeconds, nowIso());
    sendJson(res, 201, buildDashboard());
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
}

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', securityHeaders['X-Content-Type-Options']);
  res.setHeader('X-Frame-Options', securityHeaders['X-Frame-Options']);
  res.setHeader('Referrer-Policy', securityHeaders['Referrer-Policy']);
  res.setHeader('Permissions-Policy', securityHeaders['Permissions-Policy']);
  res.setHeader('Content-Security-Policy', securityHeaders['Content-Security-Policy']);

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

server.listen(PORT, HOST, () => {
  console.log(`[yOA] listening on http://${HOST}:${PORT}`);
  console.log(`[yOA] database: ${DB_PATH}`);
  if (!process.env.YOA_LOGIN_KEY) {
    console.log('[yOA] using the built-in prototype access key; set YOA_LOGIN_KEY in production');
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
