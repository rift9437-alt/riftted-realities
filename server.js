'use strict';
/**
 * RIFTTED REALITIES - backend
 * Express + Neon PostgreSQL. Serves index.html (public site + /admin). Games are built into index.html.
 * Configuration comes only from environment variables (see README text in the hand-over notes):
 *   DATABASE_URL     Neon connection string (required)
 *   SESSION_SECRET   long random string (required in production)
 *   ADMIN_USERNAME   } optional: creates the first administrator at startup
 *   ADMIN_PASSWORD   } (only if that admin does not exist yet)
 *   PORT             provided by Render
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const INDEX_FILE = path.join(__dirname, 'index.html');
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000; // admin logins expire after 8 hours

// ───────────────────────── configuration checks ─────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('\nERROR: DATABASE_URL is not set. Add your Neon connection string (see instructions).\n');
  process.exit(1);
}
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (IS_PROD) {
    console.error('\nERROR: SESSION_SECRET is not set. Add a long random string as an environment variable.\n');
    process.exit(1);
  }
  SESSION_SECRET = 'dev-only-secret-change-me';
  console.warn('WARNING: SESSION_SECRET not set - using an insecure development default.');
}

// ───────────────────────── database ─────────────────────────
const dbUrl = process.env.DATABASE_URL;
const isLocalDb = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(dbUrl);
const pool = new Pool({
  connectionString: dbUrl,
  max: 10,
  // Neon requires SSL. If the URL already says sslmode, pg handles it; otherwise enable it for remote hosts.
  ssl: isLocalDb || /sslmode=/.test(dbUrl) ? undefined : { rejectUnauthorized: true },
});
pool.on('error', (e) => console.error('Database pool error:', e.message));
const q = (text, params) => pool.query(text, params);

const SEED_GAMES = [
  { slug: 'city-of-crime', title: 'City of Crime', genre: 'Open-World Action', category: 'Action', accent: '#f43f5e', description: 'An open-world city sandbox. Explore a sprawling 3D city on foot and behind the wheel of sports cars, sedans and SUVs.', featured: true, sort_order: 1 },
  { slug: 'starfall', title: 'Starfall', genre: 'Space Exploration', category: 'Space', accent: '#22d3ee', description: 'Pilot spacecraft, explore space, discover new locations and experience space combat. In development.', featured: true, sort_order: 2 },
  { slug: 'relicbound', title: 'Relicbound', genre: 'Fantasy Roguelike', category: 'Roguelike', accent: '#f59e0b', description: 'Explore dungeons, discover equipment, find loot and face increasingly challenging fantasy encounters. In development.', featured: false, sort_order: 3 },
  { slug: 'overdrive', title: 'Overdrive', genre: 'Futuristic Arcade Racing', category: 'Racing', accent: '#8b5cf6', description: 'Race futuristic vehicles across high-speed tracks, customise your rides and compete for better times. In development.', featured: false, sort_order: 4 },
  { slug: 'neon-strike', title: 'Neon Strike', genre: 'Futuristic Arcade Shooter', category: 'Shooter', accent: '#06b6d4', description: 'A fast-paced futuristic shooter concept with multiple maps, modes, weapon choices and AI opponents. In development.', featured: false, sort_order: 5 },
  { slug: 'blockfront', title: 'Blockfront', genre: 'Building & Survival', category: 'Survival', accent: '#84cc16', description: 'Gather resources, build structures, explore environments and develop a base while surviving challenges. In development.', featured: false, sort_order: 6 },
  { slug: 'shadow-protocol', title: 'Shadow Protocol', genre: 'Stealth & Strategy', category: 'Strategy', accent: '#64748b', description: 'Plan mission approaches, navigate dangerous environments, avoid detection and unlock new operations. In development.', featured: false, sort_order: 7 },
  { slug: 'last-stand', title: 'Last Stand', genre: 'Survival Action', category: 'Survival', accent: '#ef4444', description: 'Survive challenging environments, collect resources, complete objectives and improve your equipment. In development.', featured: false, sort_order: 8 },
  { slug: 'skybound', title: 'Skybound', genre: 'Flight & Exploration Simulator', category: 'Simulator', accent: '#38bdf8', description: 'Fly aircraft, explore large environments and complete flight challenges. In development.', featured: false, sort_order: 9 },
  { slug: 'dungeon-zero', title: 'Dungeon Zero', genre: 'Dungeon Crawler', category: 'Adventure', accent: '#a855f7', description: 'Explore dangerous dungeons, discover equipment, face bosses and progress through challenging areas. In development.', featured: false, sort_order: 10 },
  { slug: 'titan-arena', title: 'Titan Arena', genre: 'Mech Combat', category: 'Action', accent: '#f97316', description: 'Build and customise mechs with different components, weapons and movement systems before entering arenas. In development.', featured: false, sort_order: 11 },
  { slug: 'pixel-rush', title: 'Pixel Rush', genre: 'Arcade Platformer', category: 'Arcade', accent: '#ec4899', description: 'Race through fast platforming levels, overcome obstacles, collect items and complete time trials. In development.', featured: false, sort_order: 12 },
  { slug: 'project-impact', title: 'PROJECT: IMPACT', genre: '3D Competitive Fighting', category: 'Fighting', accent: '#eab308', description: 'A third-person fighting game concept built around custom fighting styles and manually performed combinations. In development.', featured: true, sort_order: 13 },
];

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(20)  NOT NULL,
    email         VARCHAR(254) NOT NULL,
    password_hash TEXT         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
  )`);
  await q('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (LOWER(username))');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (LOWER(email))');

  // Administrators live in their own table - they are never players and players can never become admins.
  await q(`CREATE TABLE IF NOT EXISTS admins (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50) NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS games (
    id          SERIAL PRIMARY KEY,
    slug        VARCHAR(60)  NOT NULL UNIQUE,
    title       VARCHAR(80)  NOT NULL,
    description TEXT         NOT NULL DEFAULT '',
    genre       VARCHAR(40)  NOT NULL DEFAULT '',
    category    VARCHAR(30)  NOT NULL DEFAULT '',
    accent      VARCHAR(7)   NOT NULL DEFAULT '#8b5cf6',
    published   BOOLEAN      NOT NULL DEFAULT TRUE,
    featured    BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order  INTEGER      NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS requests (
    id            SERIAL PRIMARY KEY,
    type          VARCHAR(20) NOT NULL CHECK (type IN ('suggestion','bug','feedback')),
    message       TEXT        NOT NULL,
    contact_email VARCHAR(254),
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','resolved')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  // Insert the starting library. Existing rows (and any admin edits) are never overwritten.
  for (const g of SEED_GAMES) {
    await q(
      `INSERT INTO games (slug,title,description,genre,category,accent,published,featured,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8) ON CONFLICT (slug) DO NOTHING`,
      [g.slug, g.title, g.description, g.genre, g.category, g.accent, g.featured, g.sort_order]
    );
  }

  // Optional first administrator from environment variables (never from the browser).
  const au = (process.env.ADMIN_USERNAME || '').trim();
  const ap = process.env.ADMIN_PASSWORD || '';
  if (au && ap) {
    if (ap.length < 10) {
      console.warn('ADMIN_PASSWORD is shorter than 10 characters - admin account was NOT created.');
    } else {
      const hash = await bcrypt.hash(ap, 12);
      const r = await q('INSERT INTO admins (username,password_hash) VALUES ($1,$2) ON CONFLICT (username) DO NOTHING', [au, hash]);
      if (r.rowCount) console.log(`Administrator "${au}" created.`);
    }
  }
}

// ───────────────────────── helpers ─────────────────────────
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const regenerate = (req) => new Promise((ok, no) => req.session.regenerate((e) => (e ? no(e) : ok())));
// New session id on every login (prevents session fixation), but keep whichever other identity is signed in,
// so an administrator can also log in on the public site as a player without being signed out of /admin.
async function rotateSession(req) {
  const keep = { userId: req.session.userId, adminId: req.session.adminId, adminAt: req.session.adminAt };
  await regenerate(req);
  for (const [k, v] of Object.entries(keep)) if (v !== undefined) req.session[k] = v;
}
const saveSession = (req) => new Promise((ok, no) => req.session.save((e) => (e ? no(e) : ok())));
const destroySession = (req) => new Promise((ok) => req.session.destroy(() => ok()));
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12); // used to keep login timing similar for unknown users

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && Buffer.byteLength(p) <= 72;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Games are built into index.html as <script type="text/plain" data-game="slug">...</script> blocks.
// A game is only "available" when its block exists in index.html and actually contains game data.
function embeddedGames() {
  const html = fs.readFileSync(INDEX_FILE, 'utf8');
  const found = new Set();
  for (const m of html.matchAll(/<script[^>]*\bdata-game="([a-z0-9-]+)"[^>]*>([^<]{1000,})<\/script>/g)) found.add(m[1]);
  return found;
}
const EMBEDDED = embeddedGames();
console.log('Games built into index.html:', [...EMBEDDED].join(', ') || '(none)');
async function withAvailability(rows) {
  return rows.map((g) => ({ ...g, files_found: EMBEDDED.has(g.slug) }));
}

// Tiny in-memory rate limiter (per IP). Good enough for a first version.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(req.ip, h); }
    if (++h.n > max) return bad(res, 'Too many attempts. Please wait a few minutes and try again.', 429);
    next();
  };
}
const authLimiter = limiter(15, 10 * 60 * 1000);
const requestLimiter = limiter(6, 10 * 60 * 1000);

// ───────────────────────── app ─────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '20kb' }));

// Block cross-site form/API posts: if the browser sends an Origin it must match our host.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* invalid */ }
    if (host !== req.headers.host) return bad(res, 'Cross-site request blocked.', 403);
  }
  next();
});

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  name: 'rr.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 14 * 24 * 60 * 60 * 1000 },
}));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ───────────────────────── pages ─────────────────────────
app.get('/', (req, res) => res.sendFile(INDEX_FILE));
app.get(['/admin', '/admin/'], (req, res) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.sendFile(INDEX_FILE); });
app.get('/games', (req, res) => res.redirect('/#/games'));
// No static file serving at all: server.js / package.json are never exposed.

