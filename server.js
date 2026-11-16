/**
 * BlockForge – Server (Step 3: Accounts & Profiles)
 * Persistent JSON store + bcrypt password hashing
 * Run: npm install && node server.js
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// bcryptjs – graceful fallback to crypto scrypt if not installed yet
let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch {
  bcrypt = {
    hashSync: (pw, rounds) => {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
      return `scrypt$${salt}$${hash}`;
    },
    compareSync: (pw, stored) => {
      if (stored.startsWith('scrypt$')) {
        const [, salt, hash] = stored.split('$');
        const test = crypto.scryptSync(pw, salt, 64).toString('hex');
        return test === hash;
      }
      return false;
    }
  };
  console.warn('[auth] bcryptjs not found – using crypto.scrypt fallback. Run: npm install bcryptjs');
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// ---------- Persistence ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('Failed to load', file, e.message);
  }
  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save', file, e.message);
  }
}

// users: { [usernameLower]: userObject }
// sessions: { [token]: { userId, username, createdAt, expiresAt } }
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');
const GAMESTATS_FILE = path.join(DATA_DIR, 'gamestats.json');

const AC_FILE = path.join(DATA_DIR, 'anticheat.json');
const TX_FILE = path.join(DATA_DIR, 'transactions.json');

const store = {
  users: loadJSON(USERS_FILE, {}),
  sessions: loadJSON(SESSIONS_FILE, {}),
  ratings: loadJSON(RATINGS_FILE, {}),
  gamestats: loadJSON(GAMESTATS_FILE, {}),
  anticheat: loadJSON(AC_FILE, {
    logs: [],
    bans: {},
    strikes: {},
    flags: [],          // open review queue
    suspicion: {},      // key -> score
    adminAudit: [],
    testerIds: []       // approved tester usernames (lowercase)
  }),
  transactions: loadJSON(TX_FILE, []),
  gameSaves: loadJSON(path.join(DATA_DIR, 'gamesaves.json'), {})
};

const GAMESAVES_FILE = path.join(DATA_DIR, 'gamesaves.json');
function persistGameSaves() { saveJSON(GAMESAVES_FILE, store.gameSaves); }


function persistUsers() { saveJSON(USERS_FILE, store.users); }
function persistSessions() { saveJSON(SESSIONS_FILE, store.sessions); }
function persistRatings() { saveJSON(RATINGS_FILE, store.ratings); }
function persistGameStats() { saveJSON(GAMESTATS_FILE, store.gamestats); }
function persistAC() {
  if (store.anticheat.logs.length > 800) store.anticheat.logs = store.anticheat.logs.slice(-800);
  if (store.anticheat.flags.length > 300) store.anticheat.flags = store.anticheat.flags.slice(-300);
  if (store.anticheat.adminAudit.length > 200) store.anticheat.adminAudit = store.anticheat.adminAudit.slice(-200);
  saveJSON(AC_FILE, store.anticheat);
}
function persistTx() {
  if (store.transactions.length > 1000) store.transactions = store.transactions.slice(-1000);
  saveJSON(TX_FILE, store.transactions);
}

// ========== ANTI-CHEAT MODULE (shared across all games) ==========
const AC = {
  MAX_SPEED: 28,
  MAX_SPEED_BURST: 55,
  BURST_WINDOW_MS: 450,
  MAX_TELEPORT: 42,
  MAX_AIR_TIME_MS: 4000,      // noclip/fly without rocket room
  MSG_RATE: 40,
  EVENT_RATE: 8,
  CHAT_RATE_MS: 1500,
  STRIKE_WARN: 3,
  STRIKE_RESTRICT: 6,
  STRIKE_BAN: 12,
  BAN_MS: 60 * 60 * 1000,
  SUSPICION_FLAG: 25,
  SUSPICION_RESTRICT: 50,
  SUSPICION_REVIEW: 75,
  ADMIN_KEY: process.env.ADMIN_KEY || 'blockforge-admin-dev',
  // per-room movement profiles
  roomProfile(roomId) {
    const id = String(roomId || '');
    if (id.includes('rocket')) return { maxSpeed: 70, burst: 120, airOk: true };
    if (id.includes('afterimage') || id.includes('momentum') || id.includes('city-breakers'))
      return { maxSpeed: 40, burst: 70, airOk: true };
    if (id.includes('mech')) return { maxSpeed: 35, burst: 55, airOk: false };
    return { maxSpeed: this.MAX_SPEED, burst: this.MAX_SPEED_BURST, airOk: false };
  }
};

function acLog(entry) {
  const row = { id: uuidv4(), at: new Date().toISOString(), ...entry };
  store.anticheat.logs.push(row);
  persistAC();
  if (entry.severity === 'ban' || entry.severity === 'restrict') {
    console.warn('[AC]', entry.severity, entry.playerName || entry.playerId, entry.reason);
  }
  return row;
}

function adminAudit(action, detail) {
  store.anticheat.adminAudit.push({ id: uuidv4(), at: new Date().toISOString(), action, detail });
  persistAC();
}

function getStrikes(key) { return store.anticheat.strikes[key] || 0; }

function addSuspicion(key, points, meta) {
  const cur = (store.anticheat.suspicion[key] || 0) + points;
  store.anticheat.suspicion[key] = cur;
  let action = 'log';
  if (cur >= AC.SUSPICION_REVIEW || points >= 15) {
    store.anticheat.flags.push({
      id: uuidv4(),
      playerKey: key,
      playerName: meta.name,
      reason: meta.reason,
      category: meta.category || 'general',
      suspicion: cur,
      detail: meta.detail,
      room: meta.room,
      status: 'open',
      at: new Date().toISOString()
    });
    action = 'flag';
  }
  if (cur >= AC.SUSPICION_RESTRICT) action = 'restrict';
  persistAC();
  acLog({
    severity: action === 'log' ? 'info' : action,
    playerId: key,
    playerName: meta.name,
    reason: meta.reason,
    category: meta.category || 'general',
    detail: meta.detail,
    suspicion: cur,
    room: meta.room
  });
  return { suspicion: cur, action };
}

function addStrike(key, amount, meta) {
  const n = (store.anticheat.strikes[key] || 0) + amount;
  store.anticheat.strikes[key] = n;
  let action = 'flag';
  if (n >= AC.STRIKE_BAN) {
    store.anticheat.bans[key] = {
      until: meta.permanent ? null : Date.now() + (meta.banMs || AC.BAN_MS),
      permanent: !!meta.permanent,
      reason: meta.reason,
      at: new Date().toISOString()
    };
    action = 'ban';
  } else if (n >= AC.STRIKE_RESTRICT) action = 'restrict';
  else if (n >= AC.STRIKE_WARN) action = 'warn';
  addSuspicion(key, amount * 5, { ...meta, category: meta.category || 'strike' });
  acLog({ severity: action, playerId: key, playerName: meta.name, reason: meta.reason, detail: meta.detail, strikes: n, room: meta.room });
  persistAC();
  return { strikes: n, action };
}

function isBanned(key) {
  const b = store.anticheat.bans[key];
  if (!b) return false;
  if (b.permanent) return b;
  if (b.until && b.until < Date.now()) {
    delete store.anticheat.bans[key];
    persistAC();
    return false;
  }
  return b;
}

function isRestricted(key) {
  return getStrikes(key) >= AC.STRIKE_RESTRICT || (store.anticheat.suspicion[key] || 0) >= AC.SUSPICION_RESTRICT;
}

function clearBan(key) {
  delete store.anticheat.bans[key];
  store.anticheat.strikes[key] = 0;
  store.anticheat.suspicion[key] = 0;
  persistAC();
}

function isTester(username) {
  return store.anticheat.testerIds.includes(String(username || '').toLowerCase());
}

function logTransaction(tx) {
  store.transactions.push({ id: uuidv4(), at: new Date().toISOString(), ...tx });
  persistTx();
}

function validateMovement(player, msg, roomId) {
  const flags = [];
  const now = Date.now();
  const profile = AC.roomProfile(roomId);
  if (!player.ac) {
    player.ac = {
      lastPos: { x: player.x, y: player.y, z: player.z },
      lastMoveAt: now,
      burstUntil: 0,
      msgTimes: [],
      eventTimes: [],
      chatAt: 0,
      airSince: null,
      softFlags: 0
    };
  }
  const ac = player.ac;
  ac.msgTimes = ac.msgTimes.filter(t => now - t < 1000);
  ac.msgTimes.push(now);
  if (ac.msgTimes.length > AC.MSG_RATE) flags.push('msg_flood');

  let x = player.x, y = player.y, z = player.z, yaw = player.yaw;
  const nx = typeof msg.x === 'number' && Number.isFinite(msg.x) ? msg.x : null;
  const ny = typeof msg.y === 'number' && Number.isFinite(msg.y) ? msg.y : null;
  const nz = typeof msg.z === 'number' && Number.isFinite(msg.z) ? msg.z : null;
  const nyaw = typeof msg.yaw === 'number' && Number.isFinite(msg.yaw) ? msg.yaw : null;

  if (nx !== null && ny !== null && nz !== null) {
    const dt = Math.max(0.016, (now - ac.lastMoveAt) / 1000);
    const dx = nx - ac.lastPos.x, dy = ny - ac.lastPos.y, dz = nz - ac.lastPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const speed = dist / dt;

    // Noclip / underground
    if (ny < -5) flags.push('noclip');

    // Flying: sustained height without room allowing air mobility
    if (ny > 2.5) {
      if (!ac.airSince) ac.airSince = now;
      else if (!profile.airOk && now - ac.airSince > AC.MAX_AIR_TIME_MS && Math.abs(dy) < 0.5) {
        flags.push('fly');
      }
    } else {
      ac.airSince = null;
    }

    if (dist > AC.MAX_TELEPORT && dt < 0.5) {
      flags.push('teleport');
    } else {
      const maxSp = (now < ac.burstUntil) ? profile.burst : profile.maxSpeed;
      if (speed > maxSp * 1.4) {
        flags.push('speed');
        const scale = maxSp / Math.max(speed, 0.01);
        x = ac.lastPos.x + dx * scale;
        y = ac.lastPos.y + dy * scale;
        z = ac.lastPos.z + dz * scale;
      } else {
        x = nx; y = ny; z = nz;
        if (speed > profile.maxSpeed) ac.burstUntil = now + AC.BURST_WINDOW_MS;
      }
    }
    // Abnormal vertical acceleration (jump spam without grounding)
    if (dy > 15 && dt < 0.2) flags.push('jump_hack');

    if (!flags.includes('teleport') && !flags.includes('noclip')) {
      ac.lastPos = { x, y, z };
      ac.lastMoveAt = now;
    }
  }
  if (nyaw !== null) yaw = ((nyaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  let hp = player.hp;
  if (typeof msg.hp === 'number' && Number.isFinite(msg.hp)) {
    const h = Math.max(0, Math.min(100, msg.hp));
    if (h <= player.hp + 1) hp = h;
    else if (h === 100 && player.hp < 35) hp = 100;
    else flags.push('hp_hack');
  }

  const severe = flags.some(f => ['teleport', 'msg_flood', 'noclip', 'fly'].includes(f));
  return { ok: !severe, x, y, z, yaw, hp, flags };
}

function validateEvent(player, msg) {
  const now = Date.now();
  if (!player.ac) player.ac = { eventTimes: [], msgTimes: [], lastPos: { x: 0, y: 0, z: 0 }, lastMoveAt: now, chatAt: 0, softFlags: 0 };
  player.ac.eventTimes = (player.ac.eventTimes || []).filter(t => now - t < 1000);
  player.ac.eventTimes.push(now);
  if (player.ac.eventTimes.length > AC.EVENT_RATE) return { ok: false, reason: 'event_flood', category: 'combat' };
  const allowed = new Set(['shoot', 'hit', 'explode', 'emote', 'ability', 'kill', 'damage', 'dash', 'rocket']);
  if (!allowed.has(String(msg.event || ''))) return { ok: false, reason: 'invalid_event', category: 'exploit' };
  if (msg.data && typeof msg.data.damage === 'number') {
    if (!Number.isFinite(msg.data.damage) || msg.data.damage < 0 || msg.data.damage > 120) {
      return { ok: false, reason: 'invalid_damage', category: 'combat' };
    }
  }
  if (msg.data && typeof msg.data.range === 'number' && msg.data.range > 80) {
    return { ok: false, reason: 'invalid_range', category: 'combat' };
  }
  return { ok: true };
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== AC.ADMIN_KEY) return res.status(403).json({ error: 'Admin key required' });
  next();
}


// Clean expired sessions on boot
(function cleanSessions() {
  const now = Date.now();
  let changed = false;
  for (const [tok, s] of Object.entries(store.sessions)) {
    if (s.expiresAt && s.expiresAt < now) {
      delete store.sessions[tok];
      changed = true;
    }
  }
  if (changed) persistSessions();
})();

// ---------- Constants ----------
const STARTER_INV = [
  'default', 'serious', 'happy', 'surprised', 'sunglasses', 'silly',
  'short', 'spiky', 'messy', 'baseball', 'beanie',
  'classic', 'striped', 'jeans', 'shorts', 'headband', 'backpack'
];

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BCRYPT_ROUNDS = 10;

function defaultAvatar() {
  return {
    bodyColors: {
      head: '#f5d0c5', torso: '#00a2ff',
      leftArm: '#f5d0c5', rightArm: '#f5d0c5',
      leftLeg: '#1a1a2e', rightLeg: '#1a1a2e'
    },
    face: 'default', hair: null, hat: null, shirt: null, pants: null,
    accessories: { head: null, face: null, back: null, shoulder: null }
  };
}

// ---------- Validation ----------
function validateUsername(username) {
  if (!username || typeof username !== 'string') return 'Username is required';
  const u = username.trim();
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 20) return 'Username must be 20 characters or less';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'Username can only contain letters, numbers and underscores';
  if (/^[0-9]/.test(u)) return 'Username cannot start with a number';
  const reserved = ['admin', 'mod', 'moderator', 'system', 'blockforge', 'null', 'undefined', 'guest'];
  if (reserved.includes(u.toLowerCase())) return 'That username is reserved';
  return null;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 6) return 'Password must be at least 6 characters';
  if (password.length > 128) return 'Password is too long';
  return null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    description: user.description || '',
    currency: user.currency ?? 0,
    avatar: user.avatar || defaultAvatar(),
    inventory: user.inventory || [...STARTER_INV],
    friends: user.friends || [],
    favouriteGames: user.favouriteGames || [],
    recentlyPlayed: user.recentlyPlayed || [],
    createdAt: user.createdAt,
    isGuest: !!user.isGuest
  };
}

function findUserById(id) {
  for (const u of Object.values(store.users)) if (u.id === id) return u;
  return null;
}

function findUserByUsername(username) {
  return store.users[username.toLowerCase()] || null;
}

function getUserFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const session = store.sessions[token];
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) {
    delete store.sessions[token];
    persistSessions();
    return null;
  }
  // Sliding expiry
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  const user = findUserById(session.userId);
  if (!user || user.isGuest) return user; // guests ok for some endpoints
  return user;
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user || user.isGuest) {
    return res.status(401).json({ error: 'Please log in to continue' });
  }
  req.user = user;
  req.token = (req.headers.authorization || '').replace('Bearer ', '');
  next();
}

function requireAnyAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  req.token = (req.headers.authorization || '').replace('Bearer ', '');
  next();
}

// ---------- Rate limiting (simple in-memory) ----------
const authAttempts = new Map(); // ip -> { count, resetAt }

function rateLimitAuth(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = authAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + 15 * 60 * 1000 }; // 15 min window
    authAttempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > 20) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  next();
}

// ---------- Games catalogue ----------
const GAMES = [
  {
    id: 'mech-wars',
    title: 'MECH WARS',
    creator: 'BlockForge',
    description: 'Build modular mechs from scavenged parts, then deploy them in tactical arena battles. Customise armour, weapons and thrusters — every chassis plays differently.',
    shortDescription: 'Modular mech combat. Build. Fight. Dominate.',
    players: 2841,
    likes: 12400,
    dislikes: 890,
    category: 'Action',
    featured: true,
    visits: 156200,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    modes: ['Arena', 'Team Deathmatch', 'Workshop'],
    emoji: '🤖',
    gradient: 'linear-gradient(135deg,#1a237e,#4a148c,#880e4f)',
    tags: ['mechs', 'combat', 'customisation', 'pvp']
  },
  {
    id: 'human-disaster',
    title: 'HUMAN DISASTER',
    creator: 'BlockForge',
    description: 'A chaotic round-based party game of physics minigames. Race, fling, stack and sabotage your way through absurd challenges. Last human standing wins — or everyone loses spectacularly.',
    shortDescription: 'Chaotic physics party minigames. Pure disaster.',
    players: 4120,
    likes: 18900,
    dislikes: 1200,
    category: 'Party',
    featured: true,
    visits: 203400,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    modes: ['Free-for-all', 'Teams', 'Solo Challenges'],
    emoji: '💥',
    gradient: 'linear-gradient(135deg,#bf360c,#e65100,#ff6f00)',
    tags: ['party', 'physics', 'minigames', 'chaos']
  },
  {
    id: 'afterimage',
    title: 'AFTERIMAGE',
    creator: 'BlockForge',
    description: 'Lightning-fast third-person hand-to-hand combat inspired by anime action. Chain combos, dash through afterimages, and master timing-based counters in ranked duels and free roam arenas.',
    shortDescription: 'Anime-style third-person combat. Speed is everything.',
    players: 3655,
    likes: 22100,
    dislikes: 640,
    category: 'Action',
    featured: true,
    visits: 187600,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    modes: ['Duel', 'Free Roam', 'Training'],
    emoji: '⚔️',
    gradient: 'linear-gradient(135deg,#4a148c,#6a1b9a,#9c27b0)',
    tags: ['combat', 'anime', 'fast-paced', 'pvp']
  },
  {
    id: 'overdrive',
    title: 'OVERDRIVE',
    creator: 'BlockForge',
    description: 'Weapon-based anime action combat. Master swords, dual blades and devastating ultimates against powerful bosses.',
    shortDescription: 'Anime weapon combat and ultimates.',
    players: 1980, likes: 9800, dislikes: 420, category: 'Action', featured: true,
    visits: 88400, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
    modes: ['Arena', 'Boss Rush'], emoji: '🗡️',
    gradient: 'linear-gradient(135deg,#0d47a1,#1565c0,#42a5f5)',
    tags: ['combat', 'anime', 'weapons']
  },
  {
    id: 'momentum',
    title: 'MOMENTUM',
    creator: 'BlockForge',
    description: 'Parkour and speedrunning where maintaining speed is everything. Slide, wall-run and chain movement across precision courses.',
    shortDescription: 'Parkour speedrunning. Never stop moving.',
    players: 1540, likes: 11200, dislikes: 310, category: 'Obby', featured: true,
    visits: 72300, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
    modes: ['Time Trial', 'Free Run'], emoji: '💨',
    gradient: 'linear-gradient(135deg,#01579b,#0288d1,#4fc3f7)',
    tags: ['parkour', 'speedrun', 'movement']
  },
  {
    id: 'clean-sweep',
    title: 'CLEAN SWEEP',
    creator: 'BlockForge',
    description: 'Satisfying first-person cleaning simulator. Take contracts, blast grime with pressure washers and earn ridiculous titles.',
    shortDescription: 'Clean jobs. Upgrade gear. Become Mop Maestro.',
    players: 2210, likes: 13400, dislikes: 890, category: 'Simulator', featured: false,
    visits: 95600, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
    modes: ['Contracts'], emoji: '🧹',
    gradient: 'linear-gradient(135deg,#e0f7fa,#80deea,#26c6da)',
    tags: ['simulator', 'cleaning', 'relaxing']
  },
  {
    id: 'city-breakers',
    title: 'CITY BREAKERS',
    creator: 'BlockForge',
    description: 'Open-world superpowered action. Fly across a dense city, blast thugs and unlock abilities.',
    shortDescription: 'Superpowers in a living city.',
    players: 3100, likes: 16700, dislikes: 720, category: 'Action', featured: true,
    visits: 142000, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
    modes: ['Free Roam', 'Missions'], emoji: '🦸',
    gradient: 'linear-gradient(135deg,#b71c1c,#e53935,#ff8a80)',
    tags: ['open-world', 'superhero', 'action']
  },
  {
    id: 'lost-kingdom',
    title: 'LOST KINGDOM',
    creator: 'BlockForge',
    description: 'Fantasy adventure through ruins and temples. Complete quests, collect gold and recover lost relics.',
    shortDescription: 'Explore ruins. Claim the crystal.',
    players: 1760, likes: 10100, dislikes: 380, category: 'Adventure', featured: true,
    visits: 81200, createdAt: '2026-06-20T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
    modes: ['Adventure'], emoji: '👑',
    gradient: 'linear-gradient(135deg,#ff8f00,#ffb300,#ffd54f)',
    tags: ['rpg', 'adventure', 'fantasy']
  },
  {
    id: 'harvest',
    title: 'HARVEST',
    creator: 'BlockForge',
    description: 'Plant, water and harvest crops. Expand your farm, buy seeds and build a thriving rural business.',
    shortDescription: 'Farm, grow, sell, expand.',
    players: 2890, likes: 14500, dislikes: 560, category: 'Simulator', featured: false,
    visits: 118000, createdAt: '2026-05-10T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    modes: ['Career'], emoji: '🌾',
    gradient: 'linear-gradient(135deg,#33691e,#689f38,#aed581)',
    tags: ['farming', 'simulator', 'cozy']
  },
  {
    id: 'worldcraft',
    title: 'WORLDCRAFT',
    creator: 'BlockForge',
    description: 'Sandbox building with placeable blocks. Sculpt terrain, construct bases and save your creations.',
    shortDescription: 'Build anything. Block by block.',
    players: 4200, likes: 19800, dislikes: 640, category: 'Sandbox', featured: true,
    visits: 210000, createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    modes: ['Creative'], emoji: '🧱',
    gradient: 'linear-gradient(135deg,#4e342e,#6d4c41,#a1887f)',
    tags: ['sandbox', 'building', 'creative']
  },
  {
    id: 'vertigo',
    title: 'VERTIGO',
    creator: 'BlockForge',
    description: 'Climb colossal towers of shifting platforms. Checkpoints, narrow ledges and a long drop await.',
    shortDescription: 'Tower climbing. Don\'t look down.',
    players: 1330, likes: 8700, dislikes: 290, category: 'Obby', featured: true,
    visits: 65400, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
    modes: ['Climb', 'Time Trial'], emoji: '🗼',
    gradient: 'linear-gradient(135deg,#263238,#546e7a,#90a4ae)',
    tags: ['obby', 'climbing', 'precision']
  },
  {
    id: 'rocket-royale',
    title: 'ROCKET ROYALE',
    creator: 'BlockForge',
    description: 'First-person rocket arena. Rocket-jump, air-steer and chain mobility with specialised launchers in timed FFA matches.',
    shortDescription: 'Rocket jumping FFA arena shooter.',
    players: 3560, likes: 20400, dislikes: 880, category: 'Action', featured: true,
    visits: 176500, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
    modes: ['Free For All'], emoji: '🚀',
    gradient: 'linear-gradient(135deg,#e65100,#ff6d00,#ffab40)',
    tags: ['fps', 'rockets', 'arena', 'movement']
  },
  {
    id: 'mega-obby',

    title: 'Mega Obby',
    creator: 'BlockForge',
    description: 'A challenging multi-stage parkour obstacle course. Precision jumps, moving platforms, and secret shortcuts. Can you reach the summit?',
    shortDescription: 'Parkour stages. Reach the top.',
    players: 1247,
    likes: 8932,
    dislikes: 410,
    category: 'Obby',
    featured: true,
    visits: 45210,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    modes: ['Classic', 'Speedrun', 'Practice'],
    emoji: '🏔️',
    gradient: 'linear-gradient(135deg,#0d47a1,#1565c0,#42a5f5)',
    tags: ['obby', 'parkour', 'platformer']
  },
  {
    id: 'clicker-sim',
    title: 'Clicker Simulator',
    creator: 'BlockForge',
    description: 'Click your way to riches. Unlock upgrades, prestige systems and exclusive cosmetics. Compete on the global leaderboard.',
    shortDescription: 'Click, upgrade, rebirth, dominate.',
    players: 3421,
    likes: 15600,
    dislikes: 2100,
    category: 'Simulator',
    featured: false,
    visits: 128900,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    modes: ['Solo'],
    emoji: '🖱️',
    gradient: 'linear-gradient(135deg,#1b5e20,#43a047,#81c784)',
    tags: ['simulator', 'idle', 'progression']
  },
  {
    id: 'battle-arena',
    title: 'Battle Arena',
    creator: 'BlockForge',
    description: 'Fast-paced combat arena. Collect weapons, defeat AI opponents and climb the ranks.',
    shortDescription: 'Arena combat with weapons and power-ups.',
    players: 892,
    likes: 7200,
    dislikes: 530,
    category: 'Action',
    featured: false,
    visits: 67800,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    modes: ['FFA', 'Team'],
    emoji: '🏟️',
    gradient: 'linear-gradient(135deg,#b71c1c,#e53935,#ef9a9a)',
    tags: ['combat', 'arena', 'action']
  },
  {
    id: 'city-life',
    title: 'City Life',
    creator: 'BlockForge',
    description: 'Live your best life in a vibrant open-world city. Jobs, vehicles, housing and roleplay.',
    shortDescription: 'Open-world city roleplay.',
    players: 2156,
    likes: 11200,
    dislikes: 980,
    category: 'Roleplay',
    featured: false,
    visits: 94500,
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    modes: ['Roleplay', 'Sandbox'],
    emoji: '🏙️',
    gradient: 'linear-gradient(135deg,#01579b,#0288d1,#4fc3f7)',
    tags: ['roleplay', 'city', 'open-world']
  },
  {
    id: 'island-survival',
    title: 'Island Survival',
    creator: 'BlockForge',
    description: 'Stranded on a tropical island. Gather resources, craft tools, build shelter and survive.',
    shortDescription: 'Gather, craft, survive the island.',
    players: 567,
    likes: 5400,
    dislikes: 220,
    category: 'Survival',
    featured: true,
    visits: 32100,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    modes: ['Solo', 'Co-op'],
    emoji: '🏝️',
    gradient: 'linear-gradient(135deg,#004d40,#00897b,#4db6ac)',
    tags: ['survival', 'crafting', 'exploration']
  },
  {
    id: 'lobby',
    title: 'Main Lobby',
    creator: 'BlockForge',
    description: 'The central hub of BlockForge. Meet others and discover experiences.',
    shortDescription: 'Central hub.',
    players: 5000,
    likes: 99999,
    dislikes: 0,
    category: 'Hub',
    featured: false,
    visits: 1000000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    modes: ['Social'],
    emoji: '🏛️',
    gradient: 'linear-gradient(135deg,#263238,#455a64,#90a4ae)',
    tags: ['hub', 'social']
  }
];

function enrichGame(g) {
  const stats = store.gamestats[g.id] || {};
  const likes = stats.likes != null ? stats.likes : g.likes;
  const dislikes = stats.dislikes != null ? stats.dislikes : g.dislikes;
  const visits = stats.visits != null ? stats.visits : g.visits;
  const total = likes + dislikes;
  const likePct = total > 0 ? Math.round((likes / total) * 100) : 100;
  const rating = total > 0 ? Math.round((likes / total) * 50) / 10 : 5.0; // 0-5 scale
  return { ...g, likes, dislikes, visits, likePct, rating, players: g.players };
}

function getEnrichedGames() {
  return GAMES.filter(g => g.id !== 'lobby').map(enrichGame);
}

function getEnrichedGame(id) {
  const g = GAMES.find(x => x.id === id);
  return g ? enrichGame(g) : null;
}

// ---------- Routes ----------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: 'BlockForge',
    version: '0.6.0',
    users: Object.keys(store.users).length,
    persistence: 'json-file'
  });
});

app.get('/api/games', (req, res) => {
  let list = getEnrichedGames();
  const { category, search, featured, sort, tag } = req.query;

  if (category && category !== 'all') {
    list = list.filter(g => g.category.toLowerCase() === String(category).toLowerCase());
  }
  if (tag) {
    const t = String(tag).toLowerCase();
    list = list.filter(g => (g.tags || []).some(x => x.toLowerCase().includes(t)));
  }
  if (search) {
    const q = String(search).toLowerCase();
    list = list.filter(g =>
      g.title.toLowerCase().includes(q) ||
      g.creator.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q) ||
      (g.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (g.shortDescription || '').toLowerCase().includes(q)
    );
  }
  if (featured === 'true') list = list.filter(g => g.featured);

  const sortKey = String(sort || 'popular').toLowerCase();
  if (sortKey === 'newest') list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  else if (sortKey === 'rating' || sortKey === 'top') list.sort((a, b) => b.likePct - a.likePct || b.likes - a.likes);
  else if (sortKey === 'visits' || sortKey === 'played') list.sort((a, b) => b.visits - a.visits);
  else list.sort((a, b) => b.players - a.players); // popular default

  res.json({ games: list });
});

app.get('/api/games/:id', (req, res) => {
  const game = getEnrichedGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  // Recommended: same category or overlapping tags, exclude self
  const all = getEnrichedGames().filter(g => g.id !== game.id);
  const recommended = all
    .map(g => {
      let score = 0;
      if (g.category === game.category) score += 3;
      const tags = new Set(game.tags || []);
      (g.tags || []).forEach(t => { if (tags.has(t)) score += 1; });
      score += g.likePct / 100;
      return { g, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(x => x.g);

  // User's rating if authenticated
  let myRating = null;
  const user = getUserFromRequest(req);
  if (user && store.ratings[game.id] && store.ratings[game.id][user.id]) {
    myRating = store.ratings[game.id][user.id];
  }

  let isFavourite = false;
  if (user && Array.isArray(user.favouriteGames)) {
    isFavourite = user.favouriteGames.includes(game.id);
  }

  res.json({ game, recommended, myRating, isFavourite });
});

// Record a play / visit
app.post('/api/games/:id/play', requireAnyAuth, (req, res) => {
  const game = getEnrichedGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  if (!store.gamestats[game.id]) store.gamestats[game.id] = {};
  store.gamestats[game.id].visits = (store.gamestats[game.id].visits != null ? store.gamestats[game.id].visits : game.visits) + 1;
  persistGameStats();

  // Recently played on user
  if (!req.user.recentlyPlayed) req.user.recentlyPlayed = [];
  req.user.recentlyPlayed = [game.id, ...req.user.recentlyPlayed.filter(id => id !== game.id)].slice(0, 20);

  if (!req.user.isGuest) {
    const key = req.user.username.toLowerCase();
    if (store.users[key]) {
      store.users[key].recentlyPlayed = req.user.recentlyPlayed;
      persistUsers();
    }
  }

  res.json({ success: true, visits: store.gamestats[game.id].visits });
});

// Like / dislike
app.post('/api/games/:id/rate', requireAuth, (req, res) => {
  const gameId = req.params.id;
  const game = getEnrichedGame(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const value = req.body?.rating; // 'like' | 'dislike' | null (clear)
  if (value !== 'like' && value !== 'dislike' && value !== null) {
    return res.status(400).json({ error: 'rating must be like, dislike, or null' });
  }

  if (!store.ratings[gameId]) store.ratings[gameId] = {};
  const prev = store.ratings[gameId][req.user.id] || null;

  // Adjust stats
  if (!store.gamestats[gameId]) {
    store.gamestats[gameId] = { likes: game.likes, dislikes: game.dislikes, visits: game.visits };
  }
  const st = store.gamestats[gameId];
  if (st.likes == null) st.likes = game.likes;
  if (st.dislikes == null) st.dislikes = game.dislikes;

  if (prev === 'like') st.likes = Math.max(0, st.likes - 1);
  if (prev === 'dislike') st.dislikes = Math.max(0, st.dislikes - 1);

  if (value === null) {
    delete store.ratings[gameId][req.user.id];
  } else {
    store.ratings[gameId][req.user.id] = value;
    if (value === 'like') st.likes += 1;
    if (value === 'dislike') st.dislikes += 1;
  }

  persistRatings();
  persistGameStats();

  const enriched = getEnrichedGame(gameId);
  res.json({
    success: true,
    myRating: value,
    likes: enriched.likes,
    dislikes: enriched.dislikes,
    likePct: enriched.likePct,
    rating: enriched.rating
  });
});

// Favourites
app.post('/api/games/:id/favourite', requireAuth, (req, res) => {
  const gameId = req.params.id;
  if (!getEnrichedGame(gameId)) return res.status(404).json({ error: 'Game not found' });

  if (!req.user.favouriteGames) req.user.favouriteGames = [];
  const idx = req.user.favouriteGames.indexOf(gameId);
  let favourited;
  if (idx >= 0) {
    req.user.favouriteGames.splice(idx, 1);
    favourited = false;
  } else {
    req.user.favouriteGames.push(gameId);
    favourited = true;
  }

  const key = req.user.username.toLowerCase();
  if (store.users[key]) {
    store.users[key].favouriteGames = req.user.favouriteGames;
    persistUsers();
  }

  res.json({ success: true, favourited, favouriteGames: req.user.favouriteGames });
});

// Library
app.get('/api/library', requireAnyAuth, (req, res) => {
  const favIds = req.user.favouriteGames || [];
  const recentIds = req.user.recentlyPlayed || [];
  const all = getEnrichedGames();
  const byId = Object.fromEntries(all.map(g => [g.id, g]));

  res.json({
    favourites: favIds.map(id => byId[id]).filter(Boolean),
    recentlyPlayed: recentIds.map(id => byId[id]).filter(Boolean),
    created: [] // creator studio later
  });
});

// Discover feed (sections)
app.get('/api/discover', (req, res) => {
  const all = getEnrichedGames();
  const featured = all.filter(g => g.featured).slice(0, 6);
  const popular = [...all].sort((a, b) => b.players - a.players).slice(0, 8);
  const mostPlayed = [...all].sort((a, b) => b.visits - a.visits).slice(0, 8);
  const newest = [...all].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
  const topRated = [...all].sort((a, b) => b.likePct - a.likePct || b.likes - a.likes).slice(0, 8);
  const categories = [...new Set(all.map(g => g.category))].sort();

  res.json({ featured, popular, mostPlayed, newest, topRated, categories });
});

// ----- Auth: Register -----
app.post('/api/auth/register', rateLimitAuth, (req, res) => {
  const { username, password, confirmPassword, displayName } = req.body || {};

  const uErr = validateUsername(username);
  if (uErr) return res.status(400).json({ error: uErr });

  const pErr = validatePassword(password);
  if (pErr) return res.status(400).json({ error: pErr });

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  const key = username.trim().toLowerCase();
  if (store.users[key]) {
    return res.status(409).json({ error: 'Username is already taken' });
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const user = {
    id: uuidv4(),
    username: username.trim(),
    passwordHash,
    displayName: (displayName && String(displayName).trim().slice(0, 30)) || username.trim(),
    description: '',
    currency: 500,
    avatar: defaultAvatar(),
    inventory: [...STARTER_INV],
    friends: [],
    favouriteGames: [],
    recentlyPlayed: [],
    isGuest: false,
    createdAt: new Date().toISOString()
  };

  store.users[key] = user;
  persistUsers();

  const token = uuidv4();
  store.sessions[token] = {
    userId: user.id,
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  persistSessions();

  res.json({ success: true, token, user: publicUser(user) });
});

// ----- Auth: Login -----
app.post('/api/auth/login', rateLimitAuth, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = findUserByUsername(username.trim());
  if (!user || user.isGuest) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const ban = isBanned(user.username.toLowerCase()) || isBanned(user.id);
  if (ban) {
    return res.status(403).json({ error: 'Account restricted until ' + new Date(ban.until).toLocaleString(), banned: true });
  }

  const token = uuidv4();
  store.sessions[token] = {
    userId: user.id,
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  persistSessions();

  res.json({ success: true, token, user: publicUser(user) });
});

// ----- Auth: Guest -----
app.post('/api/auth/guest', rateLimitAuth, (req, res) => {
  const guestName = 'Guest_' + Math.floor(Math.random() * 100000);
  const torso = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
  const user = {
    id: uuidv4(),
    username: guestName,
    passwordHash: null,
    displayName: guestName,
    description: 'Playing as a guest',
    currency: 100,
    avatar: { ...defaultAvatar(), bodyColors: { ...defaultAvatar().bodyColors, torso } },
    inventory: [...STARTER_INV],
    friends: [],
    favouriteGames: [],
    isGuest: true,
    createdAt: new Date().toISOString()
  };

  // Guests are session-only (not written to users.json permanently under a login name)
  store.users['guest:' + user.id] = user;

  const token = uuidv4();
  store.sessions[token] = {
    userId: user.id,
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    isGuest: true
  };
  persistSessions();

  res.json({ success: true, token, user: publicUser(user) });
});

// ----- Auth: Logout -----
app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token && store.sessions[token]) {
    delete store.sessions[token];
    persistSessions();
  }
  res.json({ success: true });
});

// ----- Me -----
app.get('/api/me', requireAnyAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ----- Profile (public by username) -----
app.get('/api/profile/:username', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user || user.isGuest) return res.status(404).json({ error: 'Player not found' });
  res.json({
    profile: {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      description: user.description || '',
      avatar: user.avatar || defaultAvatar(),
      friendsCount: (user.friends || []).length,
      favouriteGames: user.favouriteGames || [],
      inventoryPreview: (user.inventory || []).slice(0, 12),
      createdAt: user.createdAt
      // currency intentionally omitted from public profile
    }
  });
});

// ----- Update own profile -----
app.patch('/api/me/profile', requireAuth, (req, res) => {
  const { displayName, description } = req.body || {};
  const user = req.user;

  if (displayName !== undefined) {
    const dn = String(displayName).trim();
    if (dn.length < 1) return res.status(400).json({ error: 'Display name cannot be empty' });
    if (dn.length > 30) return res.status(400).json({ error: 'Display name must be 30 characters or less' });
    user.displayName = dn;
  }
  if (description !== undefined) {
    const desc = String(description).slice(0, 300);
    user.description = desc;
  }

  // Persist under the username key
  const key = user.username.toLowerCase();
  if (store.users[key]) {
    store.users[key].displayName = user.displayName;
    store.users[key].description = user.description;
    persistUsers();
  }

  res.json({ success: true, user: publicUser(user) });
});

// ----- Save avatar (authenticated accounts only for permanent save) -----
app.post('/api/avatar', requireAnyAuth, (req, res) => {
  const cfg = req.body.avatar || req.body;
  if (!cfg || typeof cfg !== 'object') {
    return res.status(400).json({ error: 'Invalid avatar data' });
  }

  // Server-side shape validation (don't trust client blindly)
  const safe = {
    bodyColors: {
      head: String(cfg.bodyColors?.head || '#f5d0c5').slice(0, 9),
      torso: String(cfg.bodyColors?.torso || '#00a2ff').slice(0, 9),
      leftArm: String(cfg.bodyColors?.leftArm || '#f5d0c5').slice(0, 9),
      rightArm: String(cfg.bodyColors?.rightArm || '#f5d0c5').slice(0, 9),
      leftLeg: String(cfg.bodyColors?.leftLeg || '#1a1a2e').slice(0, 9),
      rightLeg: String(cfg.bodyColors?.rightLeg || '#1a1a2e').slice(0, 9)
    },
    face: cfg.face != null ? String(cfg.face).slice(0, 32) : 'default',
    hair: cfg.hair != null ? String(cfg.hair).slice(0, 32) : null,
    hat: cfg.hat != null ? String(cfg.hat).slice(0, 32) : null,
    shirt: cfg.shirt != null ? String(cfg.shirt).slice(0, 32) : null,
    pants: cfg.pants != null ? String(cfg.pants).slice(0, 32) : null,
    accessories: {
      head: cfg.accessories?.head != null ? String(cfg.accessories.head).slice(0, 32) : null,
      face: cfg.accessories?.face != null ? String(cfg.accessories.face).slice(0, 32) : null,
      back: cfg.accessories?.back != null ? String(cfg.accessories.back).slice(0, 32) : null,
      shoulder: cfg.accessories?.shoulder != null ? String(cfg.accessories.shoulder).slice(0, 32) : null
    }
  };

  req.user.avatar = safe;

  // Persist registered users to disk
  if (!req.user.isGuest) {
    const key = req.user.username.toLowerCase();
    if (store.users[key]) {
      store.users[key].avatar = safe;
      persistUsers();
    }
  }

  res.json({ success: true, avatar: safe });
});

// SPA fallback


// ========== SERVER GAMEPLAY VALIDATION FRAMEWORK ==========
// Clients request actions; server validates and mutates authoritative state.

function userSaveKey(user) {
  return user.isGuest ? ('guest:' + user.id) : user.username.toLowerCase();
}

function getGameSave(user, gameId) {
  const key = userSaveKey(user);
  if (!store.gameSaves[key]) store.gameSaves[key] = {};
  if (!store.gameSaves[key][gameId]) {
    store.gameSaves[key][gameId] = defaultGameSave(gameId);
  }
  return store.gameSaves[key][gameId];
}

function defaultGameSave(gameId) {
  if (gameId === 'harvest') {
    const plots = [];
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 2; z++) {
        plots.push({ x, z, stage: 0, plantedAt: null }); // stage 0 empty, 1-3 growing, 3 ready
      }
    }
    return { seeds: 10, money: 0, plots, version: 1 };
  }
  if (gameId === 'worldcraft') {
    // sparse block map "x,y,z" -> material index
    const blocks = {};
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) blocks[`${x},0,${z}`] = 0;
    return { blocks, material: 0, version: 1 };
  }
  if (gameId === 'clean-sweep') {
    const dirt = [];
    for (let i = 0; i < 20; i++) {
      dirt.push({
        id: 'd' + i,
        x: (Math.random() - 0.5) * 24,
        z: (Math.random() - 0.5) * 24,
        clean: 0,
        type: ['dust', 'mud', 'grime', 'stain'][i % 4]
      });
    }
    return { dirt, cleaned: 0, money: 0, tool: 'mop', jobsDone: 0, version: 1 };
  }
  if (gameId === 'lost-kingdom') {
    return {
      gold: 0,
      hasCrystal: false,
      quest: 'Find the temple crystal',
      pickups: Array.from({ length: 10 }, (_, i) => ({
        id: 'g' + i,
        x: (Math.random() - 0.5) * 60,
        z: (Math.random() - 0.5) * 60,
        taken: false
      })),
      inventory: [],
      version: 1
    };
  }
  if (gameId === 'mech-wars') {
    return {
      loadout: { head: 'basic', torso: 'basic', weapon: 'cannon', legs: 'basic' },
      unlocks: ['basic', 'cannon'],
      credits: 0,
      kills: 0,
      version: 1
    };
  }
  return { version: 1 };
}

function persistUserCurrency(user) {
  if (user.isGuest) return;
  const key = user.username.toLowerCase();
  if (store.users[key]) {
    store.users[key].currency = user.currency;
    persistUsers();
  }
}

function grantCurrency(user, amount, meta) {
  const add = Math.floor(Number(amount) || 0);
  if (add <= 0 || add > 5000) return false;
  user.currency = (user.currency || 0) + add;
  persistUserCurrency(user);
  logTransaction({
    type: meta.type || 'game_reward',
    userId: user.id,
    username: user.username,
    amount: add,
    balance: user.currency,
    gameId: meta.gameId,
    detail: meta.detail || null
  });
  return true;
}

// Shared: load game state
app.get('/api/game/:gameId/state', requireAnyAuth, (req, res) => {
  const gameId = String(req.params.gameId).slice(0, 32);
  const allowed = ['harvest', 'worldcraft', 'clean-sweep', 'lost-kingdom', 'mech-wars'];
  if (!allowed.includes(gameId)) return res.status(400).json({ error: 'Unknown game save' });
  const save = getGameSave(req.user, gameId);
  // grow harvest crops server-side on read
  if (gameId === 'harvest') {
    const now = Date.now();
    let changed = false;
    for (const plot of save.plots) {
      if (plot.stage >= 1 && plot.stage < 3 && plot.plantedAt) {
        const age = (now - plot.plantedAt) / 1000;
        // 4s per stage
        const newStage = Math.min(3, 1 + Math.floor(age / 4));
        if (newStage !== plot.stage) { plot.stage = newStage; changed = true; }
      }
    }
    if (changed) persistGameSaves();
  }
  res.json({
    state: save,
    currency: req.user.currency || 0,
    inventory: req.user.inventory || []
  });
});

// ----- HARVEST -----
app.post('/api/game/harvest/plant', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'harvest');
  const { x, z } = req.body || {};
  const plot = save.plots.find(p => p.x === Number(x) && p.z === Number(z));
  if (!plot) return res.status(400).json({ error: 'Invalid plot' });
  if (plot.stage !== 0) return res.status(400).json({ error: 'Plot occupied' });
  if (save.seeds < 1) return res.status(400).json({ error: 'No seeds' });
  save.seeds -= 1;
  plot.stage = 1;
  plot.plantedAt = Date.now();
  persistGameSaves();
  res.json({ success: true, state: save });
});

app.post('/api/game/harvest/harvest', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'harvest');
  const { x, z } = req.body || {};
  const plot = save.plots.find(p => p.x === Number(x) && p.z === Number(z));
  if (!plot) return res.status(400).json({ error: 'Invalid plot' });
  // server-side growth check
  if (plot.stage >= 1 && plot.plantedAt) {
    const age = (Date.now() - plot.plantedAt) / 1000;
    plot.stage = Math.min(3, 1 + Math.floor(age / 4));
  }
  if (plot.stage < 3) return res.status(400).json({ error: 'Crop not ready' });
  plot.stage = 0;
  plot.plantedAt = null;
  save.money = (save.money || 0) + 1; // crop units
  persistGameSaves();
  res.json({ success: true, state: save });
});

app.post('/api/game/harvest/sell', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'harvest');
  const units = Math.floor(save.money || 0);
  if (units < 1) return res.status(400).json({ error: 'Nothing to sell' });
  const payout = units * 25;
  save.money = 0;
  persistGameSaves();
  grantCurrency(req.user, payout, { type: 'harvest_sell', gameId: 'harvest', detail: { units } });
  res.json({ success: true, state: save, granted: payout, currency: req.user.currency });
});

app.post('/api/game/harvest/buy-seeds', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'harvest');
  const cost = 20;
  if ((req.user.currency || 0) < cost) return res.status(400).json({ error: 'Not enough currency' });
  req.user.currency -= cost;
  persistUserCurrency(req.user);
  save.seeds = (save.seeds || 0) + 5;
  persistGameSaves();
  logTransaction({ type: 'harvest_buy_seeds', userId: req.user.id, username: req.user.username, amount: -cost, balance: req.user.currency, gameId: 'harvest' });
  res.json({ success: true, state: save, currency: req.user.currency });
});

// ----- WORLDCRAFT -----
app.post('/api/game/worldcraft/place', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'worldcraft');
  let { x, y, z, material } = req.body || {};
  x = Math.round(Number(x)); y = Math.round(Number(y)); z = Math.round(Number(z));
  material = Math.floor(Number(material));
  if (![x, y, z].every(Number.isFinite)) return res.status(400).json({ error: 'Invalid coords' });
  if (y < 0 || y > 32 || Math.abs(x) > 40 || Math.abs(z) > 40) return res.status(400).json({ error: 'Out of bounds' });
  if (material < 0 || material > 5) return res.status(400).json({ error: 'Invalid material' });
  const key = `${x},${y},${z}`;
  if (save.blocks[key] != null) return res.status(400).json({ error: 'Block occupied' });
  // rate: max blocks
  if (Object.keys(save.blocks).length >= 2000) return res.status(400).json({ error: 'World block limit' });
  save.blocks[key] = material;
  persistGameSaves();
  res.json({ success: true, key, material, count: Object.keys(save.blocks).length });
});

app.post('/api/game/worldcraft/remove', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'worldcraft');
  let { x, y, z } = req.body || {};
  x = Math.round(Number(x)); y = Math.round(Number(y)); z = Math.round(Number(z));
  const key = `${x},${y},${z}`;
  if (save.blocks[key] == null) return res.status(400).json({ error: 'No block' });
  // protect starter platform lightly - allow remove but not below y0 starter if empty world
  delete save.blocks[key];
  persistGameSaves();
  res.json({ success: true, key, count: Object.keys(save.blocks).length });
});

app.get('/api/game/worldcraft/world', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'worldcraft');
  res.json({ blocks: save.blocks, material: save.material || 0 });
});

// ----- CLEAN SWEEP -----
app.post('/api/game/clean-sweep/clean', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'clean-sweep');
  const { id, tool, amount } = req.body || {};
  const dirt = save.dirt.find(d => d.id === id);
  if (!dirt) return res.status(400).json({ error: 'Invalid dirt' });
  if (dirt.clean >= 1) return res.status(400).json({ error: 'Already clean' });
  // client may report proximity progress but server clamps rate
  const t = tool === 'pressure' ? 'pressure' : 'mop';
  const add = Math.min(0.35, Math.max(0.05, Number(amount) || 0.15));
  const mult = t === 'pressure' ? 1.4 : 1;
  dirt.clean = Math.min(1, dirt.clean + add * mult);
  let rewarded = 0;
  if (dirt.clean >= 1) {
    dirt.clean = 1;
    save.cleaned = (save.cleaned || 0) + 1;
    rewarded = 15;
    grantCurrency(req.user, rewarded, { type: 'clean_dirt', gameId: 'clean-sweep', detail: { id } });
  }
  persistGameSaves();
  res.json({ success: true, dirt, cleaned: save.cleaned, granted: rewarded, currency: req.user.currency });
});

app.post('/api/game/clean-sweep/complete-job', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'clean-sweep');
  const total = save.dirt.length;
  const done = save.dirt.filter(d => d.clean >= 1).length;
  if (done < total) return res.status(400).json({ error: 'Job incomplete', done, total });
  if (save.jobClaimed) return res.status(400).json({ error: 'Job already claimed' });
  save.jobClaimed = true;
  save.jobsDone = (save.jobsDone || 0) + 1;
  const bonus = 100;
  persistGameSaves();
  grantCurrency(req.user, bonus, { type: 'clean_job', gameId: 'clean-sweep' });
  res.json({ success: true, granted: bonus, currency: req.user.currency, jobsDone: save.jobsDone });
});

// ----- LOST KINGDOM -----
app.post('/api/game/lost-kingdom/pickup', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'lost-kingdom');
  const { id, px, pz } = req.body || {};
  const item = save.pickups.find(p => p.id === id);
  if (!item || item.taken) return res.status(400).json({ error: 'Invalid pickup' });
  // validate proximity (client position claim, clamped)
  const dx = Number(px) - item.x, dz = Number(pz) - item.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) > 4) {
    return res.status(400).json({ error: 'Too far from pickup' });
  }
  item.taken = true;
  save.gold = (save.gold || 0) + 10;
  persistGameSaves();
  res.json({ success: true, state: save });
});

app.post('/api/game/lost-kingdom/crystal', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'lost-kingdom');
  const { px, pz } = req.body || {};
  if (save.hasCrystal) return res.status(400).json({ error: 'Already obtained' });
  // temple at 0,-30
  if (Math.hypot(Number(px) || 0, (Number(pz) || 0) + 30) > 6) {
    return res.status(400).json({ error: 'Not at temple' });
  }
  save.hasCrystal = true;
  save.quest = 'Crystal recovered — explore freely';
  save.gold = (save.gold || 0) + 100;
  persistGameSaves();
  grantCurrency(req.user, 50, { type: 'quest_crystal', gameId: 'lost-kingdom' });
  res.json({ success: true, state: save, currency: req.user.currency });
});

// ----- MECH WARS loadout / unlocks -----
app.post('/api/game/mech-wars/loadout', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'mech-wars');
  const { head, torso, weapon, legs } = req.body || {};
  const unlocks = new Set(save.unlocks || ['basic', 'cannon']);
  const next = {
    head: String(head || save.loadout.head).slice(0, 24),
    torso: String(torso || save.loadout.torso).slice(0, 24),
    weapon: String(weapon || save.loadout.weapon).slice(0, 24),
    legs: String(legs || save.loadout.legs).slice(0, 24)
  };
  for (const v of Object.values(next)) {
    if (!unlocks.has(v) && v !== 'basic' && v !== 'cannon') {
      return res.status(400).json({ error: 'Component not unlocked: ' + v });
    }
  }
  save.loadout = next;
  persistGameSaves();
  res.json({ success: true, loadout: save.loadout });
});

app.post('/api/game/mech-wars/unlock', requireAnyAuth, (req, res) => {
  const save = getGameSave(req.user, 'mech-wars');
  const catalog = { heavy: 200, laser: 350, shield: 150, sprint: 250 };
  const { item } = req.body || {};
  const cost = catalog[item];
  if (!cost) return res.status(400).json({ error: 'Unknown item' });
  if ((save.unlocks || []).includes(item)) return res.status(400).json({ error: 'Already unlocked' });
  if ((req.user.currency || 0) < cost) return res.status(400).json({ error: 'Not enough currency' });
  req.user.currency -= cost;
  persistUserCurrency(req.user);
  save.unlocks = save.unlocks || ['basic', 'cannon'];
  save.unlocks.push(item);
  persistGameSaves();
  logTransaction({ type: 'mech_unlock', userId: req.user.id, username: req.user.username, amount: -cost, balance: req.user.currency, gameId: 'mech-wars', detail: { item } });
  res.json({ success: true, unlocks: save.unlocks, currency: req.user.currency });
});

app.post('/api/game/mech-wars/match-result', requireAnyAuth, (req, res) => {
  // Only grants a capped reward; actual kills in sim rooms already server-scored
  const { kills } = req.body || {};
  const k = Math.min(20, Math.max(0, Math.floor(Number(kills) || 0)));
  const grant = k * 5;
  const save = getGameSave(req.user, 'mech-wars');
  save.kills = (save.kills || 0) + k;
  persistGameSaves();
  if (grant > 0) grantCurrency(req.user, grant, { type: 'mech_match', gameId: 'mech-wars', detail: { kills: k } });
  res.json({ success: true, granted: grant, currency: req.user.currency, kills: save.kills });
});


// ----- Anti-cheat: server rewards (never trust client currency) -----
app.post('/api/rewards/claim', requireAuth, (req, res) => {
  const { kind, gameId, amount } = req.body || {};
  const allowed = {
    match_complete: 25,
    daily_bonus: 50,
    tutorial: 10
  };
  if (!allowed[kind]) {
    acLog({ severity: 'flag', playerId: req.user.id, playerName: req.user.username, reason: 'invalid_reward_claim', detail: { kind, amount } });
    return res.status(400).json({ error: 'Invalid reward type' });
  }
  // Rate: one of each kind per 10 minutes
  if (!req.user.rewardClaims) req.user.rewardClaims = {};
  const last = req.user.rewardClaims[kind] || 0;
  if (Date.now() - last < 10 * 60 * 1000) {
    return res.status(429).json({ error: 'Reward on cooldown' });
  }
  let grant = allowed[kind];
  if (typeof amount === 'number' && amount > grant) {
    addStrike(req.user.username.toLowerCase(), 2, {
      name: req.user.username, reason: 'reward_amount_tamper', detail: { amount, grant }
    });
    return res.status(400).json({ error: 'Invalid reward amount' });
  }
  req.user.rewardClaims[kind] = Date.now();
  req.user.currency = (req.user.currency || 0) + grant;
  logTransaction({
    type: 'reward', userId: req.user.id, username: req.user.username,
    kind, amount: grant, balance: req.user.currency, gameId: gameId || null
  });
  if (!req.user.isGuest) {
    const key = req.user.username.toLowerCase();
    if (store.users[key]) {
      store.users[key].currency = req.user.currency;
      store.users[key].rewardClaims = req.user.rewardClaims;
      persistUsers();
    }
  }
  res.json({ success: true, granted: grant, currency: req.user.currency });
});

// Reject any direct currency/inventory spoof attempts
app.post('/api/me/currency', (req, res) => {
  acLog({ severity: 'flag', playerId: 'unknown', reason: 'currency_endpoint_probe', detail: { ip: req.ip } });
  res.status(403).json({ error: 'Currency is server-authoritative' });
});
app.post('/api/me/inventory', (req, res) => {
  acLog({ severity: 'flag', playerId: 'unknown', reason: 'inventory_endpoint_probe', detail: { ip: req.ip } });
  res.status(403).json({ error: 'Inventory is server-authoritative' });
});

// ----- Admin anti-cheat console -----
app.get('/api/admin/ac/logs', requireAdmin, (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
  res.json({
    logs: store.anticheat.logs.slice(-limit).reverse(),
    strikes: store.anticheat.strikes,
    bans: store.anticheat.bans,
    suspicion: store.anticheat.suspicion
  });
});

app.get('/api/admin/ac/summary', requireAdmin, (req, res) => {
  const openFlags = (store.anticheat.flags || []).filter(f => f.status === 'open');
  res.json({
    logCount: store.anticheat.logs.length,
    banCount: Object.keys(store.anticheat.bans).length,
    strikeEntries: Object.keys(store.anticheat.strikes).length,
    openFlags: openFlags.length,
    suspicionEntries: Object.keys(store.anticheat.suspicion || {}).length,
    recent: store.anticheat.logs.slice(-10).reverse(),
    flaggedPlayers: openFlags.slice(-20).reverse()
  });
});

app.get('/api/admin/ac/flags', requireAdmin, (req, res) => {
  const status = req.query.status || 'open';
  let flags = store.anticheat.flags || [];
  if (status !== 'all') flags = flags.filter(f => f.status === status);
  res.json({ flags: flags.slice(-100).reverse() });
});

app.post('/api/admin/ac/flags/:id/dismiss', requireAdmin, (req, res) => {
  const f = (store.anticheat.flags || []).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Flag not found' });
  f.status = 'dismissed';
  f.reviewedAt = new Date().toISOString();
  f.reviewNote = String((req.body && req.body.note) || 'Dismissed').slice(0, 200);
  adminAudit('dismiss_flag', { flagId: f.id, playerKey: f.playerKey });
  persistAC();
  res.json({ success: true, flag: f });
});

app.post('/api/admin/ac/flags/:id/escalate', requireAdmin, (req, res) => {
  const f = (store.anticheat.flags || []).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Flag not found' });
  f.status = 'escalated';
  f.reviewedAt = new Date().toISOString();
  addStrike(f.playerKey, 3, {
    name: f.playerName,
    reason: 'escalated_flag:' + f.reason,
    category: f.category,
    permanent: !!(req.body && req.body.permanent),
    banMs: (req.body && req.body.hours) ? Number(req.body.hours) * 3600000 : AC.BAN_MS
  });
  adminAudit('escalate_flag', { flagId: f.id, playerKey: f.playerKey });
  persistAC();
  res.json({ success: true, flag: f });
});

app.post('/api/admin/ac/ban', requireAdmin, (req, res) => {
  const { playerKey, reason, hours, permanent } = req.body || {};
  if (!playerKey) return res.status(400).json({ error: 'playerKey required' });
  const key = String(playerKey);
  if (permanent) {
    store.anticheat.bans[key] = {
      until: null, permanent: true,
      reason: String(reason || 'Permanent ban').slice(0, 200),
      at: new Date().toISOString(), manual: true
    };
  } else {
    const ms = Math.max(1, Number(hours) || 1) * 3600 * 1000;
    store.anticheat.bans[key] = {
      until: Date.now() + ms, permanent: false,
      reason: String(reason || 'Manual ban').slice(0, 200),
      at: new Date().toISOString(), manual: true
    };
  }
  persistAC();
  acLog({ severity: 'ban', playerId: key, reason: permanent ? 'manual_perm_ban' : 'manual_ban', detail: { reason, hours, permanent } });
  adminAudit('ban', { playerKey: key, reason, hours, permanent: !!permanent });
  res.json({ success: true });
});

app.post('/api/admin/ac/unban', requireAdmin, (req, res) => {
  const { playerKey } = req.body || {};
  if (!playerKey) return res.status(400).json({ error: 'playerKey required' });
  clearBan(String(playerKey));
  acLog({ severity: 'info', playerId: playerKey, reason: 'manual_unban' });
  adminAudit('unban', { playerKey });
  res.json({ success: true });
});

app.get('/api/admin/ac/transactions', requireAdmin, (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
  res.json({ transactions: store.transactions.slice(-limit).reverse() });
});

app.get('/api/admin/ac/audit', requireAdmin, (req, res) => {
  res.json({ audit: (store.anticheat.adminAudit || []).slice(-100).reverse() });
});

// Tester mode – isolated from normal suspicion for controlled sims
app.post('/api/admin/ac/testers', requireAdmin, (req, res) => {
  const { username, remove } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const u = String(username).toLowerCase();
  if (!store.anticheat.testerIds) store.anticheat.testerIds = [];
  if (remove) {
    store.anticheat.testerIds = store.anticheat.testerIds.filter(x => x !== u);
  } else if (!store.anticheat.testerIds.includes(u)) {
    store.anticheat.testerIds.push(u);
  }
  adminAudit(remove ? 'remove_tester' : 'add_tester', { username: u });
  persistAC();
  res.json({ success: true, testers: store.anticheat.testerIds });
});

app.post('/api/admin/ac/simulate', requireAdmin, (req, res) => {
  // Controlled exploit simulation for testers – does not ban real accounts
  const { exploit, playerKey } = req.body || {};
  const key = String(playerKey || 'sim_tester');
  const exploits = {
    speed: () => addSuspicion(key, 8, { name: key, reason: 'sim_speed', category: 'movement' }),
    teleport: () => addSuspicion(key, 15, { name: key, reason: 'sim_teleport', category: 'movement' }),
    damage: () => addSuspicion(key, 12, { name: key, reason: 'sim_damage', category: 'combat' }),
    reward_tamper: () => addStrike(key, 2, { name: key, reason: 'sim_reward_tamper', category: 'economy' }),
    flood: () => addSuspicion(key, 10, { name: key, reason: 'sim_event_flood', category: 'exploit' })
  };
  if (!exploits[exploit]) return res.status(400).json({ error: 'Unknown exploit. Use: ' + Object.keys(exploits).join(', ') });
  const result = exploits[exploit]();
  adminAudit('simulate_exploit', { exploit, playerKey: key, result });
  res.json({ success: true, exploit, result, note: 'Simulation logged. Review flags/logs.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// ========== SERVER GAME SIMULATION ==========
// Clients send inputs; server owns positions, projectiles, damage, scores.

const SIM_TICK_MS = 50; // 20 Hz
const SIM_GAMES = new Set([
  'rocket-royale', 'mech-wars', 'afterimage', 'overdrive',
  'battle-arena', 'human-disaster'
]);

function isSimGame(roomId) {
  const id = String(roomId || '');
  // room format: gameId or gameId:matchCode
  const base = id.split(':')[0];
  return SIM_GAMES.has(base);
}

function simBaseId(roomId) {
  return String(roomId || '').split(':')[0];
}

/** Create authoritative match state */
function createSimState(gameId) {
  const bots = [];
  const botCount = gameId === 'rocket-royale' ? 6 : gameId === 'human-disaster' ? 0 : 4;
  for (let i = 0; i < botCount; i++) {
    bots.push({
      id: 'bot_' + i,
      name: 'Bot ' + (i + 1),
      x: (Math.random() - 0.5) * 40,
      y: 0,
      z: (Math.random() - 0.5) * 40,
      yaw: Math.random() * Math.PI * 2,
      vx: 0, vy: 0, vz: 0,
      hp: 100,
      score: 0,
      isBot: true,
      shootCd: Math.random(),
      color: '#7e57c2'
    });
  }
  return {
    gameId,
    phase: 'countdown', // countdown | live | ended
    timeLeft: gameId === 'rocket-royale' ? 300 : 180,
    countdown: 10,
    projectiles: [],
    bots,
    events: [], // short-lived for clients (hits, explosions)
    matchId: uuidv4()
  };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function simApplyInput(p, input, dt, gameId) {
  if (!input || p.dead) return;
  const speed = gameId === 'rocket-royale' ? 14 : gameId === 'afterimage' ? 16 : 11;
  const jump = gameId === 'rocket-royale' ? 10 : 12;
  const yaw = typeof input.yaw === 'number' ? input.yaw : p.yaw;
  const pitch = typeof input.pitch === 'number' ? input.pitch : (p.pitch || 0);
  p.yaw = yaw;
  p.pitch = pitch;

  const forward = (input.f ? 1 : 0) + (input.b ? -1 : 0);
  const strafe = (input.r ? 1 : 0) + (input.l ? -1 : 0);
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  let dx = (strafe * cos + forward * sin);
  let dz = (-strafe * sin + forward * cos);
  const len = Math.hypot(dx, dz) || 1;
  const sprint = input.sprint ? 1.35 : 1;
  if (forward || strafe) {
    p.vx = (dx / len) * speed * sprint;
    p.vz = (dz / len) * speed * sprint;
  } else {
    p.vx *= 0.85;
    p.vz *= 0.85;
  }

  // rocket jump / shoot recoil handled on fire
  if (input.jump && p.grounded) {
    p.vy = jump;
    p.grounded = false;
  }

  p.vy -= (gameId === 'rocket-royale' ? 22 : 28) * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.z += p.vz * dt;

  // bounds
  p.x = clamp(p.x, -50, 50);
  p.z = clamp(p.z, -50, 50);

  if (p.y <= 0) {
    p.y = 0;
    p.vy = 0;
    p.grounded = true;
    p.vx *= 0.9;
    p.vz *= 0.9;
  }

  // fire
  p.shootCd = Math.max(0, (p.shootCd || 0) - dt);
  if (input.fire && p.shootCd <= 0 && !p.dead) {
    p.shootCd = gameId === 'rocket-royale' ? 0.7 : 0.35;
    const pr = {
      id: uuidv4().slice(0, 8),
      from: p.id,
      x: p.x,
      y: p.y + 1.4,
      z: p.z,
      vx: Math.sin(yaw) * Math.cos(pitch) * (gameId === 'rocket-royale' ? 45 : 40),
      vy: Math.sin(pitch) * (gameId === 'rocket-royale' ? 45 : 0),
      vz: Math.cos(yaw) * Math.cos(pitch) * (gameId === 'rocket-royale' ? 45 : 40),
      life: 2.5,
      dmg: gameId === 'rocket-royale' ? 50 : 20,
      radius: gameId === 'rocket-royale' ? 4 : 1.5,
      type: gameId === 'rocket-royale' ? 'rocket' : 'bolt'
    };
    // rocket self-recoil
    if (gameId === 'rocket-royale') {
      p.vx -= Math.sin(yaw) * Math.cos(pitch) * 8;
      p.vy -= Math.sin(pitch) * 8 + 2;
      p.vz -= Math.cos(yaw) * Math.cos(pitch) * 8;
      p.grounded = false;
    }
    return pr;
  }
  return null;
}

function simExplode(sim, pos, dmg, radius, ownerId, playersMap) {
  const victims = [];
  const apply = (ent) => {
    if (ent.dead) return;
    const dx = ent.x - pos.x, dy = (ent.y + 1) - pos.y, dz = ent.z - pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > radius + 1) return;
    const falloff = 1 - dist / (radius + 1);
    let damage = dmg * falloff * (dist < 1.2 ? 1.3 : 1);
    // self-damage reduced for rockets
    if (ent.id === ownerId) damage *= 0.45;
    ent.hp -= damage;
    const push = Math.max(0.1, falloff) * 12;
    const inv = dist > 0.01 ? 1 / dist : 1;
    ent.vx += dx * inv * push;
    ent.vy += Math.abs(dy * inv * push) + 3;
    ent.vz += dz * inv * push;
    ent.grounded = false;
    if (ent.hp <= 0) {
      ent.hp = 0;
      ent.dead = true;
      ent.respawnAt = Date.now() + 3000;
      victims.push(ent.id);
      if (ent.id !== ownerId) {
        const killer = playersMap.get(ownerId) || sim.bots.find(b => b.id === ownerId);
        if (killer) killer.score = (killer.score || 0) + 1;
      }
    }
  };
  for (const p of playersMap.values()) apply(p);
  for (const b of sim.bots) apply(b);
  sim.events.push({ type: 'explode', x: pos.x, y: pos.y, z: pos.z, t: Date.now() });
  return victims;
}

