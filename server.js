const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const host = '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'adminpass';

app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Create uploads folder if not exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Database setup
const db = new sqlite3.Database('database.db', (err) => {
  if (err) console.error(err);
  else console.log('Connected to SQLite database.');
});

// Create tables if not exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    displayName TEXT,
    bio TEXT,
    avatarUrl TEXT,
    birthDate TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    lastSeen DATETIME,
    blockedUntil DATETIME,
    canSendText BOOLEAN DEFAULT 1,
    canSendMedia BOOLEAN DEFAULT 1,
    canCall BOOLEAN DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatType TEXT NOT NULL,  -- 'personal', 'group', 'global'
    groupId INTEGER,
    user1 TEXT,
    user2 TEXT,
    sender TEXT NOT NULL,
    receiver TEXT,
    text TEXT,
    mediaType TEXT,
    mediaUrl TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    text TEXT,
    mediaType TEXT,
    mediaUrl TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    expiresAt DATETIME
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    deviceId TEXT NOT NULL,
    deviceName TEXT,
    lastUsed DATETIME DEFAULT CURRENT_TIMESTAMP,
    firstSeen DATETIME DEFAULT CURRENT_TIMESTAMP,
    trusted BOOLEAN DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    deviceId TEXT NOT NULL,
    code TEXT NOT NULL,
    expiresAt DATETIME,
    attempts INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatarUrl TEXT,
    description TEXT,
    owner TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    groupId INTEGER NOT NULL,
    username TEXT NOT NULL,
    role TEXT DEFAULT 'member',  -- 'member', 'admin', 'owner'
    joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (groupId, username)
  )`);
});

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Middleware to verify JWT
const verifyAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Check if blocked
    db.get('SELECT blockedUntil FROM users WHERE username = ?', [req.user.username], (err, row) => {
      if (err || !row) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      if (row.blockedUntil && new Date(row.blockedUntil) > new Date()) {
        return res.status(403).json({ ok: false, error: 'Account blocked' });
      }
      next();
    });
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Invalid token' });
  }
};

// Generate 6-digit code
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Send system message from @telegram
const sendSystemMessage = (receiver, text) => {
  db.run(`INSERT INTO messages (chatType, user1, user2, sender, receiver, text) VALUES (?, ?, ?, ?, ?, ?)`,
    ['personal', '@telegram', receiver, '@telegram', receiver, text]);
};

// Auth routes
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!/^[a-z0-9_]{4,20}$/.test(username)) return res.status(400).json({ ok: false, error: 'Invalid username' });

  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    db.run('INSERT INTO users (username, passwordHash) VALUES (?, ?)', [username, hash], (err) => {
      if (err) return res.status(400).json({ ok: false, error: 'Username taken' });
      res.json({ ok: true });
    });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password, deviceId, deviceName } = req.body;  // deviceId could be a unique string per device
  db.get('SELECT * FROM users WHERE username = ?', [identifier], (err, user) => {
    if (err || !user) return res.status(400).json({ ok: false, error: 'Invalid credentials' });
    bcrypt.compare(password, user.passwordHash, (err, match) => {
      if (!match) return res.status(400).json({ ok: false, error: 'Invalid credentials' });

      // Check if device is new
      db.get('SELECT * FROM sessions WHERE username = ? AND deviceId = ?', [identifier, deviceId], (err, session) => {
        if (session && session.trusted) {
          // Trusted device, issue token
          const token = jwt.sign({ username: identifier }, JWT_SECRET, { expiresIn: '30d' });
          db.run('UPDATE sessions SET lastUsed = CURRENT_TIMESTAMP WHERE id = ?', [session.id]);
          return res.json({ ok: true, token });
        } else {
          // New or untrusted device, send code
          const code = generateCode();
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();  // 10 min
          db.run('INSERT OR REPLACE INTO auth_codes (username, deviceId, code, expiresAt, attempts) VALUES (?, ?, ?, ?, 0)',
            [identifier, deviceId, code, expiresAt]);

          // Create session if new
          if (!session) {
            db.run('INSERT INTO sessions (username, deviceId, deviceName) VALUES (?, ?, ?)', [identifier, deviceId, deviceName]);
          }

          sendSystemMessage(identifier, `Your login code: ${code}`);
          res.json({ ok: true, requireConfirm: true });
        }
      });
    });
  });
});

app.post('/api/auth/confirm', (req, res) => {
  const { username, code, deviceId } = req.body;
  db.get('SELECT * FROM auth_codes WHERE username = ? AND deviceId = ? AND code = ? AND expiresAt > CURRENT_TIMESTAMP',
    [username, deviceId, code], (err, row) => {
      if (err || !row || row.attempts >= 3) return res.status(400).json({ ok: false, error: 'Invalid or expired code' });

      // Mark as trusted
      db.run('UPDATE sessions SET trusted = 1 WHERE username = ? AND deviceId = ?', [username, deviceId]);
      db.run('DELETE FROM auth_codes WHERE username = ? AND deviceId = ?', [username, deviceId]);

      const token = jwt.sign({ username: username }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ ok: true, token });
    });
});

// Profile routes
app.get('/api/me', verifyAuth, (req, res) => {
  db.get('SELECT username, displayName, bio, avatarUrl, birthDate FROM users WHERE username = ?', [req.user.username], (err, row) => {
    if (err || !row) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user: row });
  });
});

app.put('/api/me', verifyAuth, upload.single('avatar'), (req, res) => {
  const { displayName, bio, birthDate } = req.body;
  const avatarUrl = req.file ? `/uploads/${req.file.filename}` : undefined;
  const updates = [];
  const params = [];

  if (displayName) {
    updates.push('displayName = ?');
    params.push(displayName);
  }
  if (bio) {
    updates.push('bio = ?');
    params.push(bio);
  }
  if (birthDate) {
    updates.push('birthDate = ?');
    params.push(birthDate);
  }
  if (avatarUrl) {
    updates.push('avatarUrl = ?');
    params.push(avatarUrl);
  }

  if (updates.length === 0) return res.status(400).json({ ok: false, error: 'No updates' });

  params.push(req.user.username);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`, params, (err) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    res.json({ ok: true });
  });
});

