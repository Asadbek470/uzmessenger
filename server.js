const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_SECRET";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "090909";
const SYSTEM_USERNAME = "telegram"; // Системный бот для уведомлений

app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use("/uploads", express.static(uploadsDir));

const upload = multer({ dest: uploadsDir });
const db = new sqlite3.Database("database.db");

// ---- DB init (с новыми таблицами) ----
db.serialize(() => {
  // Пользователи (без автоматического удаления)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      passwordHash TEXT,
      displayName TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      avatarUrl TEXT DEFAULT '',
      birthDate TEXT DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0,
      lastSeen INTEGER DEFAULT 0,
      blockedUntil INTEGER DEFAULT 0,
      canSendText INTEGER DEFAULT 1,
      canSendMedia INTEGER DEFAULT 1,
      canCall INTEGER DEFAULT 1
    )
  `);

  // Сообщения (хранятся вечно)
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatType TEXT NOT NULL,
      user1 TEXT,
      user2 TEXT,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',
      mediaUrl TEXT DEFAULT '',
      createdAt INTEGER NOT NULL
    )
  `);

  // Истории (автоматически удаляются через expiresAt, но пользователи не удаляются)
  db.run(`
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',
      mediaUrl TEXT DEFAULT '',
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    )
  `);

  // Сессии пользователей (для определения новых устройств)
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      deviceId TEXT NOT NULL,        -- хеш от IP + User-Agent
      deviceName TEXT,               -- для отображения (например, "Chrome на Windows")
      lastUsed INTEGER NOT NULL,
      firstSeen INTEGER NOT NULL,
      trusted INTEGER DEFAULT 1,     -- доверенное устройство (после подтверждения)
      UNIQUE(username, deviceId)
    )
  `);

  // Коды подтверждения для новых устройств
  db.run(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      code TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0
    )
  `);

  // Индексы
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_private ON messages(chatType, user1, user2, createdAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stories_exp ON stories(expiresAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_auth_codes ON auth_codes(username, deviceId)`);
});

// ---- Создание системного пользователя (бота), если его нет ----
function ensureSystemUser() {
  const now = Date.now();
  db.get(`SELECT * FROM users WHERE username = ?`, [SYSTEM_USERNAME], (err, user) => {
    if (!user) {
      // Пароль не нужен, но чтобы можно было отправлять сообщения, создадим запись
      const hash = bcrypt.hashSync("system", 10);
      db.run(
        `INSERT INTO users (username, passwordHash, displayName, createdAt, lastSeen)
         VALUES (?, ?, ?, ?, ?)`,
        [SYSTEM_USERNAME, hash, "Telegram", now, now]
      );
    }
  });
}
ensureSystemUser();

// ---- helpers ----
function now() { return Date.now(); }

function signToken(user, deviceId) {
  return jwt.sign(
    { username: user.username, deviceId },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function verifyAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    db.get(`SELECT * FROM users WHERE username = ?`, [decoded.username], (err, user) => {
      if (!user) return res.status(401).json({ ok: false, error: "Пользователь не найден" });

      if (Number(user.blockedUntil || 0) > now()) {
        return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
      }

      // Обновляем lastSeen и время последнего использования сессии
      db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [now(), user.username]);
      if (decoded.deviceId) {
        db.run(
          `UPDATE sessions SET lastUsed=? WHERE username=? AND deviceId=?`,
          [now(), user.username, decoded.deviceId]
        );
      }

      req.user = user;
      req.deviceId = decoded.deviceId;
      next();
    });
  } catch {
    return res.status(401).json({ ok: false, error: "Неверный токен" });
  }
}

function canUser(user, rule) {
  if (Number(user.blockedUntil || 0) > now()) return false;
  if (rule === "text") return Number(user.canSendText) === 1;
  if (rule === "media") return Number(user.canSendMedia) === 1;
  if (rule === "call") return Number(user.canCall) === 1;
  return true;
}

function guessMediaType(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.includes("audio")) return "audio";
  return "file";
}

function safePublicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    bio: u.bio || "",
    avatarUrl: u.avatarUrl || "",
    birthDate: u.birthDate || "",
    lastSeen: u.lastSeen || 0
  };
}

function cleanupExpiredStories() {
  db.run(`DELETE FROM stories WHERE expiresAt <= ?`, [now()]);
}
setInterval(cleanupExpiredStories, 60 * 1000);

// ---- Функция отправки сообщения от системы ----
function sendSystemMessage(toUsername, text) {
  const createdAt = now();
  db.run(
    `INSERT INTO messages (chatType, user1, user2, sender, receiver, text, mediaType, mediaUrl, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["private", SYSTEM_USERNAME, toUsername, SYSTEM_USERNAME, toUsername, text, "text", "", createdAt],
    function (err) {
      if (err) console.error("Ошибка отправки системного сообщения:", err);
      else {
        // Уведомить через WebSocket, если пользователь онлайн
        const msg = {
          id: this.lastID,
          chatType: "private",
          sender: SYSTEM_USERNAME,
          receiver: toUsername,
          text,
          mediaType: "text",
          mediaUrl: "",
          createdAt
        };
        broadcastToChat(msg, { type: "message", message: msg });
      }
    }
  );
}

// ---- AUTH (с проверкой нового устройства) ----
function getDeviceId(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ip + ua).digest('hex');
}

