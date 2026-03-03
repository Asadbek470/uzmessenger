const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static("public"));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

const upload = multer({ dest: "uploads/" });
const db = new sqlite3.Database("./database.db");

function normUser(u = "") {
  return String(u).trim().replace(/^@+/, "").toLowerCase();
}

function safeSend(ws, data) {
  try { ws.send(JSON.stringify(data)); } catch {}
}

const clients = new Map(); // username -> ws

function broadcast(data) {
  for (const ws of clients.values()) safeSend(ws, data);
}

function deliverMessage(msg) {
  if (msg.receiver === "global") {
    broadcast(msg);
    return;
  }
  const a = clients.get(msg.receiver);
  const b = clients.get(msg.sender);
  if (a) safeSend(a, msg);
  if (b) safeSend(b, msg);
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    pinHash TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS profiles (
    username TEXT PRIMARY KEY,
    displayName TEXT,
    bio TEXT,
    avatar TEXT,
    phone TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    receiver TEXT,
    text TEXT,
    mediaUrl TEXT,
    mediaType TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT,
    mediaUrl TEXT,
    mediaType TEXT,
    text TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

/* ================= AUTH ================= */

app.post("/api/auth/reg", async (req, res) => {
  const username = normUser(req.body.username);
  const pin = String(req.body.pin || "").trim();

  if (!username || !/^\d{6}$/.test(pin)) {
    return res.json({ success: false, error: "Нужен username и 6-значный PIN." });
  }

  const pinHash = await bcrypt.hash(pin, 10);

  db.run("INSERT INTO users (username, pinHash) VALUES (?,?)", [username, pinHash], err => {
    if (err) return res.json({ success: false, error: "Такой username уже занят." });

    db.run(
      "INSERT INTO profiles (username, displayName, bio, avatar, phone) VALUES (?,?,?,?,?)",
      [username, username, "", "", ""]
    );

    res.json({ success: true });
  });
});

app.post("/api/auth/login", (req, res) => {
  const username = normUser(req.body.username);
  const pin = String(req.body.pin || "").trim();

  if (!username || !/^\d{6}$/.test(pin)) {
    return res.json({ success: false, error: "Нужен username и 6-значный PIN." });
  }

  db.get("SELECT * FROM users WHERE username=?", [username], async (err, row) => {
    if (!row) return res.json({ success: false, error: "Неверный username или PIN." });

    const ok = await bcrypt.compare(pin, row.pinHash);
    if (!ok) return res.json({ success: false, error: "Неверный username или PIN." });

    res.json({ success: true });
  });
});

/* ================= PROFILE ================= */

app.get("/api/me", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  db.get("SELECT * FROM profiles WHERE username=?", [user], (err, row) => {
    res.json({ success: true, profile: row || null });
  });
});

app.post("/api/me", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const displayName = String(req.body.displayName || "").slice(0, 40);
  const bio = String(req.body.bio || "").slice(0, 160);
  const phone = String(req.body.phone || "").slice(0, 30);

  db.run(
    "UPDATE profiles SET displayName=?, bio=?, phone=? WHERE username=?",
    [displayName, bio, phone, user],
    () => res.json({ success: true })
  );
});

/* ================= SEARCH ================= */

app.get("/api/search", (req, res) => {
  const qRaw = String(req.query.q || "").trim();
  if (!qRaw) return res.json([]);

  const q = "%" + qRaw + "%";
  db.all(
    "SELECT username, displayName, phone FROM profiles WHERE username LIKE ? OR phone LIKE ? LIMIT 30",
    [q, q],
    (err, rows) => res.json(rows || [])
  );
});

/* ================= CHATS ================= */

app.get("/api/chats", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  if (!user) return res.json([]);

  db.all(
    `
    SELECT
      CASE WHEN sender = ? THEN receiver ELSE sender END AS chatWith,
      MAX(id) AS lastId
    FROM messages
    WHERE receiver != 'global' AND (sender = ? OR receiver = ?)
    GROUP BY chatWith
    ORDER BY lastId DESC
    `,
    [user, user, user],
    (err, rows) => res.json(rows || [])
  );
});

/* ================= MESSAGES ================= */