app.delete('/api/me', verifyAuth, (req, res) => {
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    try {
      db.run('DELETE FROM messages WHERE sender = ? OR receiver = ?', [req.user.username, req.user.username]);
      db.run('DELETE FROM stories WHERE owner = ?', [req.user.username]);
      db.run('DELETE FROM sessions WHERE username = ?', [req.user.username]);
      db.run('DELETE FROM auth_codes WHERE username = ?', [req.user.username]);
      db.run('DELETE FROM group_members WHERE username = ?', [req.user.username]);
      // For groups owned, delete group and members
      db.all('SELECT id FROM groups WHERE owner = ?', [req.user.username], (err, groups) => {
        groups.forEach(g => {
          db.run('DELETE FROM groups WHERE id = ?', [g.id]);
          db.run('DELETE FROM group_members WHERE groupId = ?', [g.id]);
          db.run('DELETE FROM messages WHERE groupId = ?', [g.id]);
        });
      });
      db.run('DELETE FROM users WHERE username = ?', [req.user.username]);
      db.run('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      db.run('ROLLBACK');
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });
});

// Users routes
app.get('/api/users/search', verifyAuth, (req, res) => {
  const q = `%${req.query.q}%`;
  db.all('SELECT username, displayName, avatarUrl FROM users WHERE username LIKE ? AND username != ?', [q, req.user.username], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    res.json({ ok: true, users: rows });
  });
});

app.get('/api/users/:username', verifyAuth, (req, res) => {
  db.get('SELECT username, displayName, bio, avatarUrl, birthDate, lastSeen FROM users WHERE username = ?', [req.params.username], (err, row) => {
    if (err || !row) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user: row });
  });
});

// Chats routes
app.get('/api/chats', verifyAuth, (req, res) => {
  const username = req.user.username;
  // Global chat
  const chats = [{ id: 'global', type: 'global', name: 'Global Chat' }];

  // Personal chats
  db.all(`SELECT DISTINCT CASE WHEN sender = ? THEN receiver ELSE sender END AS peer FROM messages WHERE chatType = 'personal' AND (sender = ? OR receiver = ?)`, [username, username, username], (err, peers) => {
    peers.forEach(p => chats.push({ id: p.peer, type: 'personal', name: p.peer }));

    // Groups
    db.all(`SELECT g.id, g.name FROM groups g JOIN group_members gm ON g.id = gm.groupId WHERE gm.username = ?`, [username], (err, groups) => {
      groups.forEach(g => chats.push({ id: `group:${g.id}`, type: 'group', name: g.name }));

      // Add last message to each (simplified, can be optimized with subqueries)
      res.json({ ok: true, chats });
    });
  });
});

