const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Инициализация БД (sqlite3 использует асинхронный подход)
const db = new sqlite3.Database('messenger.db', (err) => {
    if (err) console.error('Database error:', err.message);
    console.log('Connected to SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, displayName TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API для загрузки истории
app.get('/api/messages', (req, res) => {
    db.all('SELECT * FROM messages ORDER BY timestamp ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            if (data.type === 'chat') {
                const stmt = db.prepare('INSERT INTO messages (sender, text) VALUES (?, ?)');
                stmt.run(data.sender, data.text);
                stmt.finalize();
                
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (e) { console.error("WS Error:", e); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));