function getDeviceName(req) {
  const ua = req.headers['user-agent'] || 'Unknown';
  // Упрощённо: берём первые 50 символов
  return ua.substring(0, 50);
}

app.post("/api/auth/register", async (req, res) => {
  const usernameRaw = String(req.body.username || "").trim();
  const password = String(req.body.password || "").trim();
  const username = usernameRaw.replace(/^@+/, "").toLowerCase();

  if (!/^[a-z0-9_]{4,20}$/.test(username)) {
    return res.status(400).json({ ok: false, error: "Юзернейм 4-20: a-z,0-9,_" });
  }
  if (password.length < 4) {
    return res.status(400).json({ ok: false, error: "Пароль слишком короткий" });
  }

  const hash = await bcrypt.hash(password, 10);
  const createdAt = now();

  db.run(
    `INSERT INTO users (username, passwordHash, displayName, createdAt, lastSeen) VALUES (?,?,?,?,?)`,
    [username, hash, username, createdAt, createdAt],
    function (err) {
      if (err) return res.status(400).json({ ok: false, error: "Юзернейм занят" });

      // Сразу создаём первую сессию для этого устройства
      const deviceId = getDeviceId(req);
      const deviceName = getDeviceName(req);
      db.run(
        `INSERT OR IGNORE INTO sessions (username, deviceId, deviceName, lastUsed, firstSeen, trusted) VALUES (?,?,?,?,?,1)`,
        [username, deviceId, deviceName, createdAt, createdAt]
      );

      db.get(`SELECT * FROM users WHERE username = ?`, [username], (e2, user) => {
        const token = signToken(user, deviceId);
        res.json({ ok: true, token, user: safePublicUser(user) });
      });
    }
  );
});

