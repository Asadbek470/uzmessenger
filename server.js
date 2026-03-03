const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static("public"));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const upload = multer({ dest: "uploads/" });

const db = new sqlite3.Database("./database.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS profiles (
    username TEXT PRIMARY KEY,
    displayName TEXT,
    bio TEXT,
    avatar TEXT
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

const clients = new Map();

/* ================= AUTH ================= */

app.post("/api/auth/reg", (req, res) => {
  const { username, password } = req.body;
  db.run("INSERT INTO users VALUES (?,?)", [username, password], err => {
    if (err) return res.json({ success: false });
    db.run("INSERT INTO profiles VALUES (?,?,?,?)", [username, username, "", "" ]);
    res.json({ success: true });
  });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username=? AND password=?", [username, password], (err, row) => {
    if (!row) return res.json({ success: false });
    res.json({ success: true });
  });
});

/* ================= SEARCH ================= */

app.get("/api/search", (req, res) => {
  const q = "%" + req.query.q + "%";
  db.all("SELECT username, displayName FROM profiles WHERE username LIKE ?", [q], (err, rows) => {
    res.json(rows || []);
  });
});

/* ================= MESSAGES ================= */

app.get("/api/messages", (req, res) => {
  const user = req.headers["x-user"];
  const chat = req.query.chat;

  if (chat === "global") {
    db.all("SELECT * FROM messages WHERE receiver='global' ORDER BY id ASC", (err, rows) => {
      res.json(rows || []);
    });
  } else {
    db.all(
      `SELECT * FROM messages WHERE 
      (sender=? AND receiver=?) OR 
      (sender=? AND receiver=?) 
      ORDER BY id ASC`,
      [user, chat, chat, user],
      (err, rows) => res.json(rows || [])
    );
  }
});

app.delete("/api/messages/:id", (req, res) => {
  db.run("DELETE FROM messages WHERE id=?", [req.params.id], () => {
    res.json({ success: true });
  });
});

/* ================= UPLOAD ================= */

app.post("/api/upload", upload.single("file"), (req, res) => {
  const user = req.headers["x-user"];
  const receiver = req.body.receiver;
  const file = req.file;

  const ext = path.extname(file.originalname);
  const newPath = file.path + ext;
  fs.renameSync(file.path, newPath);

  let mediaType = "image";
  if (file.mimetype.startsWith("video")) mediaType = "video";
  if (file.mimetype.startsWith("audio")) mediaType = "audio";

  db.run(
    "INSERT INTO messages (sender,receiver,text,mediaUrl,mediaType) VALUES (?,?,?,?,?)",
    [user, receiver, "", newPath, mediaType]
  );

  res.json({ success: true });
});

/* ================= PROFILE ================= */

app.get("/api/me", (req, res) => {
  const user = req.headers["x-user"];
  db.get("SELECT * FROM profiles WHERE username=?", [user], (err, row) => {
    res.json({ success: true, profile: row });
  });
});

app.post("/api/me", (req, res) => {
  const user = req.headers["x-user"];
  const { displayName, bio } = req.body;
  db.run("UPDATE profiles SET displayName=?, bio=? WHERE username=?", [displayName, bio, user]);
  res.json({ success: true });
});

/* ================= STORIES ================= */

app.get("/api/stories", (req, res) => {
  db.all("SELECT * FROM stories ORDER BY id DESC", (err, rows) => {
    res.json(rows || []);
  });
});

app.post("/api/stories", upload.single("story"), (req, res) => {
  const user = req.headers["x-user"];
  const text = req.body.text || "";

  let mediaUrl = "";
  let mediaType = "";

  if (req.file) {
    const ext = path.extname(req.file.originalname);
    const newPath = req.file.path + ext;
    fs.renameSync(req.file.path, newPath);

    mediaUrl = newPath;
    mediaType = req.file.mimetype.startsWith("video") ? "video" : "image";
  }

  db.run("INSERT INTO stories (owner,mediaUrl,mediaType,text) VALUES (?,?,?,?)",
    [user, mediaUrl, mediaType, text]);

  res.json({ success: true });
});

/* ================= WEBSOCKET ================= */

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace("/?", ""));
  const user = params.get("user");
  if (user) clients.set(user, ws);

  ws.on("message", message => {
    const data = JSON.parse(message);

    if (data.type === "text") {
      db.run(
        "INSERT INTO messages (sender,receiver,text) VALUES (?,?,?)",
        [data.sender, data.receiver, data.text]
      );

      const target = clients.get(data.receiver);
      if (target) target.send(JSON.stringify({ type: "message", ...data }));
    }

    if (data.type === "call-offer" || data.type === "call-answer" || data.type === "ice-candidate" || data.type === "call-end") {
      const target = clients.get(data.to);
      if (target) target.send(JSON.stringify(data));
    }
  });

  ws.on("close", () => {
    clients.delete(user);
  });
});

server.listen(3000, () => console.log("Server running on port 3000"));