function simTickRoom(room) {
  if (!room.sim) return;
  const sim = room.sim;
  const dt = SIM_TICK_MS / 1000;
  const gameId = sim.gameId;
  const playersMap = room.players;

  // phases
  if (sim.phase === 'countdown') {
    sim.countdown -= dt;
    if (sim.countdown <= 0) {
      sim.phase = 'live';
      sim.countdown = 0;
    }
  } else if (sim.phase === 'live') {
    sim.timeLeft -= dt;
    if (sim.timeLeft <= 0) {
      sim.phase = 'ended';
      sim.timeLeft = 0;
    }
  }

  sim.events = sim.events.filter(e => Date.now() - e.t < 300);

  // players
  if (sim.phase === 'live') {
    for (const p of playersMap.values()) {
      // init physics fields
      if (p.vx == null) { p.vx = 0; p.vy = 0; p.vz = 0; p.grounded = true; p.shootCd = 0; p.dead = false; p.hp = p.hp || 100; }
      if (p.dead) {
        if (p.respawnAt && Date.now() >= p.respawnAt) {
          p.dead = false;
          p.hp = 100;
          p.x = (Math.random() - 0.5) * 30;
          p.y = 2;
          p.z = (Math.random() - 0.5) * 30;
          p.vx = p.vy = p.vz = 0;
          p.respawnAt = null;
        }
        continue;
      }
      const pr = simApplyInput(p, p.input, dt, gameId);
      if (pr) sim.projectiles.push(pr);
      p.input = p.input || {}; // keep last for held keys; fire is edge-cleared
      if (p.input) p.input.fire = false;
      if (p.input) p.input.jump = false;
    }

    // bots simple AI
    for (const b of sim.bots) {
      if (b.vx == null) { b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = true; }
      if (b.dead) {
        if (b.respawnAt && Date.now() >= b.respawnAt) {
          b.dead = false; b.hp = 100;
          b.x = (Math.random() - 0.5) * 30; b.y = 0; b.z = (Math.random() - 0.5) * 30;
          b.respawnAt = null;
        }
        continue;
      }
      // chase nearest human
      let nearest = null, nd = 1e9;
      for (const p of playersMap.values()) {
        if (p.dead) continue;
        const d = Math.hypot(p.x - b.x, p.z - b.z);
        if (d < nd) { nd = d; nearest = p; }
      }
      if (nearest) {
        const yaw = Math.atan2(nearest.x - b.x, nearest.z - b.z);
        b.yaw = yaw;
        b.input = { f: nd > 6, fire: nd < 25 && Math.random() < 0.02, yaw, pitch: 0 };
      } else {
        b.input = { yaw: b.yaw, pitch: 0 };
      }
      const pr = simApplyInput(b, b.input, dt, gameId);
      if (pr) sim.projectiles.push(pr);
    }
  }

  // projectiles
  for (let i = sim.projectiles.length - 1; i >= 0; i--) {
    const pr = sim.projectiles[i];
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.z += pr.vz * dt;
    if (pr.type === 'rocket') pr.vy -= 6 * dt;
    pr.life -= dt;
    let hit = pr.y <= 0.4 || pr.life <= 0;
    if (!hit) {
      for (const p of playersMap.values()) {
        if (p.id === pr.from || p.dead) continue;
        if (Math.hypot(p.x - pr.x, (p.y + 1) - pr.y, p.z - pr.z) < 1.3) { hit = true; break; }
      }
      for (const b of sim.bots) {
        if (b.id === pr.from || b.dead) continue;
        if (Math.hypot(b.x - pr.x, (b.y + 1) - pr.y, b.z - pr.z) < 1.3) { hit = true; break; }
      }
    }
    if (hit) {
      if (pr.type === 'rocket' || pr.radius > 2) {
        simExplode(sim, { x: pr.x, y: pr.y, z: pr.z }, pr.dmg, pr.radius, pr.from, playersMap);
      } else {
        // hitscan-ish bolt damage to nearest
        for (const p of playersMap.values()) {
          if (p.id === pr.from || p.dead) continue;
          if (Math.hypot(p.x - pr.x, (p.y + 1) - pr.y, p.z - pr.z) < 1.8) {
            p.hp -= pr.dmg;
            if (p.hp <= 0) {
              p.dead = true; p.hp = 0; p.respawnAt = Date.now() + 3000;
              const killer = playersMap.get(pr.from) || sim.bots.find(b => b.id === pr.from);
              if (killer) killer.score = (killer.score || 0) + 1;
            }
            sim.events.push({ type: 'hit', x: pr.x, y: pr.y, z: pr.z, t: Date.now() });
          }
        }
        for (const b of sim.bots) {
          if (b.id === pr.from || b.dead) continue;
          if (Math.hypot(b.x - pr.x, (b.y + 1) - pr.y, b.z - pr.z) < 1.8) {
            b.hp -= pr.dmg;
            if (b.hp <= 0) {
              b.dead = true; b.hp = 0; b.respawnAt = Date.now() + 3000;
              const killer = playersMap.get(pr.from);
              if (killer) killer.score = (killer.score || 0) + 1;
            }
          }
        }
      }
      sim.projectiles.splice(i, 1);
    }
  }
}

