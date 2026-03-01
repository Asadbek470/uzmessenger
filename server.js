const express = require('express');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const db = new sqlite3.Database('messenger.db');

// Хранилище для медиа
const storage = multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });
if (!fs.existsSync('public/uploads')) fs.mkdirSync('public/uploads', { recursive: true });

app.use(express.json());
app.use(express.static('public'));
app.use(session({ secret: 'tg-secret', resave: false, saveUninitialized: true }));

// Инициализация БД
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, displayName TEXT, bio TEXT, avatar TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, text TEXT, fileUrl TEXT, type TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// Auth API
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (username, password, displayName) VALUES (?, ?, ?)", [username, hash, username], (err) => {
        if (err) return res.status(400).json({ error: "User exists" });
        res.json({ success: true });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.user = user;
            res.json({ success: true, user });
        } else res.status(401).json({ error: "Auth failed" });
    });
});

app.get('/api/search', (req, res) => {
    db.all("SELECT username, displayName, avatar FROM users WHERE username LIKE ? LIMIT 5", [`%${req.query.q}%`], (err, rows) => res.json(rows));
});

app.post('/api/upload', upload.single('file'), (req, res) => res.json({ url: '/uploads/' + req.file.filename }));

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        const data = JSON.parse(raw);
        db.run("INSERT INTO messages (sender, receiver, text, fileUrl, type) VALUES (?, ?, ?, ?, ?)", 
               [data.sender, data.receiver, data.text, data.fileUrl, data.type]);
        wss.clients.forEach(c => c.send(JSON.stringify(data)));
    });
});

server.listen(process.env.PORT || 3000, () => console.log('Pro Server running'));