app.get('/api/messages', verifyAuth, (req, res) => {
  const chat = req.query.chat;
  let query, params;

  if (chat === 'global') {
    query = 'SELECT * FROM messages WHERE chatType = "global" ORDER BY createdAt ASC';
    params = [];
  } else if (chat.startsWith('group:')) {
    const groupId = chat.split(':')[1];
    query = 'SELECT * FROM messages WHERE chatType = "group" AND groupId = ? ORDER BY createdAt ASC';
    params = [groupId];
  } else {
    const user1 = req.user.username < chat ? req.user.username : chat;
    const user2 = req.user.username > chat ? req.user.username : chat;
    query = 'SELECT * FROM messages WHERE chatType = "personal" AND user1 = ? AND user2 = ? ORDER BY createdAt ASC';
    params = [user1, user2];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    res.json({ ok: true, messages: rows });
  });
});

app.delete('/api/messages/:id', verifyAuth, (req, res) => {
  db.get('SELECT sender FROM messages WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row || row.sender !== req.user.username) return res.status(403).json({ ok: false, error: 'Not authorized' });
    db.run('DELETE FROM messages WHERE id = ?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Server error' });
      res.json({ ok: true });
    });
  });
});

// Upload file
app.post('/api/upload', verifyAuth, upload.single('file'), (req, res) => {
  if (!req.user.canSendMedia) return res.status(403).json({ ok: false, error: 'Permission denied' });
  const mediaUrl = `/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.split('/')[0];  // image, video, audio
  res.json({ ok: true, mediaUrl, mediaType });
});

// Stories routes
app.get('/api/stories', verifyAuth, (req, res) => {
  db.all('SELECT * FROM stories WHERE expiresAt > CURRENT_TIMESTAMP ORDER BY createdAt DESC', (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    res.json({ ok: true, stories: rows });
  });
});

app.post('/api/stories', verifyAuth, upload.single('media'), (req, res) => {
  const { text } = req.body;
  const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;
  const mediaType = req.file ? req.file.mimetype.split('/')[0] : null;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.run('INSERT INTO stories (owner, text, mediaType, mediaUrl, expiresAt) VALUES (?, ?, ?, ?, ?)',
    [req.user.username, text, mediaType, mediaUrl, expiresAt], (err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Server error' });
      res.json({ ok: true });
    });
});

// Birthdays
app.get('/api/birthdays/today', verifyAuth, (req, res) => {
  const today = new Date().toISOString().slice(5, 10);  // MM-DD
  db.all('SELECT username, displayName FROM users WHERE SUBSTR(birthDate, 6, 5) = ?', [today], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    res.json({ ok: true, birthdays: rows });
  });
});

// Groups routes
app.post('/api/groups', verifyAuth, (req, res) => {
  const { name, description, members } = req.body;
  db.run('INSERT INTO groups (name, description, owner) VALUES (?, ?, ?)', [name, description, req.user.username], function(err) {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    const groupId = this.lastID;

    // Add owner
    db.run('INSERT INTO group_members (groupId, username, role) VALUES (?, ?, "owner")', [groupId, req.user.username]);

    // Add members
    members.forEach(m => {
      db.run('INSERT INTO group_members (groupId, username) VALUES (?, ?)', [groupId, m]);
    });

    res.json({ ok: true, groupId });
  });
});

app.get('/api/groups/:groupId', verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  db.get('SELECT * FROM groups WHERE id = ?', [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ ok: false, error: 'Group not found' });

    db.all('SELECT username, role FROM group_members WHERE groupId = ?', [groupId], (err, members) => {
      res.json({ ok: true, group, members });
    });
  });
});

app.put('/api/groups/:groupId', verifyAuth, upload.single('avatar'), (req, res) => {
  const groupId = req.params.groupId;
  const { name, description } = req.body;
  const avatarUrl = req.file ? `/uploads/${req.file.filename}` : undefined;

  // Check if admin or owner
  db.get('SELECT role FROM group_members WHERE groupId = ? AND username = ?', [groupId, req.user.username], (err, row) => {
    if (err || !row || (row.role !== 'admin' && row.role !== 'owner')) return res.status(403).json({ ok: false, error: 'Not authorized' });

    const updates = [];
    const params = [];
    if (name) { updates.push('name = ?'); params.push(name); }
    if (description) { updates.push('description = ?'); params.push(description); }
    if (avatarUrl) { updates.push('avatarUrl = ?'); params.push(avatarUrl); }
    updates.push('updatedAt = CURRENT_TIMESTAMP');

    params.push(groupId);
    db.run(`UPDATE groups SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Server error' });
      res.json({ ok: true });
    });
  });
});