function simSnapshot(room, forId) {
  const sim = room.sim;
  if (!sim) return null;
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw || 0,
      pitch: p.pitch || 0,
      hp: p.hp ?? 100,
      score: p.score || 0,
      dead: !!p.dead,
      color: p.color,
      you: p.id === forId
    });
  }
  for (const b of sim.bots) {
    players.push({
      id: b.id, name: b.name, x: b.x, y: b.y, z: b.z,
      yaw: b.yaw || 0, hp: b.hp, score: b.score || 0, dead: !!b.dead,
      color: b.color, isBot: true
    });
  }
  return {
    type: 'sim',
    matchId: sim.matchId,
    gameId: sim.gameId,
    phase: sim.phase,
    timeLeft: Math.max(0, sim.timeLeft),
    countdown: Math.max(0, sim.countdown),
    players,
    projectiles: sim.projectiles.map(pr => ({
      id: pr.id, x: pr.x, y: pr.y, z: pr.z, type: pr.type
    })),
    events: sim.events
  };
}


// ========== MULTIPLAYER (WebSocket) ==========
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Room>} */
const rooms = new Map();
const TICK_MS = 50; // 20 Hz – smooth + light
const PLAYER_TIMEOUT = 15000;

function getRoom(id) {
  if (!rooms.has(id)) {
    const room = {
      id,
      players: new Map(),
      lastTick: Date.now(),
      sim: null
    };
    if (isSimGame(id)) {
      room.sim = createSimState(simBaseId(id));
    }
    rooms.set(id, room);
  }
  return rooms.get(id);
}