// ───────────────────────── public API ─────────────────────────
app.get('/api/me', wrap(async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const r = await q('SELECT id, username FROM users WHERE id=$1', [req.session.userId]);
  if (!r.rows[0]) { delete req.session.userId; return res.json({ user: null }); }
  res.json({ user: r.rows[0] });
}));

app.post('/api/register', authLimiter, wrap(async (req, res) => {
  const username = str(req.body.username), email = str(req.body.email).toLowerCase();
  const { password, confirmPassword } = req.body;
  if (!USERNAME_RE.test(username)) return bad(res, 'Username must be 3-20 characters: letters, numbers and underscores only.');
  if (email.length > 254 || !EMAIL_RE.test(email)) return bad(res, 'Please enter a valid email address.');
  if (!validPassword(password)) return bad(res, 'Password must be at least 8 characters (and under 72 bytes).');
  if (password !== confirmPassword) return bad(res, 'Passwords do not match.');
  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    const r = await q('INSERT INTO users (username,email,password_hash) VALUES ($1,$2,$3) RETURNING id, username', [username, email, hash]);
    user = r.rows[0];
  } catch (e) {
    if (e.code === '23505') return bad(res, /email/.test(e.constraint || '') ? 'That email is already registered.' : 'That username is taken.', 409);
    throw e;
  }
  await rotateSession(req);
  req.session.userId = user.id;
  await saveSession(req);
  res.status(201).json({ user });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const id = str(req.body.identifier), password = req.body.password;
  if (!id || typeof password !== 'string' || id.length > 254) return bad(res, 'Enter your username or email and password.');
  const r = await q('SELECT id, username, password_hash FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1', [id]);
  const row = r.rows[0];
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return bad(res, 'Incorrect username/email or password.', 401);
  await rotateSession(req);
  req.session.userId = row.id;
  await saveSession(req);
  res.json({ user: { id: row.id, username: row.username } });
}));