app.get("/api/messages", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const chatRaw = String(req.query.chat || "global");

  if (chatRaw === "global") {
    db.all("SELECT * FROM messages WHERE receiver='global' ORDER BY id ASC", (err, rows) => {
      res.json(rows || []);
    });
    return;
  }

  const chat = normUser(chatRaw);

  db.all(
    `SELECT * FROM messages WHERE
      (sender=? AND receiver=?) OR
      (sender=? AND receiver=?)
     ORDER BY id ASC`,
    [user, chat, chat, user],
    (err, rows) => res.json(rows || [])
  );
});

app.delete("/api/messages/:id", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const id = Number(req.params.id);

  db.get("SELECT * FROM messages WHERE id=?", [id], (err, row) => {
    if (!row) return res.json({ success: false, error: "Не найдено." });
    if (row.sender !== user) return res.status(403).json({ success: false, error: "Нельзя." });

    db.run("DELETE FROM messages WHERE id=?", [id], () => {
      broadcast({ type: "messageDeleted", id });
      res.json({ success: true });
    });
  });
});

/* ================= UPLOAD ================= */

app.post("/api/upload", upload.single("file"), (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const receiverRaw = String(req.body.receiver || "global");
  const receiver = receiverRaw === "global" ? "global" : normUser(receiverRaw);

  if (!req.file) return res.json({ success: false, error: "Нет файла." });

  const ext = path.extname(req.file.originalname);
  const filename = req.file.filename + ext;
  const diskPath = path.join("uploads", filename);
  fs.renameSync(req.file.path, diskPath);

  let mediaType = "image";
  if (req.file.mimetype.startsWith("video")) mediaType = "video";
  if (req.file.mimetype.startsWith("audio")) mediaType = "audio";

  const mediaUrl = "/uploads/" + filename;

  db.run(
    "INSERT INTO messages (sender,receiver,text,mediaUrl,mediaType) VALUES (?,?,?,?,?)",
    [user, receiver, "", mediaUrl, mediaType],
    function () {
      const msg = {
        type: "message",
        id: this.lastID,
        sender: user,
        receiver,
        text: "",
        mediaUrl,
        mediaType
      };
      deliverMessage(msg);
      res.json({ success: true });
    }
  );
});

/* ================= STORIES ================= */

app.get("/api/stories", (req, res) => {
  db.all("SELECT * FROM stories ORDER BY id DESC LIMIT 50", (err, rows) => {
    res.json(rows || []);
  });
});

app.post("/api/stories", upload.single("story"), (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const text = String(req.body.text || "").slice(0, 120);

  let mediaUrl = "";
  let mediaType = "";

  if (req.file) {
    const ext = path.extname(req.file.originalname);
    const filename = req.file.filename + ext;
    const diskPath = path.join("uploads", filename);
    fs.renameSync(req.file.path, diskPath);

    mediaUrl = "/uploads/" + filename;
    mediaType = req.file.mimetype.startsWith("video") ? "video" : "image";
  }

  db.run(
    "INSERT INTO stories (owner,mediaUrl,mediaType,text) VALUES (?,?,?,?)",
    [user, mediaUrl, mediaType, text],
    () => res.json({ success: true })
  );
});

/* ================= WEBSOCKET ================= */

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace("/?", ""));
  const user = normUser(params.get("user") || "");

  if (user) clients.set(user, ws);

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // TEXT MESSAGE
    if (data.type === "text") {
      const sender = normUser(data.sender);
      const receiverRaw = String(data.receiver || "global");
      const receiver = receiverRaw === "global" ? "global" : normUser(receiverRaw);
      const text = String(data.text || "").slice(0, 4000);

      db.run(
        "INSERT INTO messages (sender,receiver,text) VALUES (?,?,?)",
        [sender, receiver, text],
        function () {
          const msg = {
            type: "message",
            id: this.lastID,
            sender,
            receiver,
            text,
            mediaUrl: "",
            mediaType: ""
          };
          deliverMessage(msg);
        }
      );
      return;
    }

    // CALL SIGNALING
    if (
      data.type === "call-offer" ||
      data.type === "call-answer" ||
      data.type === "ice-candidate" ||
      data.type === "call-end" ||
      data.type === "call-decline"
    ) {
      const to = normUser(data.to || "");
      const target = clients.get(to);
      if (target) safeSend(target, data);
      return;
    }
  });

  ws.on("close", () => {
    if (user) clients.delete(user);
  });
});

server.listen(PORT, () => console.log("Server running on port", PORT));