app.post('/api/groups/:groupId/members', verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  const { usernames } = req.body;

  // Check if admin or owner
  db.get('SELECT role FROM group_members WHERE groupId = ? AND username = ?', [groupId, req.user.username], (err, row) => {
    if (err || !row || (row.role !== 'admin' && row.role !== 'owner')) return res.status(403).json({ ok: false, error: 'Not authorized' });

    usernames.forEach(u => {
      db.run('INSERT OR IGNORE INTO group_members (groupId, username) VALUES (?, ?)', [groupId, u]);
    });
    res.json({ ok: true });
  });
});

app.delete('/api/groups/:groupId/members/:username', verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  const username = req.params.username;

  // Check if admin or owner
  db.get('SELECT role FROM group_members WHERE groupId = ? AND username = ?', [groupId, req.user.username], (err, row) => {
    if (err || !row || (row.role !== 'admin' && row.role !== 'owner')) return res.status(403).json({ ok: false, error: 'Not authorized' });

    db.run('DELETE FROM group_members WHERE groupId = ? AND username = ?', [groupId, username], (err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Server error' });
      res.json({ ok: true });
    });
  });
});

app.put('/api/groups/:groupId/members/:username/role', verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  const username = req.params.username;
  const { role } = req.body;  // 'admin' or 'member'

  // Check if owner
  db.get('SELECT role FROM group_members WHERE groupId = ? AND username = ?', [groupId, req.user.username], (err, row) => {
    if (err || !row || row.role !== 'owner') return res.status(403).json({ ok: false, error: 'Not authorized' });

    db.run('UPDATE group_members SET role = ? WHERE groupId = ? AND username = ?', [role, groupId, username], (err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Server error' });
      res.json({ ok: true });
    });
  });
});

// Admin routes
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ isAdmin: true }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
});

const verifyAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ ok: false, error: 'Not admin' });
    next();
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Invalid token' });
  }
};

app.get('/api/admin/users', verifyAdmin, (req, res) => {
  db.all('SELECT username, createdAt, lastSeen, blockedUntil, canSendText, canSendMedia, canCall FROM users', (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    res.json({ ok: true, users: rows });
  });
});

