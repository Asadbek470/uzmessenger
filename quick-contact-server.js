// ================================================================
// Zumo — «Быстрый контакт» (quick-contact-server.js)
// Находит людей рядом, у которых тоже включён «Быстрый контакт».
//
// Как это работает и почему безопасно:
//  • Режим включается человеком САМ и работает, только пока открыт экран «Быстрый контакт».
//    Закрыл экран или потерял сеть — через ~75 секунд человека уже не видно.
//  • Координаты хранятся только в памяти сервера (в базу не пишутся)
//    и никому не показываются. Другие видят лишь «очень близко / рядом / поблизости».
//  • Видят друг друга только те, у кого режим включён одновременно.
//  • Заблокированные друг другом люди не видят друг друга.
//  • Написать можно только через приглашение: второй человек его принимает или отклоняет.
// ================================================================
module.exports = function setupQuickContact(ctx) {
  const {
    app, verifyAuth, rateLimit, dbGet, dbAll, dbRun,
    wsSendToUser, getUserCards, isBlocked, now
  } = ctx;

  const ACTIVE_MS = 75 * 1000;           // человек виден, пока экран открыт и шлёт «я здесь» (каждые ~8 с)
  const MAX_ACCURACY_M = 5000;           // GPS хуже этого — не используем (по Wi-Fi/вышкам бывает 500–2000 м)
  const MAX_RADIUS_M = 1500;             // дальше этого людей не показываем
  const BASE_RADIUS_M = 200;             // минимальный радиус «рядом»
  const INVITE_COOLDOWN_MS = 24 * 3600 * 1000; // после отказа — повторно не беспокоить сутки
  const MAX_INVITES_AT_ONCE = 10;

  // username -> { lat, lng, acc, at, exp }
  const active = new Map();

  const clean = (u) => String(u || "").replace(/^@+/, "").toLowerCase();

  const timer = setInterval(() => {
    const t = now();
    for (const [u, p] of active) if (p.exp <= t) active.delete(u);
  }, 60 * 1000);
  if (timer.unref) timer.unref();

  function distanceM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  function readPoint(body) {
    const lat = Number(body && body.lat), lng = Number(body && body.lng);
    let acc = Number(body && body.acc);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (!Number.isFinite(acc) || acc < 0) acc = 100;
    return { lat, lng, acc };
  }

  function bucket(dist) {
    if (dist <= 25) return { key: "very-close", text: "очень близко" };
    if (dist <= 80) return { key: "close", text: "рядом" };
    return { key: "near", text: "поблизости" };
  }

  async function nearbyFor(me) {
    const mine = active.get(me);
    if (!mine) return [];
    const t = now();
    const found = [];
    for (const [u, p] of active) {
      if (u === me || p.exp <= t) continue;
      const d = distanceM(mine, p);
      // чем хуже точность у обоих, тем шире допуск, но не больше MAX_RADIUS_M
      const radius = Math.min(MAX_RADIUS_M, BASE_RADIUS_M + mine.acc + p.acc);
      if (d > radius) continue;
      found.push({ username: u, d });
    }
    if (!found.length) return [];

    // убираем заблокированных и забаненных
    const ok = [];
    for (const f of found) {
      const row = await dbGet(`SELECT banned FROM users WHERE username=?`, [f.username]);
      if (!row || row.banned) continue;
      if (await isBlocked(me, f.username)) continue;
      ok.push(f);
    }
    ok.sort((a, b) => a.d - b.d);

    const cards = await getUserCards(ok.map(f => f.username));
    const contacts = await dbAll(`SELECT username FROM contacts WHERE owner=?`, [me]);
    const contactSet = new Set(contacts.map(c => c.username));
    const pending = await dbAll(
      `SELECT toUser FROM quick_invites WHERE fromUser=? AND status='pending'`, [me]
    );
    const pendingSet = new Set(pending.map(p => p.toUser));

    return ok.map(f => ({
      ...(cards[f.username] || { username: f.username, displayName: f.username }),
      distance: bucket(f.d),
      isContact: contactSet.has(f.username),
      invited: pendingSet.has(f.username)
    }));
  }

  // сколько ЕЩЁ людей сейчас в режиме (только число — для подсказки «почему никого нет»)
  function othersActive(me) {
    const t = now();
    let n = 0;
    for (const [u, p] of active) if (u !== me && p.exp > t) n++;
    return n;
  }

  // ---------- включить / обновить место ----------
  app.post("/api/quick/ping", verifyAuth, rateLimit(60, 60 * 1000), async (req, res) => {
    try {
      const me = req.user.username;
      const pt = readPoint(req.body);
      if (!pt) return res.status(400).json({ ok: false, error: "Не удалось определить место" });
      if (pt.acc > MAX_ACCURACY_M) {
        return res.status(400).json({ ok: false, weak: true, error: "Очень слабый сигнал (±" + Math.round(pt.acc) + " м). Включи GPS и выйди к окну или на улицу" });
      }
      const t = now();
      active.set(me, { ...pt, at: t, exp: t + ACTIVE_MS });
      res.json({ ok: true, expiresAt: t + ACTIVE_MS, acc: Math.round(pt.acc), others: othersActive(me), users: await nearbyFor(me) });
    } catch (e) {
      console.error("[QUICK] ping", e && e.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Ошибка сервера, попробуй ещё раз" });
    }
  });

  // ---------- выключить ----------
  app.post("/api/quick/off", verifyAuth, (req, res) => {
    active.delete(req.user.username);
    res.json({ ok: true });
  });

  // ---------- отправить приглашения ----------
  app.post("/api/quick/invite", verifyAuth, rateLimit(20, 60 * 1000), async (req, res) => {
   try {
    const me = req.user.username;
    if (!active.has(me)) return res.status(400).json({ ok: false, error: "Сначала включи «Быстрый контакт»" });

    const list = [...new Set((Array.isArray(req.body.usernames) ? req.body.usernames : []).map(clean))]
      .filter(u => u && u !== me).slice(0, MAX_INVITES_AT_ONCE);
    if (!list.length) return res.status(400).json({ ok: false, error: "Выбери хотя бы одного человека" });

    // приглашать можно только тех, кто сейчас реально рядом
    const nearby = await nearbyFor(me);
    const nearSet = new Set(nearby.map(n => n.username));
    const sent = [], skipped = [];
    const myCard = (await getUserCards([me]))[me];

    for (const u of list) {
      if (!nearSet.has(u)) { skipped.push(u); continue; }
      const recent = await dbGet(
        `SELECT 1 FROM quick_invites WHERE fromUser=? AND toUser=? AND (status='pending' OR (status='declined' AND answeredAt>?))`,
        [me, u, now() - INVITE_COOLDOWN_MS]
      );
      if (recent) { skipped.push(u); continue; }
      const r = await dbRun(
        `INSERT INTO quick_invites (fromUser, toUser, status, createdAt) VALUES (?,?, 'pending', ?)`,
        [me, u, now()]
      );
      sent.push(u);
      wsSendToUser(u, { type: "quick-invite", invite: { id: r.lastID, from: myCard, createdAt: now() } });
    }
    res.json({ ok: true, sent, skipped });
   } catch (e) {
    console.error("[QUICK] invite", e && e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Ошибка сервера" });
   }
  });

  // ---------- входящие приглашения ----------
  app.get("/api/quick/invites", verifyAuth, async (req, res) => {
    const me = req.user.username;
    const rows = await dbAll(
      `SELECT id, fromUser, createdAt FROM quick_invites WHERE toUser=? AND status='pending' AND createdAt>? ORDER BY createdAt DESC LIMIT 20`,
      [me, now() - 24 * 3600 * 1000]
    );
    const cards = await getUserCards(rows.map(r => r.fromUser));
    res.json({
      ok: true,
      invites: rows.map(r => ({ id: r.id, from: cards[r.fromUser] || { username: r.fromUser, displayName: r.fromUser }, createdAt: r.createdAt }))
    });
  });

  async function addContactBoth(a, b) {
    for (const [owner, other] of [[a, b], [b, a]]) {
      const exists = await dbGet(`SELECT 1 FROM contacts WHERE owner=? AND username=?`, [owner, other]);
      if (!exists) {
        await dbRun(`INSERT INTO contacts (owner, username, name, note, createdAt) VALUES (?,?,?,?,?)`,
          [owner, other, "", "Быстрый контакт", now()]);
      }
      await dbRun(`INSERT OR IGNORE INTO dm_exceptions (owner, allowed, createdAt) VALUES (?,?,?)`, [owner, other, now()]);
    }
  }

  app.post("/api/quick/invites/:id/accept", verifyAuth, async (req, res) => {
   try {
    const me = req.user.username;
    const id = Number(req.params.id);
    const inv = await dbGet(`SELECT * FROM quick_invites WHERE id=? AND toUser=? AND status='pending'`, [id, me]);
    if (!inv) return res.status(404).json({ ok: false, error: "Приглашение уже не действует" });
    if (await isBlocked(me, inv.fromUser)) return res.status(403).json({ ok: false, error: "Нельзя принять" });
    await dbRun(`UPDATE quick_invites SET status='accepted', answeredAt=? WHERE id=?`, [now(), id]);
    await addContactBoth(me, inv.fromUser);
    wsSendToUser(inv.fromUser, { type: "quick-accepted", by: (await getUserCards([me]))[me] });
    res.json({ ok: true, username: inv.fromUser });
   } catch (e) {
    console.error("[QUICK] accept", e && e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Ошибка сервера" });
   }
  });

  app.post("/api/quick/invites/:id/decline", verifyAuth, async (req, res) => {
    const me = req.user.username;
    const id = Number(req.params.id);
    await dbRun(`UPDATE quick_invites SET status='declined', answeredAt=? WHERE id=? AND toUser=? AND status='pending'`, [now(), id, me]);
    res.json({ ok: true });
  });

  return {
    onUserGone(username) { active.delete(username); }
  };
};