app.post('/api/logout', wrap(async (req, res) => {
  delete req.session.userId; // only the player identity - an admin session in the same browser stays signed in
  if (req.session.adminId) await saveSession(req);
  else { await destroySession(req); res.clearCookie('rr.sid'); }
  res.json({ ok: true });
}));

app.get('/api/games', wrap(async (req, res) => {
  const r = await q('SELECT id,slug,title,description,genre,category,accent,featured FROM games WHERE published=TRUE ORDER BY sort_order, id');
  const games = (await withAvailability(r.rows)).map(({ files_found, ...g }) => ({ ...g, available: files_found }));
  res.json({ games });
}));

app.post('/api/requests', requestLimiter, wrap(async (req, res) => {
  const type = str(req.body.type), message = str(req.body.message), email = str(req.body.email);
  if (!['suggestion', 'bug', 'feedback'].includes(type)) return bad(res, 'Choose a request type.');
  if (message.length < 10 || message.length > 2000) return bad(res, 'Message must be between 10 and 2000 characters.');
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) return bad(res, 'That contact email does not look valid.');
  await q('INSERT INTO requests (type,message,contact_email,user_id) VALUES ($1,$2,$3,$4)', [type, message, email || null, req.session.userId || null]);
  res.status(201).json({ ok: true });
}));