app.post('/api/admin/user/update', verifyAdmin, (req, res) => {
  const { username, blockedUntil, canSendText, canSendMedia, canCall } = req.body;
  const updates = [];
  const params = [];

  if (blockedUntil !== undefined) { updates.push('blockedUntil = ?'); params.push(blockedUntil); }
  if (canSendText !== undefined) { updates.push('canSendText = ?'); params.push(canSendText); }
  if (canSendMedia !== undefined) { updates.push('canSendMedia = ?'); params.push(canSendMedia); }
  if (canCall !== undefined) { updates.push('canCall = ?'); params.push(canCall); }

  params.push(username);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`, params, (err) => {
    if (err) return res.status(500).json({ ok: false, error: 'Server error' });
    res.json({ ok: true });
  });
});

// WebSocket setup
const server = app.listen(port, host, () => console.log(`Server running on ${host}:${port}`));
const wss = new WebSocket.Server({ server });

const onlineUsers = new Map();  // username => ws
const typingUsers = new Map();  // chatId => Set(usernames)

wss.on('connection', (ws, req) => {
  const token = new URLSearchParams(req.url.slice(1)).get('token');
  if (!token) return ws.close();

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    onlineUsers.set(username, ws);

    // Update lastSeen to null (online)
    db.run('UPDATE users SET lastSeen = NULL WHERE username = ?', [username]);

    // Broadcast online status
    broadcastStatus(username, 'online');

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return;
      }

      // Check permissions
      db.get('SELECT canSendText, canSendMedia, canCall FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) return;

        switch (data.type) {
          case 'text-message':
            if (!user.canSendText) return;
            handleTextMessage(data, username);
            break;
          case 'media-message':
            if (!user.canSendMedia) return;
            // Media uploaded via HTTP, but can broadcast here if needed
            break;
          case 'typing':
            handleTyping(data, username);
            break;
          case 'call-offer':
          case 'call-answer':
          case 'ice':
          case 'call-end':
            if (!user.canCall) return;
            handleCallSignaling(data, username);
            break;
        }
      });
    });

    ws.on('close', () => {
      onlineUsers.delete(username);
      db.run('UPDATE users SET lastSeen = CURRENT_TIMESTAMP WHERE username = ?', [username]);
      broadcastStatus(username, 'offline');
    });
  } catch (err) {
    ws.close();
  }
});

// Helper functions
function broadcast(toUsers, message) {
  toUsers.forEach(u => {
    const ws = onlineUsers.get(u);
    if (ws) ws.send(JSON.stringify(message));
  });
}

function broadcastStatus(username, status) {
  onlineUsers.forEach((ws, u) => {
    ws.send(JSON.stringify({ type: 'status', username, status }));
  });
}

function handleTextMessage(data, sender) {
  const { chatType, receiver, groupId, text } = data;

  let query, params;
  if (chatType === 'global') {
    query = 'INSERT INTO messages (chatType, sender, text) VALUES (?, ?, ?)';
    params = ['global', sender, text];
  } else if (chatType === 'group') {
    query = 'INSERT INTO messages (chatType, groupId, sender, text) VALUES (?, ?, ?, ?)';
    params = ['group', groupId, sender, text];
  } else if (chatType === 'personal') {
    const user1 = sender < receiver ? sender : receiver;
    const user2 = sender > receiver ? sender : receiver;
    query = 'INSERT INTO messages (chatType, user1, user2, sender, receiver, text) VALUES (?, ?, ?, ?, ?, ?)';
    params = ['personal', user1, user2, sender, receiver, text];
  }

  db.run(query, params, function(err) {
    if (err) return;
    const msgId = this.lastID;

    // Broadcast to recipients
    const broadcastMsg = { type: 'text-message', id: msgId, sender, text, createdAt: new Date().toISOString() };
    if (chatType === 'global') {
      onlineUsers.forEach(ws => ws.send(JSON.stringify(broadcastMsg)));
    } else if (chatType === 'group') {
      db.all('SELECT username FROM group_members WHERE groupId = ?', [groupId], (err, members) => {
        broadcast(members.map(m => m.username), broadcastMsg);
      });
    } else {
      broadcast([receiver], broadcastMsg);
      // Also send to sender if needed
      onlineUsers.get(sender)?.send(JSON.stringify(broadcastMsg));
    }
  });
}

function handleTyping(data, sender) {
  const { chatId, isTyping } = data;
  // chatId could be 'global', 'group:123', or '@username'

  if (isTyping) {
    if (!typingUsers.has(chatId)) typingUsers.set(chatId, new Set());
    typingUsers.get(chatId).add(sender);
  } else {
    typingUsers.get(chatId)?.delete(sender);
  }

  // Broadcast typing status to chat participants
  const typingList = Array.from(typingUsers.get(chatId) || []);
  const msg = { type: 'typing', chatId, typing: typingList };

  if (chatId === 'global') {
    onlineUsers.forEach(ws => ws.send(JSON.stringify(msg)));
  } else if (chatId.startsWith('group:')) {
    const groupId = chatId.split(':')[1];
    db.all('SELECT username FROM group_members WHERE groupId = ?', [groupId], (err, members) => {
      broadcast(members.map(m => m.username), msg);
    });
  } else {
    broadcast([chatId.replace('@', '')], msg);
  }
}

function handleCallSignaling(data, sender) {
  const { to } = data;
  const ws = onlineUsers.get(to);
  if (ws) {
    data.from = sender;
    ws.send(JSON.stringify(data));
  }
}