app.post("/api/auth/login", (req, res) => {
  const identifierRaw = String(req.body.identifier || req.body.username || "").trim();
  const password = String(req.body.password || "").trim();
  const username = identifierRaw.replace(/^@+/, "").toLowerCase();
  const deviceId = getDeviceId(req);
  const deviceName = getDeviceName(req);

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (!user) return res.status(400).json({ ok: false, error: "Пользователь не найден" });

    if (Number(user.blockedUntil || 0) > now()) {
      return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ ok: false, error: "Неверный пароль" });

    // Проверяем, есть ли уже доверенная сессия с таким deviceId
    db.get(
      `SELECT * FROM sessions WHERE username = ? AND deviceId = ?`,
      [username, deviceId],
      (err, session) => {
        const nowTime = now();

        if (session && session.trusted === 1) {
          // Устройство уже доверенное — обновляем lastUsed и выдаём токен
          db.run(`UPDATE sessions SET lastUsed=? WHERE id=?`, [nowTime, session.id]);
          db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [nowTime, username]);

          const token = signToken(user, deviceId);
          return res.json({ ok: true, token, user: safePublicUser(user) });
        }

        // Новое устройство или неподтверждённое — генерируем код
        const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 цифр
        const expiresAt = nowTime + 5 * 60 * 1000; // 5 минут

        // Сохраняем или обновляем код
        db.run(
          `INSERT INTO auth_codes (username, deviceId, code, expiresAt, attempts)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(username, deviceId) DO UPDATE SET code=excluded.code, expiresAt=excluded.expiresAt, attempts=0`,
          [username, deviceId, code, expiresAt]
        );

        // Сохраняем информацию об устройстве (недоверенное)
        db.run(
          `INSERT OR IGNORE INTO sessions (username, deviceId, deviceName, lastUsed, firstSeen, trusted)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [username, deviceId, deviceName, nowTime, nowTime]
        );

        // Отправляем код в личные сообщения пользователю
        const messageText = `🔐 Код подтверждения: ${code}\nЕсли это не вы, проигнорируйте сообщение.`;
        sendSystemMessage(username, messageText);

        // Отвечаем клиенту, что требуется подтверждение
        res.json({
          ok: false,
          requireConfirm: true,
          message: "На ваш аккаунт отправлен код подтверждения. Введите его для завершения входа."
        });
      }
    );
  });
});

// Подтверждение кода
app.post("/api/auth/confirm", (req, res) => {
  const { username, code } = req.body;
  const deviceId = getDeviceId(req);
  const deviceName = getDeviceName(req);

  if (!username || !code) {
    return res.status(400).json({ ok: false, error: "Не указаны имя пользователя или код" });
  }

  db.get(
    `SELECT * FROM auth_codes WHERE username = ? AND deviceId = ?`,
    [username, deviceId],
    (err, authRow) => {
      if (!authRow) {
        return res.status(400).json({ ok: false, error: "Код не найден или истёк" });
      }

      if (authRow.expiresAt < now()) {
        return res.status(400).json({ ok: false, error: "Код истёк. Запросите новый." });
      }

      if (authRow.attempts >= 5) {
        return res.status(400).json({ ok: false, error: "Слишком много попыток. Запросите новый код." });
      }

      if (authRow.code !== code) {
        db.run(`UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?`, [authRow.id]);
        return res.status(400).json({ ok: false, error: "Неверный код" });
      }

      // Код верный — делаем устройство доверенным
      db.run(
        `UPDATE sessions SET trusted = 1, lastUsed = ? WHERE username = ? AND deviceId = ?`,
        [now(), username, deviceId]
      );

      // Удаляем использованный код
      db.run(`DELETE FROM auth_codes WHERE id = ?`, [authRow.id]);

      // Получаем пользователя и выдаём токен
      db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.status(400).json({ ok: false, error: "Пользователь не найден" });
        const token = signToken(user, deviceId);
        res.json({ ok: true, token, user: safePublicUser(user) });
      });
    }
  );
});

// Остальные эндпоинты (profile, chats, messages, upload, stories, birthdays, admin) остаются без изменений
// ... (весь код из предыдущей версии, начиная с app.get("/api/me", verifyAuth, ...) до конца)

// Но нужно учесть, что теперь в токене есть deviceId, и verifyAuth ожидает его.
// В предыдущих эндпоинтах мы используем verifyAuth, они автоматически получат req.deviceId, но он не используется напрямую.
// Остальной код сервера (загрузка, сообщения, вебсокеты) остаётся идентичным предыдущей версии.
// Я не буду копировать его сюда целиком из-за ограничения длины, но он должен быть вставлен.
// Для краткости я покажу только изменения, но в реальном проекте нужно объединить.

// ===== ВСТАВЬТЕ СЮДА ВЕСЬ ОСТАЛЬНОЙ КОД ИЗ ПРЕДЫДУЩЕЙ ВЕРСИИ server.js =====
// (начиная с app.get("/api/me", verifyAuth, ...) и до конца, включая WebSocket и server.listen)
// Он остаётся без изменений, за исключением того, что verifyAuth теперь использует deviceId (но это не ломает старый код).

// ВНИМАНИЕ: В предыдущей версии verifyAuth уже был написан так, что он ожидает токен с username.
// Мы просто добавили в него deviceId, но старые токены без deviceId всё равно будут работать (поле decoded.deviceId будет undefined).
// Для совместимости оставляем как есть.

// ...
