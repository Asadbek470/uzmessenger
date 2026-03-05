// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const sqlite3 = require("sqlite3").verbose();
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

const DB_FILE = path.join(__dirname, "database.db");
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/", express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database(DB_FILE);

// ---------- Helpers ----------
function nowISO() {
  return new Date().toISOString();
}
function rand6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function safeUsername(u) {
  return typeof u === "string" && /^[a-z0-9_]{4,20}$/.test(u);
}
function chatKeyToParts(chat) {
  // chat can be: "global", "@username", "group:123"
  if (chat === "global") return { type: "global" };
  if (chat.startsWith("@")) return { type: "dm", peer: chat.slice(1) };
  if (chat.startsWith("group:")) return { type: "group", groupId: Number(chat.split(":")[1]) };
  return null;
}
function ok(res, payload = {}) {
  res.json({ ok: true, ...payload });
}
function bad(res, error = "Unknown error", code = 400) {
  res.status(code).json({ ok: false, error });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await dbRun(`PRAGMA journal_mode=WAL;`);

  await dbRun(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    displayName TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    avatarUrl TEXT DEFAULT '',
    birthDate TEXT DEFAULT '',
    createdAt TEXT NOT NULL,
    lastSeen TEXT DEFAULT '',
    blockedUntil TEXT DEFAULT '',
    canSendText INTEGER DEFAULT 1,
    canSendMedia INTEGER DEFAULT 1,
    canCall INTEGER DEFAULT 1
  )`);

  await dbRun(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatType TEXT NOT NULL,
    groupId INTEGER DEFAULT NULL,
    user1 TEXT DEFAULT NULL,
    user2 TEXT DEFAULT NULL,
    sender TEXT NOT NULL,
    receiver TEXT DEFAULT NULL,
    text TEXT DEFAULT '',
    mediaType TEXT DEFAULT '',
    mediaUrl TEXT DEFAULT '',
    createdAt TEXT NOT NULL
  )`);

  await dbRun(`
  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    text TEXT DEFAULT '',
    mediaType TEXT DEFAULT '',
    mediaUrl TEXT DEFAULT '',
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  )`);

  await dbRun(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    deviceId TEXT NOT NULL,
    deviceName TEXT DEFAULT '',
    lastUsed TEXT NOT NULL,
    firstSeen TEXT NOT NULL,
    trusted INTEGER DEFAULT 0,
    UNIQUE(username, deviceId)
  )`);

  await dbRun(`
  CREATE TABLE IF NOT EXISTS auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    deviceId TEXT NOT NULL,
    code TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    attempts INTEGER DEFAULT 0
  )`);

  await dbRun(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatarUrl TEXT DEFAULT '',
    description TEXT DEFAULT '',
    owner TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);

  await dbRun(`
  CREATE TABLE IF NOT EXISTS group_members (
    groupId INTEGER NOT NULL,
    username TEXT NOT NULL,
    role TEXT NOT NULL, -- owner/admin/member
    joinedAt TEXT NOT NULL,
    UNIQUE(groupId, username)
  )`);

  // Ensure system bot exists (username: telegram)
  const sys = await dbGet(`SELECT * FROM users WHERE username=?`, ["telegram"]);
  if (!sys) {
    const hash = await bcrypt.hash("system_bot_password", 10);
    await dbRun(
      `INSERT INTO users (username, passwordHash, displayName, bio, createdAt) VALUES (?,?,?,?,?)`,
      ["telegram", hash, "@telegram", "System bot", nowISO()]
    );
  }
}
initDb().catch(console.error);

// ---------- Auth middleware ----------
async function verifyAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return bad(res, "No token", 401);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await dbGet(`SELECT * FROM users WHERE username=?`, [payload.username]);
    if (!user) return bad(res, "User not found", 401);

    // blocked?
    if (user.blockedUntil) {
      const bu = new Date(user.blockedUntil).getTime();
      if (!isNaN(bu) && bu > Date.now()) return bad(res, "User is blocked", 403);
    }

    req.user = user;
    next();
  } catch (e) {
    return bad(res, "Invalid token", 401);
  }
}

// ---------- Multer upload ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = Date.now() + "_" + Math.random().toString(16).slice(2);
    cb(null, base + ext);
  }
});
const upload = multer({ storage });

// ---------- Auth routes ----------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!safeUsername(username)) return bad(res, "Bad username format");
    if (typeof password !== "string" || password.length < 6) return bad(res, "Password must be 6+ chars");

    const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [username]);
    if (exists) return bad(res, "Username already taken");

    const hash = await bcrypt.hash(password, 10);
    await dbRun(
      `INSERT INTO users (username, passwordHash, createdAt, lastSeen) VALUES (?,?,?,?)`,
      [username, hash, nowISO(), nowISO()]
    );
    ok(res, { message: "Registered" });
  } catch (e) {
    console.error(e);
    bad(res, "Register failed");
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { identifier, password, deviceId, deviceName } = req.body || {};
    const username = (identifier || "").replace(/^@/, "");
    if (!safeUsername(username)) return bad(res, "Bad username");
    const user = await dbGet(`SELECT * FROM users WHERE username=?`, [username]);
    if (!user) return bad(res, "Invalid credentials", 401);

    const okPass = await bcrypt.compare(password || "", user.passwordHash);
    if (!okPass) return bad(res, "Invalid credentials", 401);

    const dId = typeof deviceId === "string" && deviceId.length ? deviceId : "unknown-device";
    const session = await dbGet(`SELECT * FROM sessions WHERE username=? AND deviceId=?`, [username, dId]);

    if (!session || session.trusted !== 1) {
      // generate 2FA
      const code = rand6();
      const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min

      await dbRun(`INSERT INTO auth_codes (username, deviceId, code, expiresAt, attempts) VALUES (?,?,?,?,0)`, [
        username,
        dId,
        code,
        expires
      ]);

      // send message from @telegram to user (DM)
      await dbRun(
        `INSERT INTO messages (chatType, user1, user2, sender, receiver, text, createdAt) VALUES (?,?,?,?,?,?,?)`,
        ["dm", "telegram", username, "telegram", username, `🔐 Код входа: ${code} (действует 5 минут)`, nowISO()]
      );

      // upsert session (untrusted)
      const now = nowISO();
      await dbRun(
        `INSERT INTO sessions (username, deviceId, deviceName, lastUsed, firstSeen, trusted)
         VALUES (?,?,?,?,?,0)
         ON CONFLICT(username, deviceId) DO UPDATE SET deviceName=excluded.deviceName, lastUsed=excluded.lastUsed, trusted=0`,
        [username, dId, deviceName || "", now, now]
      );

      return ok(res, { requireConfirm: true, username });
    }

    // trusted => token
    await dbRun(`UPDATE sessions SET lastUsed=? WHERE username=? AND deviceId=?`, [nowISO(), username, dId]);

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
    ok(res, { token, username });
  } catch (e) {
    console.error(e);
    bad(res, "Login failed");
  }
});

app.post("/api/auth/confirm", async (req, res) => {
  try {
    const { username, code, deviceId } = req.body || {};
    const u = (username || "").replace(/^@/, "");
    if (!safeUsername(u)) return bad(res, "Bad username");
    if (typeof code !== "string" || code.length !== 6) return bad(res, "Bad code");
    const dId = typeof deviceId === "string" && deviceId.length ? deviceId : "unknown-device";

    const row = await dbGet(
      `SELECT * FROM auth_codes WHERE username=? AND deviceId=? ORDER BY id DESC LIMIT 1`,
      [u, dId]
    );
    if (!row) return bad(res, "Code not found", 401);

    if (new Date(row.expiresAt).getTime() < Date.now()) return bad(res, "Code expired", 401);
    if (row.attempts >= 5) return bad(res, "Too many attempts", 429);
    if (row.code !== code) {
      await dbRun(`UPDATE auth_codes SET attempts=attempts+1 WHERE id=?`, [row.id]);
      return bad(res, "Wrong code", 401);
    }

    await dbRun(`DELETE FROM auth_codes WHERE username=? AND deviceId=?`, [u, dId]);
    await dbRun(`UPDATE sessions SET trusted=1, lastUsed=? WHERE username=? AND deviceId=?`, [nowISO(), u, dId]);

    const token = jwt.sign({ username: u }, JWT_SECRET, { expiresIn: "7d" });
    ok(res, { token, username: u });
  } catch (e) {
    console.error(e);
    bad(res, "Confirm failed");
  }
});

// ---------- Profile ----------
app.get("/api/me", verifyAuth, async (req, res) => {
  const u = req.user;
  ok(res, {
    me: {
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      avatarUrl: u.avatarUrl,
      birthDate: u.birthDate,
      createdAt: u.createdAt,
      lastSeen: u.lastSeen,
      canSendText: !!u.canSendText,
      canSendMedia: !!u.canSendMedia,
      canCall: !!u.canCall
    }
  });
});

app.put("/api/me", verifyAuth, async (req, res) => {
  try {
    const { displayName, bio, birthDate, avatarUrl } = req.body || {};
    await dbRun(
      `UPDATE users SET displayName=?, bio=?, birthDate=?, avatarUrl=? WHERE username=?`,
      [
        String(displayName || "").slice(0, 40),
        String(bio || "").slice(0, 140),
        String(birthDate || "").slice(0, 20),
        String(avatarUrl || "").slice(0, 200),
        req.user.username
      ]
    );
    ok(res, { message: "Updated" });
  } catch (e) {
    console.error(e);
    bad(res, "Update failed");
  }
});

app.delete("/api/me", verifyAuth, async (req, res) => {
  const username = req.user.username;
  if (username === "telegram") return bad(res, "Cannot delete system bot", 403);

  try {
    await dbRun("BEGIN TRANSACTION");
    await dbRun(`DELETE FROM messages WHERE sender=? OR receiver=? OR user1=? OR user2=?`, [
      username,
      username,
      username,
      username
    ]);
    await dbRun(`DELETE FROM stories WHERE owner=?`, [username]);
    await dbRun(`DELETE FROM sessions WHERE username=?`, [username]);
    await dbRun(`DELETE FROM auth_codes WHERE username=?`, [username]);
    await dbRun(`DELETE FROM group_members WHERE username=?`, [username]);

    // if user owns groups, keep group but transfer? simplest: delete groups owned by user + their messages
    const owned = await dbAll(`SELECT id FROM groups WHERE owner=?`, [username]);
    for (const g of owned) {
      await dbRun(`DELETE FROM messages WHERE chatType='group' AND groupId=?`, [g.id]);
      await dbRun(`DELETE FROM group_members WHERE groupId=?`, [g.id]);
      await dbRun(`DELETE FROM groups WHERE id=?`, [g.id]);
    }

    await dbRun(`DELETE FROM users WHERE username=?`, [username]);
    await dbRun("COMMIT");
    ok(res, { message: "Account deleted" });
  } catch (e) {
    console.error(e);
    await dbRun("ROLLBACK").catch(() => {});
    bad(res, "Delete failed");
  }
});

// ---------- Users ----------
app.get("/api/users/search", verifyAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").replace(/^@/, "").toLowerCase();
    if (!q) return ok(res, { users: [] });
    const users = await dbAll(
      `SELECT username, displayName, bio, avatarUrl, lastSeen FROM users
       WHERE username LIKE ? AND username != 'telegram' LIMIT 20`,
      [`%${q}%`]
    );
    ok(res, { users });
  } catch (e) {
    console.error(e);
    bad(res, "Search failed");
  }
});

app.get("/api/users/:username", verifyAuth, async (req, res) => {
  try {
    const u = String(req.params.username || "").replace(/^@/, "");
    const user = await dbGet(
      `SELECT username, displayName, bio, avatarUrl, birthDate, lastSeen FROM users WHERE username=?`,
      [u]
    );
    if (!user) return bad(res, "Not found", 404);
    ok(res, { user });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// ---------- Birthdays ----------
app.get("/api/birthdays/today", verifyAuth, async (req, res) => {
  try {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");

    // birthDate expected YYYY-MM-DD
    const users = await dbAll(
      `SELECT username, displayName, avatarUrl, birthDate FROM users
       WHERE substr(birthDate,6,2)=? AND substr(birthDate,9,2)=? AND birthDate != ''`,
      [mm, dd]
    );
    ok(res, { users });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// ---------- Chats list ----------
app.get("/api/chats", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;

    // DMs where me involved (user1/user2 derived in messages)
    const dms = await dbAll(
      `
      SELECT
        CASE
          WHEN user1=? THEN user2
          WHEN user2=? THEN user1
          WHEN sender=? AND receiver IS NOT NULL THEN receiver
          WHEN receiver=? AND sender IS NOT NULL THEN sender
          ELSE NULL
        END as peer,
        MAX(createdAt) as lastTime
      FROM messages
      WHERE chatType='dm' AND (
        user1=? OR user2=? OR sender=? OR receiver=?
      )
      GROUP BY peer
      HAVING peer IS NOT NULL
      ORDER BY lastTime DESC
      LIMIT 50
      `,
      [me, me, me, me, me, me, me, me]
    );

    const dmWithLast = [];
    for (const row of dms) {
      const peer = row.peer;
      const last = await dbGet(
        `SELECT * FROM messages
         WHERE chatType='dm' AND (
           (user1=? AND user2=?) OR (user1=? AND user2=?)
           OR (sender=? AND receiver=?) OR (sender=? AND receiver=?)
         )
         ORDER BY id DESC LIMIT 1`,
        [me, peer, peer, me, me, peer, peer, me]
      );
      const peerInfo = await dbGet(`SELECT username, displayName, avatarUrl, lastSeen FROM users WHERE username=?`, [
        peer
      ]);
      if (peerInfo) dmWithLast.push({ peer: peerInfo, last });
    }

    // Groups where member
    const groups = await dbAll(
      `SELECT g.*, gm.role FROM groups g
       JOIN group_members gm ON gm.groupId=g.id
       WHERE gm.username=?
       ORDER BY g.updatedAt DESC`,
      [me]
    );

    // Global last message
    const globalLast = await dbGet(`SELECT * FROM messages WHERE chatType='global' ORDER BY id DESC LIMIT 1`, []);

    ok(res, { global: { last: globalLast }, dms: dmWithLast, groups });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// ---------- Messages ----------
app.get("/api/messages", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const chat = String(req.query.chat || "");
    const parts = chatKeyToParts(chat);
    if (!parts) return bad(res, "Bad chat");

    let rows = [];
    if (parts.type === "global") {
      rows = await dbAll(`SELECT * FROM messages WHERE chatType='global' ORDER BY id DESC LIMIT 100`);
    } else if (parts.type === "dm") {
      const peer = parts.peer;
      rows = await dbAll(
        `SELECT * FROM messages WHERE chatType='dm' AND (
          (user1=? AND user2=?) OR (user1=? AND user2=?)
          OR (sender=? AND receiver=?) OR (sender=? AND receiver=?)
        ) ORDER BY id DESC LIMIT 100`,
        [me, peer, peer, me, me, peer, peer, me]
      );
    } else if (parts.type === "group") {
      const gid = parts.groupId;
      // check membership
      const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
      if (!mem) return bad(res, "Not a member", 403);
      rows = await dbAll(`SELECT * FROM messages WHERE chatType='group' AND groupId=? ORDER BY id DESC LIMIT 150`, [
        gid
      ]);
    }

    ok(res, { messages: rows.reverse() });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

app.delete("/api/messages/:id", verifyAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const msg = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
    if (!msg) return bad(res, "Not found", 404);
    if (msg.sender !== req.user.username) return bad(res, "Not yours", 403);

    await dbRun(`DELETE FROM messages WHERE id=?`, [id]);
    ok(res, { id });
    // WS broadcast deletion handled client-side by receiving ws event (optional)
    broadcastToChat(msg, { type: "message-deleted", id });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// ---------- Upload ----------
app.post("/api/upload", verifyAuth, upload.single("file"), async (req, res) => {
  try {
    const me = req.user.username;
    if (!req.user.canSendMedia) return bad(res, "Media disabled", 403);

    const chat = String(req.body.chat || "");
    const text = String(req.body.text || "");
    const parts = chatKeyToParts(chat);
    if (!parts) return bad(res, "Bad chat");

    const file = req.file;
    if (!file) return bad(res, "No file");
    const mime = (file.mimetype || "").toLowerCase();

    let mediaType = "";
    if (mime.startsWith("image/")) mediaType = "image";
    else if (mime.startsWith("video/")) mediaType = "video";
    else if (mime.startsWith("audio/")) mediaType = "audio";
    else mediaType = "file";

    const mediaUrl = `/uploads/${file.filename}`;
    const createdAt = nowISO();

    let msgRow = null;

    if (parts.type === "global") {
      if (!req.user.canSendText && !text) return bad(res, "Text disabled", 403);
      const r = await dbRun(
        `INSERT INTO messages (chatType, sender, text, mediaType, mediaUrl, createdAt) VALUES (?,?,?,?,?,?)`,
        ["global", me, text, mediaType, mediaUrl, createdAt]
      );
      msgRow = await dbGet(`SELECT * FROM messages WHERE id=?`, [r.lastID]);
    }

    if (parts.type === "dm") {
      const peer = parts.peer;
      const peerExists = await dbGet(`SELECT username FROM users WHERE username=?`, [peer]);
      if (!peerExists) return bad(res, "Peer not found", 404);

      const user1 = me < peer ? me : peer;
      const user2 = me < peer ? peer : me;

      const r = await dbRun(
        `INSERT INTO messages (chatType, user1, user2, sender, receiver, text, mediaType, mediaUrl, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ["dm", user1, user2, me, peer, text, mediaType, mediaUrl, createdAt]
      );
      msgRow = await dbGet(`SELECT * FROM messages WHERE id=?`, [r.lastID]);
    }

    if (parts.type === "group") {
      const gid = parts.groupId;
      const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
      if (!mem) return bad(res, "Not a member", 403);

      const r = await dbRun(
        `INSERT INTO messages (chatType, groupId, sender, text, mediaType, mediaUrl, createdAt)
         VALUES (?,?,?,?,?,?,?)`,
        ["group", gid, me, text, mediaType, mediaUrl, createdAt]
      );
      msgRow = await dbGet(`SELECT * FROM messages WHERE id=?`, [r.lastID]);

      await dbRun(`UPDATE groups SET updatedAt=? WHERE id=?`, [createdAt, gid]);
    }

    ok(res, { message: msgRow });
    if (msgRow) broadcastToChat(msgRow, { type: "message", message: msgRow });
  } catch (e) {
    console.error(e);
    bad(res, "Upload failed");
  }
});