// ───────────────────────── admin API ─────────────────────────
// Every route below this middleware requires a valid, current administrator session.
async function requireAdmin(req, res, next) {
  try {
    const s = req.session;
    if (!s.adminId || !s.adminAt || Date.now() - s.adminAt > ADMIN_SESSION_MS) return bad(res, 'Administrator login required.', 401);
    const r = await q('SELECT id, username FROM admins WHERE id=$1', [s.adminId]);
    if (!r.rows[0]) return bad(res, 'Administrator login required.', 401);
    req.admin = r.rows[0];
    next();
  } catch (e) { next(e); }
}

app.get('/api/admin/me', wrap(async (req, res) => {
  const s = req.session;
  if (!s.adminId || !s.adminAt || Date.now() - s.adminAt > ADMIN_SESSION_MS) return res.json({ admin: null });
  const r = await q('SELECT id, username FROM admins WHERE id=$1', [s.adminId]);
  res.json({ admin: r.rows[0] || null });
}));

app.post('/api/admin/login', authLimiter, wrap(async (req, res) => {
  const username = str(req.body.username), password = req.body.password;
  if (!username || typeof password !== 'string') return bad(res, 'Enter your administrator username and password.');
  const r = await q('SELECT id, username, password_hash FROM admins WHERE LOWER(username)=LOWER($1)', [username]);
  const row = r.rows[0];
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return bad(res, 'Incorrect administrator credentials.', 401);
  await rotateSession(req);
  req.session.adminId = row.id;
  req.session.adminAt = Date.now();
  await saveSession(req);
  res.json({ admin: { id: row.id, username: row.username } });
}));

app.post('/api/admin/logout', wrap(async (req, res) => {
  delete req.session.adminId; delete req.session.adminAt; // only the admin identity - a player login stays
  if (req.session.userId) await saveSession(req);
  else { await destroySession(req); res.clearCookie('rr.sid'); }
  res.json({ ok: true });
}));

app.use('/api/admin', requireAdmin);

app.get('/api/admin/overview', wrap(async (req, res) => {
  const [p, g, pub, r] = await Promise.all([
    q('SELECT COUNT(*)::int AS n FROM users'),
    q('SELECT COUNT(*)::int AS n FROM games'),
    q('SELECT COUNT(*)::int AS n FROM games WHERE published=TRUE'),
    q("SELECT COUNT(*)::int AS n FROM requests WHERE status='pending'"),
  ]);
  res.json({ players: p.rows[0].n, games: g.rows[0].n, published: pub.rows[0].n, pendingRequests: r.rows[0].n });
}));

