const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

const app = express();
const db = new sqlite3.Database('messenger.db');
const upload = multer({ dest: 'public/uploads/' });

app.use(express.json());
app.use(express.static('public'));

// SQL: Создаем таблицы
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (sender TEXT, type TEXT, url TEXT, text TEXT)");
});

// Роуты авторизации
app.post('/api/auth/reg', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [req.body.username, hash], (err) => {
        if (err) return res.status(400).json({ success: false, error: "Username taken" });
        res.json({ success: true });
    });
});

app.post('/api/auth/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            res.json({ success: true });
        } else res.status(401).json({ success: false, error: "Wrong credentials" });
    });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    res.json({ url: '/uploads/' + req.file.filename });
});

app.listen(process.env.PORT || 3000);