// ---------- Stories ----------
app.get("/api/stories", verifyAuth, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT s.*, u.displayName, u.avatarUrl
       FROM stories s JOIN users u ON u.username=s.owner
       WHERE datetime(s.expiresAt) > datetime(?)
       ORDER BY s.createdAt DESC LIMIT 50`,
      [nowISO()]
    );
    ok(res, { stories: rows });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

app.post("/api/stories", verifyAuth, upload.single("file"), async (req, res) => {
  try {
    const owner = req.user.username;
    const text = String(req.body.text || "").slice(0, 300);
    let mediaType = "";
    let mediaUrl = "";
    if (req.file) {
      const mime = (req.file.mimetype || "").toLowerCase();
      if (mime.startsWith("image/")) mediaType = "image";
      else if (mime.startsWith("video/")) mediaType = "video";
      else if (mime.startsWith("audio/")) mediaType = "audio";
      else mediaType = "file";
      mediaUrl = `/uploads/${req.file.filename}`;
    }

    if (!text && !mediaUrl) return bad(res, "Empty story");
    const createdAt = nowISO();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const r = await dbRun(
      `INSERT INTO stories (owner, text, mediaType, mediaUrl, createdAt, expiresAt) VALUES (?,?,?,?,?,?)`,
      [owner, text, mediaType, mediaUrl, createdAt, expiresAt]
    );
    const story = await dbGet(`SELECT * FROM stories WHERE id=?`, [r.lastID]);
    ok(res, { story });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// ---------- Groups ----------
app.post("/api/groups", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const { name, description, avatarUrl, members } = req.body || {};
    const gName = String(name || "").trim().slice(0, 40);
    if (!gName) return bad(res, "Name required");

    const createdAt = nowISO();
    const r = await dbRun(
      `INSERT INTO groups (name, avatarUrl, description, owner, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?)`,
      [gName, String(avatarUrl || "").slice(0, 200), String(description || "").slice(0, 200), me, createdAt, createdAt]
    );
    const gid = r.lastID;

    await dbRun(
      `INSERT INTO group_members (groupId, username, role, joinedAt) VALUES (?,?,?,?)`,
      [gid, me, "owner", createdAt]
    );

    const list = Array.isArray(members) ? members : [];
    for (const raw of list) {
      const u = String(raw || "").replace(/^@/, "");
      if (!safeUsername(u) || u === me) continue;
      const ex = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
      if (!ex) continue;
      await dbRun(
        `INSERT OR IGNORE INTO group_members (groupId, username, role, joinedAt) VALUES (?,?,?,?)`,
        [gid, u, "member", createdAt]
      );
    }

    const group = await dbGet(`SELECT * FROM groups WHERE id=?`, [gid]);
    ok(res, { groupId: gid, group });
  } catch (e) {
    console.error(e);
    bad(res, "Create group failed");
  }
});

app.get("/api/groups/:groupId", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const gid = Number(req.params.groupId);
    const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
    if (!mem) return bad(res, "Not a member", 403);

    const group = await dbGet(`SELECT * FROM groups WHERE id=?`, [gid]);
    if (!group) return bad(res, "Not found", 404);

    const members = await dbAll(
      `SELECT gm.username, gm.role, gm.joinedAt, u.displayName, u.avatarUrl
       FROM group_members gm JOIN users u ON u.username=gm.username
       WHERE gm.groupId=? ORDER BY
         CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
         gm.joinedAt ASC`,
      [gid]
    );
    ok(res, { group, members });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

app.put("/api/groups/:groupId", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const gid = Number(req.params.groupId);
    const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
    if (!mem) return bad(res, "Not a member", 403);
    if (!(mem.role === "owner" || mem.role === "admin")) return bad(res, "No rights", 403);

    const { name, description, avatarUrl } = req.body || {};
    await dbRun(
      `UPDATE groups SET name=?, description=?, avatarUrl=?, updatedAt=? WHERE id=?`,
      [
        String(name || "").slice(0, 40),
        String(description || "").slice(0, 200),
        String(avatarUrl || "").slice(0, 200),
        nowISO(),
        gid
      ]
    );
    const group = await dbGet(`SELECT * FROM groups WHERE id=?`, [gid]);
    ok(res, { group });
  } catch (e) {
    console.error(e);
    bad(res, "Update failed");
  }
});

app.post("/api/groups/:groupId/members", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const gid = Number(req.params.groupId);
    const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
    if (!mem) return bad(res, "Not a member", 403);
    if (!(mem.role === "owner" || mem.role === "admin")) return bad(res, "No rights", 403);

    const { members } = req.body || {};
    const list = Array.isArray(members) ? members : [];
    const createdAt = nowISO();

    for (const raw of list) {
      const u = String(raw || "").replace(/^@/, "");
      if (!safeUsername(u) || u === me) continue;
      const ex = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
      if (!ex) continue;
      await dbRun(
        `INSERT OR IGNORE INTO group_members (groupId, username, role, joinedAt) VALUES (?,?,?,?)`,
        [gid, u, "member", createdAt]
      );
    }

    await dbRun(`UPDATE groups SET updatedAt=? WHERE id=?`, [createdAt, gid]);
    ok(res, { message: "Members added" });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

app.delete("/api/groups/:groupId/members/:username", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const gid = Number(req.params.groupId);
    const target = String(req.params.username || "").replace(/^@/, "");

    const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
    if (!mem) return bad(res, "Not a member", 403);

    const targetMem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, target]);
    if (!targetMem) return bad(res, "Target not in group", 404);

    if (mem.role === "owner") {
      if (target === "owner") return bad(res, "Cannot remove owner", 403);
      await dbRun(`DELETE FROM group_members WHERE groupId=? AND username=?`, [gid, target]);
    } else if (mem.role === "admin") {
      // admin can remove only members (not owner/admin)
      if (targetMem.role !== "member") return bad(res, "Admins cannot remove owner/admin", 403);
      await dbRun(`DELETE FROM group_members WHERE groupId=? AND username=?`, [gid, target]);
    } else {
      // member can leave self
      if (target !== me) return bad(res, "No rights", 403);
      await dbRun(`DELETE FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
    }

    await dbRun(`UPDATE groups SET updatedAt=? WHERE id=?`, [nowISO(), gid]);
    ok(res, { message: "Removed" });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