app.get('/api/admin/games', wrap(async (req, res) => {
  const r = await q('SELECT id,slug,title,description,genre,category,accent,published,featured,updated_at FROM games ORDER BY sort_order, id');
  res.json({ games: await withAvailability(r.rows) });
}));

// Edits database information only. The games built into index.html are never touched by the admin API.
app.put('/api/admin/games/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return bad(res, 'Invalid game.');
  const b = req.body || {}, sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if ('title' in b) { const v = str(b.title); if (!v || v.length > 80) return bad(res, 'Title must be 1-80 characters.'); add('title', v); }
  if ('description' in b) { const v = str(b.description); if (v.length > 500) return bad(res, 'Description must be 500 characters or fewer.'); add('description', v); }
  if ('genre' in b) { const v = str(b.genre); if (v.length > 40) return bad(res, 'Genre must be 40 characters or fewer.'); add('genre', v); }
  if ('category' in b) { const v = str(b.category); if (!v || v.length > 30) return bad(res, 'Category must be 1-30 characters.'); add('category', v); }
  if ('accent' in b) { if (!HEX_RE.test(str(b.accent))) return bad(res, 'Accent must be a hex colour like #8b5cf6.'); add('accent', str(b.accent)); }
  if ('published' in b) { if (typeof b.published !== 'boolean') return bad(res, 'Invalid value.'); add('published', b.published); }
  if ('featured' in b) { if (typeof b.featured !== 'boolean') return bad(res, 'Invalid value.'); add('featured', b.featured); }
  if (!sets.length) return bad(res, 'Nothing to update.');
  vals.push(id);
  const r = await q(`UPDATE games SET ${sets.join(', ')}, updated_at=now() WHERE id=$${vals.length} RETURNING id`, vals);
  if (!r.rowCount) return bad(res, 'Game not found.', 404);
  res.json({ ok: true });
}));

app.get('/api/admin/requests', wrap(async (req, res) => {
  const r = await q(`SELECT r.id, r.type, r.message, r.contact_email, r.status, r.created_at, u.username
                     FROM requests r LEFT JOIN users u ON u.id=r.user_id
                     ORDER BY (r.status='pending') DESC, r.created_at DESC LIMIT 300`);
  res.json({ requests: r.rows });
}));

app.put('/api/admin/requests/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), status = str(req.body.status);
  if (!Number.isInteger(id) || !['pending', 'reviewed', 'resolved'].includes(status)) return bad(res, 'Invalid request.');
  const r = await q('UPDATE requests SET status=$1 WHERE id=$2 RETURNING id', [status, id]);
  if (!r.rowCount) return bad(res, 'Request not found.', 404);
  res.json({ ok: true });
}));

// Basic player info only - password hashes are never selected.
app.get('/api/admin/players', wrap(async (req, res) => {
  const r = await q('SELECT id, username, email, created_at FROM users ORDER BY created_at DESC LIMIT 500');
  res.json({ players: r.rows });
}));

app.post('/api/admin/password', wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return bad(res, 'Fill in both fields.');
  if (newPassword.length < 10 || Buffer.byteLength(newPassword) > 72) return bad(res, 'New password must be at least 10 characters.');
  const r = await q('SELECT password_hash FROM admins WHERE id=$1', [req.admin.id]);
  if (!(await bcrypt.compare(currentPassword, r.rows[0].password_hash))) return bad(res, 'Current password is incorrect.', 401);
  await q('UPDATE admins SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), req.admin.id]);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => bad(res, 'Not found.', 404));

// ───────────────────────── errors ─────────────────────────
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return bad(res, 'Invalid request body.');
  console.error(err);
  if (res.headersSent) return;
  bad(res, 'Server error. Please try again.', 500);
});

// ───────────────────────── start ─────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`Riftted Realities running on port ${PORT}`)))
  .catch((e) => { console.error('\nFailed to start - could not set up the database:', e.message, '\n'); process.exit(1); });