function publicPlayers(room, exceptId) {
  const list = [];
  for (const [id, p] of room.players) {
    if (id === exceptId) continue;
    if (Date.now() - p.lastSeen > PLAYER_TIMEOUT) continue;
    list.push({
      id: p.id,
      name: p.name,
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw,
      color: p.color,
      avatar: p.avatar,
      hp: p.hp,
      score: p.score,
      anim: p.anim
    });
  }
  return list;
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of room.players) {
    if (id === exceptId) continue;
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.send(data); } catch (e) {}
    }
  }
}

wss.on('connection', (ws, req) => {
  let clientId = null;
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === 'join') {
      // leave previous
      if (clientId && roomId && rooms.has(roomId)) {
        const old = rooms.get(roomId);
        old.players.delete(clientId);
        broadcast(old, { type: 'leave', id: clientId });
      }

      roomId = String(msg.room || 'lobby').slice(0, 64);
      clientId = String(msg.id || uuidv4()).slice(0, 64);
      const room = getRoom(roomId);
      const playerName = String(msg.name || 'Player').slice(0, 24);
      const userKey = String(msg.userKey || playerName).slice(0, 64).toLowerCase();
      const ban = isBanned(userKey) || isBanned(playerName.toLowerCase());
      if (ban) {
        try {
          ws.send(JSON.stringify({ type: 'ac', action: 'ban', reason: ban.reason || 'Banned', until: ban.until, permanent: !!ban.permanent }));
          ws.close();
        } catch (e) {}
        return;
      }

      const player = {
        id: clientId,
        ws,
        name: playerName,
        userKey,
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
        yaw: Number(msg.yaw) || 0,
        color: msg.color || '#00a2ff',
        avatar: msg.avatar || null,
        hp: 100,
        score: 0,
        anim: 'idle',
        lastSeen: Date.now(),
        ac: null,
        isTester: isTester(userKey)
      };
      room.players.set(clientId, player);

      // Init physics fields for sim rooms
      if (room.sim) {
        player.vx = 0; player.vy = 0; player.vz = 0;
        player.grounded = true; player.input = {};
        player.hp = 100; player.score = 0; player.dead = false;
        player.x = (Math.random() - 0.5) * 20;
        player.y = 0;
        player.z = (Math.random() - 0.5) * 20;
      }

      // Welcome + snapshot
      ws.send(JSON.stringify({
        type: 'welcome',
        id: clientId,
        room: roomId,
        players: publicPlayers(room, clientId),
        tickMs: TICK_MS,
        sim: !!room.sim,
        gameId: room.sim ? room.sim.gameId : null
      }));
      if (room.sim) {
        ws.send(JSON.stringify(simSnapshot(room, clientId)));
      }

      broadcast(room, {
        type: 'join',
        player: {
          id: player.id, name: player.name,
          x: player.x, y: player.y, z: player.z, yaw: player.yaw,
          color: player.color, avatar: player.avatar, hp: player.hp, score: player.score
        }
      }, clientId);
      return;
    }

    if (!clientId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(clientId);
    if (!player) return;
    player.lastSeen = Date.now();

    const banKey = player.userKey || player.name || clientId;
    if (isBanned(banKey)) {
      try { ws.send(JSON.stringify({ type: 'ac', action: 'ban', reason: 'Banned' })); ws.close(); } catch (e) {}
      return;
    }

    // Authoritative input for simulated games
    if (msg.type === 'input' && room.sim) {
      const inp = msg.input || msg;
      player.input = {
        f: !!inp.f, b: !!inp.b, l: !!inp.l, r: !!inp.r,
        jump: !!inp.jump, fire: !!inp.fire, sprint: !!inp.sprint,
        yaw: typeof inp.yaw === 'number' ? inp.yaw : player.yaw,
        pitch: typeof inp.pitch === 'number' ? clamp(inp.pitch, -1.4, 1.4) : (player.pitch || 0)
      };
      return;
    }

    // Lobby / non-sim: validated state
    if (msg.type === 'state' && room.sim) {
      // ignore position spoofing in sim rooms
      return;
    }

    if (msg.type === 'state') {
      const result = validateMovement(player, msg, roomId);
      // Testers still get detected but soft-logged for lab runs
      if (result.flags.length) {
        const severe = result.flags.some(f => ['teleport', 'msg_flood', 'noclip', 'fly'].includes(f));
        if (player.isTester) {
          acLog({ severity: 'info', playerId: banKey, playerName: player.name, reason: 'tester_' + result.flags.join(','), category: 'test', room: roomId });
        } else if (severe) {
          addStrike(banKey, result.flags.includes('teleport') ? 2 : 1, {
            name: player.name, reason: result.flags.join(','), category: 'movement', detail: result.flags, room: roomId
          });
        } else {
          player.ac.softFlags = (player.ac.softFlags || 0) + 1;
          if (player.ac.softFlags >= 8) {
            player.ac.softFlags = 0;
            addSuspicion(banKey, 6, { name: player.name, reason: result.flags.join(','), category: 'movement', room: roomId });
          }
        }
      }
      if (!result.ok && !player.isTester) {
        try { ws.send(JSON.stringify({ type: 'ac', action: 'correct', x: player.x, y: player.y, z: player.z })); } catch (e) {}
        return;
      }
      if (result.ok || player.isTester) {
        player.x = result.x; player.y = result.y; player.z = result.z; player.yaw = result.yaw; player.hp = result.hp;
      }
      if (msg.anim) player.anim = String(msg.anim).slice(0, 16);
      // score never from client
      return;
    }

    if (msg.type === 'event') {
      if (isRestricted(banKey) && !player.isTester) {
        try { ws.send(JSON.stringify({ type: 'ac', action: 'restrict', reason: 'Actions restricted' })); } catch (e) {}
        return;
      }
      const v = validateEvent(player, msg);
      if (!v.ok) {
        if (player.isTester) acLog({ severity: 'info', playerId: banKey, reason: 'tester_' + v.reason, category: 'test' });
        else addStrike(banKey, 1, { name: player.name, reason: v.reason, category: v.category || 'combat', room: roomId });
        return;
      }
      if (msg.event === 'kill') player.score = (player.score || 0) + 1;
      broadcast(room, { type: 'event', from: clientId, name: player.name, event: msg.event, data: msg.data || {} }, null);
      return;
    }

    if (msg.type === 'chat') {
      const now = Date.now();
      if (!player.ac) player.ac = { chatAt: 0 };
      if (now - (player.ac.chatAt || 0) < AC.CHAT_RATE_MS) return;
      player.ac.chatAt = now;
      const textMsg = String(msg.text || '').slice(0, 120);
      if (!textMsg) return;
      broadcast(room, { type: 'chat', from: clientId, name: player.name, text: textMsg }, null);
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    }
  });

  ws.on('close', () => {
    if (clientId && roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.players.delete(clientId);
      broadcast(room, { type: 'leave', id: clientId });
      if (room.players.size === 0) rooms.delete(roomId);
    }
  });
});

// Snapshot + simulation loop
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const [id, p] of room.players) {
      if (now - p.lastSeen > PLAYER_TIMEOUT) {
        room.players.delete(id);
        broadcast(room, { type: 'leave', id });
      }
    }
    if (room.players.size === 0) {
      if (room.sim) room.sim = null;
      continue;
    }

    if (room.sim) {
      simTickRoom(room);
      for (const p of room.players.values()) {
        if (p.ws && p.ws.readyState === 1) {
          try { p.ws.send(JSON.stringify(simSnapshot(room, p.id))); } catch (e) {}
        }
      }
    } else {
      const snapshot = { type: 'snapshot', t: now, players: publicPlayers(room, null) };
      const data = JSON.stringify(snapshot);
      for (const p of room.players.values()) {
        if (p.ws && p.ws.readyState === 1) {
          try { p.ws.send(data); } catch (e) {}
        }
      }
    }
  }
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 BlockForge multiplayer at http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   Users: ${Object.values(store.users).filter(u => !u.isGuest).length}\n`);
});