app.put("/api/groups/:groupId/members/:username/role", verifyAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const gid = Number(req.params.groupId);
    const target = String(req.params.username || "").replace(/^@/, "");
    const { role } = req.body || {};

    const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
    if (!mem) return bad(res, "Not a member", 403);
    if (mem.role !== "owner") return bad(res, "Only owner can change roles", 403);

    if (!["admin", "member"].includes(String(role))) return bad(res, "Bad role");
    if (target === me) return bad(res, "Owner role is fixed");

    await dbRun(`UPDATE group_members SET role=? WHERE groupId=? AND username=?`, [role, gid, target]);
    await dbRun(`UPDATE groups SET updatedAt=? WHERE id=?`, [nowISO(), gid]);
    ok(res, { message: "Role updated" });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// ---------- Admin ----------
function verifyAdminToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return bad(res, "No token", 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p || p.admin !== true) return bad(res, "Not admin", 403);
    req.admin = true;
    next();
  } catch {
    return bad(res, "Bad token", 401);
  }
}

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASS) return bad(res, "Invalid admin credentials", 401);
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: "1d" });
  ok(res, { token });
});

app.get("/api/admin/users", verifyAdminToken, async (req, res) => {
  try {
    const users = await dbAll(
      `SELECT username, displayName, bio, avatarUrl, birthDate, createdAt, lastSeen, blockedUntil,
              canSendText, canSendMedia, canCall
       FROM users WHERE username != 'telegram'
       ORDER BY createdAt DESC LIMIT 500`
    );
    ok(res, { users });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

app.post("/api/admin/user/update", verifyAdminToken, async (req, res) => {
  try {
    const { username, blockedUntil, canSendText, canSendMedia, canCall } = req.body || {};
    const u = String(username || "").replace(/^@/, "");
    const ex = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
    if (!ex) return bad(res, "User not found", 404);

    await dbRun(
      `UPDATE users SET blockedUntil=?, canSendText=?, canSendMedia=?, canCall=? WHERE username=?`,
      [
        String(blockedUntil || "").slice(0, 40),
        canSendText ? 1 : 0,
        canSendMedia ? 1 : 0,
        canCall ? 1 : 0,
        u
      ]
    );
    ok(res, { message: "Updated" });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// ---------- WebSocket realtime ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const online = new Map(); // username -> Set(ws)
const wsUser = new Map(); // ws -> username

function addOnline(username, ws) {
  if (!online.has(username)) online.set(username, new Set());
  online.get(username).add(ws);
  wsUser.set(ws, username);
}
function removeOnline(ws) {
  const u = wsUser.get(ws);
  if (!u) return;
  wsUser.delete(ws);
  const set = online.get(u);
  if (set) {
    set.delete(ws);
    if (set.size === 0) online.delete(u);
  }
}
function sendWs(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendToUser(username, obj) {
  const set = online.get(username);
  if (!set) return;
  for (const ws of set) sendWs(ws, obj);
}
function broadcastStatus(username, status) {
  // To everyone online (simple)
  for (const [u, set] of online.entries()) {
    for (const ws of set) sendWs(ws, { type: "status", username, status, at: nowISO() });
  }
}
async function broadcastToChat(msgRow, payload) {
  try {
    if (msgRow.chatType === "global") {
      // all online
      for (const set of online.values()) for (const ws of set) sendWs(ws, payload);
      return;
    }
    if (msgRow.chatType === "dm") {
      const u1 = msgRow.user1;
      const u2 = msgRow.user2;
      sendToUser(u1, payload);
      sendToUser(u2, payload);
      return;
    }
    if (msgRow.chatType === "group") {
      const members = await dbAll(`SELECT username FROM group_members WHERE groupId=?`, [msgRow.groupId]);
      for (const m of members) sendToUser(m.username, payload);
    }
  } catch (e) {
    console.error("broadcastToChat", e);
  }
}

wss.on("connection", async (ws, req) => {
  try {
    // token in query ?token=
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || "";
    if (!token) {
      ws.close();
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      ws.close();
      return;
    }
    const username = payload.username;
    const user = await dbGet(`SELECT * FROM users WHERE username=?`, [username]);
    if (!user) {
      ws.close();
      return;
    }
    if (user.blockedUntil) {
      const bu = new Date(user.blockedUntil).getTime();
      if (!isNaN(bu) && bu > Date.now()) {
        ws.close();
        return;
      }
    }

    addOnline(username, ws);
    await dbRun(`UPDATE users SET lastSeen=? WHERE username=?`, [nowISO(), username]);
    broadcastStatus(username, "online");

    ws.on("message", async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const me = wsUser.get(ws);
      if (!me) return;

      // refresh lastSeen
      await dbRun(`UPDATE users SET lastSeen=? WHERE username=?`, [nowISO(), me]).catch(() => {});

      if (data.type === "typing") {
        // {type:"typing", to:"@user" or "group:123" or "global", isTyping:true}
        const to = String(data.to || "");
        const parts = chatKeyToParts(to);
        if (!parts) return;
        if (parts.type === "dm") {
          sendToUser(parts.peer, { type: "typing", from: me, to, isTyping: !!data.isTyping });
        } else if (parts.type === "group") {
          const gid = parts.groupId;
          const members = await dbAll(`SELECT username FROM group_members WHERE groupId=?`, [gid]);
          for (const m of members) if (m.username !== me) sendToUser(m.username, { type: "typing", from: me, to, isTyping: !!data.isTyping });
        } else if (parts.type === "global") {
          for (const [u] of online.entries()) if (u !== me) sendToUser(u, { type: "typing", from: me, to, isTyping: !!data.isTyping });
        }
        return;
      }

      if (data.type === "text-message") {
        // {type, chat:"global|@u|group:1", text:"..."}
        const text = String(data.text || "").slice(0, 4000);
        if (!text.trim()) return;

        const userRow = await dbGet(`SELECT * FROM users WHERE username=?`, [me]);
        if (!userRow) return;
        if (!userRow.canSendText) {
          sendWs(ws, { type: "error", error: "Text disabled" });
          return;
        }

        const chat = String(data.chat || "");
        const parts = chatKeyToParts(chat);
        if (!parts) return;

        let msgRow;

        if (parts.type === "global") {
          const r = await dbRun(
            `INSERT INTO messages (chatType, sender, text, createdAt) VALUES (?,?,?,?)`,
            ["global", me, text, nowISO()]
          );
          msgRow = await dbGet(`SELECT * FROM messages WHERE id=?`, [r.lastID]);
        } else if (parts.type === "dm") {
          const peer = parts.peer;
          const peerExists = await dbGet(`SELECT username FROM users WHERE username=?`, [peer]);
          if (!peerExists) return;

          const user1 = me < peer ? me : peer;
          const user2 = me < peer ? peer : me;

          const r = await dbRun(
            `INSERT INTO messages (chatType, user1, user2, sender, receiver, text, createdAt)
             VALUES (?,?,?,?,?,?,?)`,
            ["dm", user1, user2, me, peer, text, nowISO()]
          );
          msgRow = await dbGet(`SELECT * FROM messages WHERE id=?`, [r.lastID]);
        } else if (parts.type === "group") {
          const gid = parts.groupId;
          const mem = await dbGet(`SELECT * FROM group_members WHERE groupId=? AND username=?`, [gid, me]);
          if (!mem) return;

          const r = await dbRun(
            `INSERT INTO messages (chatType, groupId, sender, text, createdAt) VALUES (?,?,?,?,?)`,
            ["group", gid, me, text, nowISO()]
          );
          msgRow = await dbGet(`SELECT * FROM messages WHERE id=?`, [r.lastID]);
          await dbRun(`UPDATE groups SET updatedAt=? WHERE id=?`, [nowISO(), gid]);
        }

        if (msgRow) broadcastToChat(msgRow, { type: "message", message: msgRow });
        return;
      }

      // --- WebRTC signaling (audio calls) ---
      // {type:"call-offer", to:"username", sdp, fromChat:"@username"}
      // {type:"call-answer", to:"username", sdp}
      // {type:"ice", to:"username", candidate}
      // {type:"call-end", to:"username"}
      if (["call-offer", "call-answer", "ice", "call-end"].includes(data.type)) {
        const userRow = await dbGet(`SELECT * FROM users WHERE username=?`, [me]);
        if (!userRow || !userRow.canCall) {
          sendWs(ws, { type: "error", error: "Calls disabled" });
          return;
        }

        const to = String(data.to || "").replace(/^@/, "");
        if (!safeUsername(to)) return;
        // DMs only
        const fromChat = String(data.fromChat || "");
        if (!fromChat.startsWith("@")) {
          sendWs(ws, { type: "error", error: "Calls only in private chats" });
          return;
        }

        sendToUser(to, { ...data, from: me });
        return;
      }
    });

    ws.on("close", async () => {
      const u = wsUser.get(ws);
      removeOnline(ws);

      if (u && !online.has(u)) {
        // last connection closed
        await dbRun(`UPDATE users SET lastSeen=? WHERE username=?`, [nowISO(), u]).catch(() => {});
        broadcastStatus(u, "offline");
      }
    });
  } catch (e) {
    console.error("ws connection error", e);
    try { ws.close(); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
