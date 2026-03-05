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
const SYSTEM_USERNAME = "telegram";

app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use("/uploads", express.static(uploadsDir));

const upload = multer({ dest: uploadsDir });
const db = new sqlite3.Database("database.db");

// Инициализация БД (как в предыдущей версии, без изменений)
db.serialize(() => {
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

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      deviceName TEXT,
      lastUsed INTEGER NOT NULL,
      firstSeen INTEGER NOT NULL,
      trusted INTEGER DEFAULT 1,
      UNIQUE(username, deviceId)
    )
  `);

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

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_private ON messages(chatType, user1, user2, createdAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stories_exp ON stories(expiresAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_auth_codes ON auth_codes(username, deviceId)`);
});

// Создание системного пользователя
function ensureSystemUser() {
  const now = Date.now();
  db.get(`SELECT * FROM users WHERE username = ?`, [SYSTEM_USERNAME], (err, user) => {
    if (!user) {
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

// helpers
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

function sendSystemMessage(toUsername, text) {
  const createdAt = now();
  db.run(
    `INSERT INTO messages (chatType, user1, user2, sender, receiver, text, mediaType, mediaUrl, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["private", SYSTEM_USERNAME, toUsername, SYSTEM_USERNAME, toUsername, text, "text", "", createdAt],
    function (err) {
      if (err) console.error("Ошибка отправки системного сообщения:", err);
      else {
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

// Device helpers
function getDeviceId(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ip + ua).digest('hex');
}

function getDeviceName(req) {
  const ua = req.headers['user-agent'] || 'Unknown';
  return ua.substring(0, 50);
}

// ---- AUTH (как в предыдущей версии, без изменений) ----
// ... (весь код аутентификации из предыдущей версии, включая /register, /login, /confirm)
// Для краткости он здесь опущен, но должен быть вставлен.
// Полный код можно взять из предыдущего ответа.

// ---- PROFILE, CHATS, MESSAGES, UPLOAD, STORIES, BIRTHDAYS, ADMIN ----
// Все эти эндпоинты остаются без изменений (см. предыдущую версию).
// Я их не копирую сюда для экономии места, но они должны быть.

// ========== WEBSOCKET (исправленная версия) ==========
const online = new Map(); // username -> ws

function wsSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.log("wsSend: сокет не открыт или отсутствует");
  }
}

function broadcastToChat(messageRow, payload) {
  console.log(`broadcastToChat: type=${payload.type}, chatType=${messageRow.chatType}, sender=${messageRow.sender}, receiver=${messageRow.receiver}`);
  if (messageRow.chatType === "global") {
    console.log("  рассылка всем (global)");
    for (const [username, ws] of online.entries()) {
      wsSend(ws, payload);
    }
    return;
  }
  const a = messageRow.sender;
  const b = messageRow.receiver;
  console.log(`  отправка участникам: ${a} и ${b}`);
  wsSend(online.get(a), payload);
  wsSend(online.get(b), payload);
}

function broadcastStatus(username, status) {
  const payload = { type: "status", username, status };
  for (const ws of online.values()) {
    wsSend(ws, payload);
  }
}

wss.on("connection", (ws, req) => {
  console.log("Новое WebSocket соединение");
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || "";
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = String(decoded.username || "");
    console.log(`Попытка подключения пользователя: ${username}`);

    db.get(`SELECT * FROM users WHERE username=?`, [username], (err, user) => {
      if (!user) {
        console.log(`Пользователь ${username} не найден, закрываем соединение`);
        return ws.close();
      }

      if (Number(user.blockedUntil || 0) > now()) {
        console.log(`Пользователь ${username} заблокирован, закрываем`);
        wsSend(ws, { type: "blocked", until: user.blockedUntil });
        return ws.close();
      }

      console.log(`Пользователь ${username} успешно подключен`);
      db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [now(), username]);
      ws.username = username;
      online.set(username, ws);
      broadcastStatus(username, "online");

      wsSend(ws, { type: "ws-ready", username });

      ws.on("message", (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (!data || !data.type) return;

        const from = ws.username;
        console.log(`Получено сообщение от ${from}, тип: ${data.type}`);

        // Сигнализация звонков (только аудио)
        if (data.type === "call-offer" || data.type === "call-answer" || data.type === "ice" || data.type === "call-end") {
          db.get(`SELECT * FROM users WHERE username=?`, [from], (e2, fresh) => {
            if (!fresh || !canUser(fresh, "call")) {
              return wsSend(ws, { type: "call-error", message: "Тебе запрещены звонки" });
            }
            const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
            console.log(`Звонок: ${from} -> ${to}, тип=${data.type}`);
            const target = online.get(to);
            if (!target) {
              console.log(`Пользователь ${to} не онлайн`);
              return wsSend(ws, { type: "call-error", message: "Пользователь не онлайн" });
            }
            wsSend(target, { ...data, from });
          });
          return;
        }

        // Текстовое сообщение
        if (data.type === "text-message") {
          console.log(`Текстовое сообщение от ${from}: ${data.text}`);
          db.get(`SELECT * FROM users WHERE username=?`, [from], (e2, fresh) => {
            if (!fresh || !canUser(fresh, "text")) {
              return wsSend(ws, { type: "moderation", message: "Тебе запрещены сообщения" });
            }

            const receiver = String(data.receiver || "global").replace(/^@+/, "").toLowerCase();
            const chatType = receiver === "global" ? "global" : "private";
            const text = String(data.text || "").trim().slice(0, 2000);
            if (!text) return;

            const createdAt = now();

            db.run(
              `INSERT INTO messages (chatType,user1,user2,sender,receiver,text,mediaType,mediaUrl,createdAt)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [
                chatType,
                chatType === "private" ? from : null,
                chatType === "private" ? receiver : null,
                from,
                receiver === "" ? "global" : receiver,
                text,
                "text",
                "",
                createdAt
              ],
              function (err) {
                if (err) {
                  console.error("Ошибка сохранения сообщения:", err);
                  return wsSend(ws, { type: "moderation", message: "Ошибка сохранения" });
                }

                const msg = {
                  id: this.lastID,
                  chatType,
                  sender: from,
                  receiver: receiver === "" ? "global" : receiver,
                  text,
                  mediaType: "text",
                  mediaUrl: "",
                  createdAt
                };
                console.log("Сообщение сохранено, id=", this.lastID);
                broadcastToChat(msg, { type: "message", message: msg });
              }
            );
          });
          return;
        }

        // Индикатор печатания
        if (data.type === "typing") {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          const target = online.get(to);
          if (target) {
            wsSend(target, { type: "typing", from });
          }
        }
      });

      ws.on("close", () => {
        console.log(`Пользователь ${ws.username} отключился`);
        if (ws.username) {
          online.delete(ws.username);
          db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [now(), ws.username]);
          broadcastStatus(ws.username, "offline");
        }
      });
    });
  } catch (e) {
    console.log("Ошибка при подключении WebSocket:", e);
    ws.close();
  }
});

// ---- Запуск сервера ----
server.listen(PORT, () => console.log("Server running on port", PORT));
