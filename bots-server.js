// ================================================================
// Zumo — конструктор чат-ботов внутри приложения (bots-server.js)
//
// Человек создаёт бота прямо в приложении, без внешних конструкторов.
// Бот — это отдельный аккаунт (юзернейм заканчивается на _bot), которому
// можно написать, как любому человеку. Его «мозг» — настройки владельца:
//   • приветствие + кнопки быстрых ответов;
//   • правила: «если в сообщении есть слова … → ответить …»;
//   • анкеты: бот задаёт вопросы по очереди и присылает ответы владельцу;
//   • ответ по умолчанию.
// Сообщения боту идут без сквозного шифрования (у бота нет ключа) — сервер
// должен их прочитать, чтобы ответить. Приложение это показывает в профиле бота.
// ================================================================
const crypto = require("crypto");

module.exports = function setupBots(ctx) {
  const {
    app, verifyAuth, rateLimit, dbGet, dbAll, dbRun, now,
    broadcastMessage, wsSendToUser, isUsernameReserved,
    BOT_USERNAMES, RESERVED_USERNAMES
  } = ctx;

  const MAX_BOTS_PER_USER = 5;
  const MAX_RULES = 40;
  const MAX_KEYWORDS = 20;
  const MAX_BUTTONS = 8;
  const MAX_QUESTIONS = 8;
  const FORM_TTL_MS = 6 * 3600 * 1000;      // анкета «забывается» через 6 часов
  const REPLIES_PER_MIN = 20;               // защита от флуда на одного человека

  const clean = (u) => String(u || "").replace(/^@+/, "").toLowerCase();
  const str = (v, max) => String(v == null ? "" : v).replace(/\r/g, "").trim().slice(0, max);

  // ---------- настройки бота: чистим всё, что пришло от клиента ----------
  function cleanButtons(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const b of list) {
      const t = str(b, 40);
      if (t && !out.includes(t)) out.push(t);
      if (out.length >= MAX_BUTTONS) break;
    }
    return out;
  }
  function cleanList(list, maxItems, maxLen) {
    if (!Array.isArray(list)) return [];
    return list.map(x => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
  }
  function cleanConfig(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const welcome = raw.welcome || {};
    const fallback = raw.fallback || {};
    const rules = (Array.isArray(raw.rules) ? raw.rules : []).slice(0, MAX_RULES).map((r) => {
      r = r || {};
      const type = r.type === "form" ? "form" : "reply";
      const id = /^[a-z0-9]{4,12}$/.test(String(r.id || "")) ? r.id : crypto.randomBytes(4).toString("hex");
      return {
        id,
        title: str(r.title, 60),
        type,
        match: r.match === "exact" ? "exact" : "contains",
        keywords: cleanList(r.keywords, MAX_KEYWORDS, 60),
        reply: str(r.reply, 1000),
        buttons: cleanButtons(r.buttons),
        questions: type === "form" ? cleanList(r.questions, MAX_QUESTIONS, 200) : [],
        done: str(r.done, 500)
      };
    }).filter(r => r.keywords.length && (r.type === "form" ? r.questions.length : r.reply));
    return {
      welcome: { text: str(welcome.text, 1000), buttons: cleanButtons(welcome.buttons) },
      fallback: { text: str(fallback.text, 1000), buttons: cleanButtons(fallback.buttons) },
      rules
    };
  }
  const DEFAULT_CONFIG = () => ({
    welcome: { text: "Здравствуйте, {name}! 👋 Чем могу помочь?", buttons: [] },
    fallback: { text: "Я пока не понял вопрос. Выберите вариант из меню или напишите по-другому.", buttons: [] },
    rules: []
  });
  function parseConfig(row) {
    try { return cleanConfig(JSON.parse(row.configJson || "{}")); } catch { return cleanConfig({}); }
  }

  // ---------- вспомогательное ----------
  function normalize(s) {
    return String(s || "").toLowerCase().replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  }
  function fill(text, user, bot) {
    return String(text || "")
      .replaceAll("{name}", user.displayName || user.username)
      .replaceAll("{username}", "@" + user.username)
      .replaceAll("{bot}", bot.name || bot.username);
  }
  async function getBot(username) {
    return dbGet(`SELECT * FROM bots WHERE username=?`, [username]);
  }
  function publicBot(row, withConfig) {
    const out = {
      username: row.username, name: row.name, description: row.description,
      enabled: !!row.enabled, createdAt: row.createdAt, updatedAt: row.updatedAt
    };
    if (withConfig) out.config = parseConfig(row);
    return out;
  }

  // ---------- отправка сообщения от имени бота ----------
  async function say(bot, toUser, text, buttons) {
    text = str(text, 2000);
    if (!text) return;
    const createdAt = now();
    const btns = cleanButtons(buttons);
    const r = await dbRun(
      `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt, botButtons) VALUES ('private',?,?,?,'text','',?,?)`,
      [bot.username, toUser, text, createdAt, btns.length ? JSON.stringify(btns) : ""]
    );
    await broadcastMessage({
      id: r.lastID, chatType: "private", sender: bot.username, receiver: toUser, text,
      mediaType: "text", mediaUrl: "", createdAt, fileName: "", fileSize: 0,
      forwardedFrom: "", replyTo: 0, replyPreview: null, botButtons: btns
    });
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function sayTyping(bot, toUser, text, buttons) {
    wsSendToUser(toUser, { type: "typing", from: bot.username, isTyping: true });
    await sleep(350 + Math.min(900, String(text || "").length * 8));
    wsSendToUser(toUser, { type: "typing", from: bot.username, isTyping: false });
    await say(bot, toUser, text, buttons);
  }

  // ---------- защита от флуда ----------
  const flood = new Map(); // "bot|user" -> { n, resetAt }
  function floodOk(key) {
    const t = now();
    const b = flood.get(key) || { n: 0, resetAt: t + 60000 };
    if (t > b.resetAt) { b.n = 0; b.resetAt = t + 60000; }
    b.n++;
    flood.set(key, b);
    return b.n <= REPLIES_PER_MIN;
  }
  const fl = setInterval(() => { const t = now(); for (const [k, v] of flood) if (t > v.resetAt) flood.delete(k); }, 5 * 60 * 1000);
  if (fl.unref) fl.unref();

  // ---------- мозг бота ----------
  async function sendFormToOwner(bot, user, rule, answers) {
    const lines = [`📩 Новая заявка · ${rule.title || rule.keywords[0] || "анкета"}`, `От: ${user.displayName || user.username} (@${user.username})`, ""];
    rule.questions.forEach((q, i) => { lines.push(`${i + 1}. ${q}`); lines.push(`→ ${answers[i] || "—"}`); });
    await say(bot, bot.owner, lines.join("\n"));
  }

  async function handle(bot, user, text) {
    const config = parseConfig(bot);
    const norm = normalize(text);

    // 1) идёт анкета?
    const sess = await dbGet(`SELECT * FROM bot_sessions WHERE bot=? AND user=?`, [bot.username, user.username]);
    if (sess && now() - sess.updatedAt > FORM_TTL_MS) {
      await dbRun(`DELETE FROM bot_sessions WHERE bot=? AND user=?`, [bot.username, user.username]);
    } else if (sess) {
      const rule = config.rules.find(r => r.id === sess.ruleId);
      if (!rule) {
        await dbRun(`DELETE FROM bot_sessions WHERE bot=? AND user=?`, [bot.username, user.username]);
      } else if (norm === "отмена" || norm === "cancel" || text === "/cancel") {
        await dbRun(`DELETE FROM bot_sessions WHERE bot=? AND user=?`, [bot.username, user.username]);
        return sayTyping(bot, user.username, "Хорошо, отменили. Напишите, когда будете готовы.", config.welcome.buttons);
      } else {
        let answers = [];
        try { answers = JSON.parse(sess.answersJson || "[]"); } catch {}
        answers[sess.step] = str(text, 500);
        const next = sess.step + 1;
        if (next < rule.questions.length) {
          await dbRun(`UPDATE bot_sessions SET step=?, answersJson=?, updatedAt=? WHERE bot=? AND user=?`,
            [next, JSON.stringify(answers), now(), bot.username, user.username]);
          return sayTyping(bot, user.username, fill(rule.questions[next], user, bot), ["Отмена"]);
        }
        await dbRun(`DELETE FROM bot_sessions WHERE bot=? AND user=?`, [bot.username, user.username]);
        await sendFormToOwner(bot, user, rule, answers);
        return sayTyping(bot, user.username, fill(rule.done || "Спасибо! Мы получили ваши ответы и скоро свяжемся.", user, bot), config.welcome.buttons);
      }
    }

    // 2) приветствие: по /start или при первом сообщении человека
    const met = await dbGet(`SELECT 1 FROM messages WHERE chatType='private' AND sender=? AND receiver=? LIMIT 1`, [bot.username, user.username]);
    const isStart = text === "/start" || norm === "start" || norm === "старт";
    if (!met || isStart) {
      await sayTyping(bot, user.username, fill(config.welcome.text || DEFAULT_CONFIG().welcome.text, user, bot), config.welcome.buttons);
      if (isStart) return;
    }

    // 3) ищем подходящее правило (сверху вниз)
    for (const rule of config.rules) {
      const hit = rule.keywords.some(k => {
        const kw = normalize(k);
        if (!kw) return false;
        return rule.match === "exact" ? norm === kw : norm.includes(kw);
      });
      if (!hit) continue;

      if (rule.type === "form") {
        await dbRun(
          `INSERT INTO bot_sessions (bot, user, ruleId, step, answersJson, updatedAt) VALUES (?,?,?,?,?,?)
           ON CONFLICT(bot, user) DO UPDATE SET ruleId=excluded.ruleId, step=0, answersJson='[]', updatedAt=excluded.updatedAt`,
          [bot.username, user.username, rule.id, 0, "[]", now()]
        );
        if (rule.reply) await sayTyping(bot, user.username, fill(rule.reply, user, bot));
        return sayTyping(bot, user.username, fill(rule.questions[0], user, bot), ["Отмена"]);
      }
      return sayTyping(bot, user.username, fill(rule.reply, user, bot), rule.buttons);
    }

    // 4) ничего не подошло
    if (!met && !isStart) return; // человек только что получил приветствие — не пугаем «не понял»
    const fb = config.fallback.text || DEFAULT_CONFIG().fallback.text;
    return sayTyping(bot, user.username, fill(fb, user, bot), config.fallback.buttons.length ? config.fallback.buttons : config.welcome.buttons);
  }

  // Вызывается сервером после каждого личного сообщения
  async function onUserMessage(msg) {
    if (!msg || msg.chatType !== "private" || !BOT_USERNAMES.has(msg.receiver)) return;
    if (msg.mediaType !== "text" || BOT_USERNAMES.has(msg.sender)) return;
    const text = String(msg.text || "");
    if (!text || text.startsWith("e2e:1:")) return;
    const bot = await getBot(msg.receiver);
    if (!bot || !bot.enabled) return;
    if (!floodOk(bot.username + "|" + msg.sender)) return;
    const user = await dbGet(`SELECT username, displayName FROM users WHERE username=?`, [msg.sender]);
    if (!user) return;
    await handle(bot, user, text);
  }

  // ---------- API конструктора (только для владельца) ----------
  async function ownBot(req, res) {
    const u = clean(req.params.username);
    const row = await getBot(u);
    if (!row || row.owner !== req.user.username) {
      res.status(404).json({ ok: false, error: "Бот не найден" });
      return null;
    }
    return row;
  }

  app.get("/api/bots", verifyAuth, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM bots WHERE owner=? ORDER BY createdAt DESC`, [req.user.username]);
    const out = [];
    for (const r of rows) {
      const s = await dbGet(`SELECT COUNT(DISTINCT sender) AS people, COUNT(*) AS msgs FROM messages WHERE chatType='private' AND receiver=?`, [r.username]);
      out.push({ ...publicBot(r, false), people: (s && s.people) || 0, messages: (s && s.msgs) || 0 });
    }
    res.json({ ok: true, bots: out, limit: MAX_BOTS_PER_USER });
  });

  app.post("/api/bots", verifyAuth, rateLimit(10, 60 * 60 * 1000), async (req, res) => {
    const owner = req.user.username;
    const username = clean(req.body.username);
    const name = str(req.body.name, 40);
    const description = str(req.body.description, 200);

    if (!/^[a-z0-9_]{2,16}_bot$/.test(username)) {
      return res.status(400).json({ ok: false, error: "Юзернейм бота должен заканчиваться на _bot (например shop_bot). Буквы a-z, цифры и _" });
    }
    if (!name) return res.status(400).json({ ok: false, error: "Напиши имя бота" });
    if (RESERVED_USERNAMES.includes(username) || await isUsernameReserved(username)) {
      return res.status(400).json({ ok: false, error: "Этот юзернейм занят" });
    }
    if (await dbGet(`SELECT 1 FROM users WHERE username=?`, [username])) {
      return res.status(400).json({ ok: false, error: "Этот юзернейм занят" });
    }
    const count = await dbGet(`SELECT COUNT(*) AS c FROM bots WHERE owner=?`, [owner]);
    if (count && count.c >= MAX_BOTS_PER_USER) {
      return res.status(400).json({ ok: false, error: `Можно создать не больше ${MAX_BOTS_PER_USER} ботов` });
    }

    const t = now();
    // пароль-заглушка: войти в аккаунт бота нельзя
    await dbRun(`INSERT INTO users (username, passwordHash, displayName, bio, createdAt) VALUES (?,?,?,?,?)`,
      [username, "!bot-account-no-login", name, description, t]);
    await dbRun(`INSERT INTO bots (username, owner, name, description, enabled, configJson, createdAt, updatedAt) VALUES (?,?,?,?,1,?,?,?)`,
      [username, owner, name, description, JSON.stringify(DEFAULT_CONFIG()), t, t]);
    BOT_USERNAMES.add(username);
    res.json({ ok: true, bot: publicBot(await getBot(username), true) });
  });

  app.get("/api/bots/:username", verifyAuth, async (req, res) => {
    const row = await ownBot(req, res);
    if (row) res.json({ ok: true, bot: publicBot(row, true) });
  });

  app.put("/api/bots/:username", verifyAuth, rateLimit(60, 60 * 1000), async (req, res) => {
    const row = await ownBot(req, res);
    if (!row) return;
    const name = str(req.body.name, 40) || row.name;
    const description = str(req.body.description, 200);
    const enabled = req.body.enabled === false ? 0 : 1;
    const config = cleanConfig(req.body.config);
    await dbRun(`UPDATE bots SET name=?, description=?, enabled=?, configJson=?, updatedAt=? WHERE username=?`,
      [name, description, enabled, JSON.stringify(config), now(), row.username]);
    await dbRun(`UPDATE users SET displayName=?, bio=? WHERE username=?`, [name, description, row.username]);
    res.json({ ok: true, bot: publicBot(await getBot(row.username), true) });
  });

  async function removeBot(username) {
    await dbRun(`DELETE FROM messages WHERE chatType='private' AND (sender=? OR receiver=?)`, [username, username]);
    await dbRun(`DELETE FROM bot_sessions WHERE bot=?`, [username]);
    await dbRun(`DELETE FROM contacts WHERE owner=? OR username=?`, [username, username]);
    await dbRun(`DELETE FROM dm_exceptions WHERE owner=? OR allowed=?`, [username, username]);
    await dbRun(`DELETE FROM blocked_users WHERE owner=? OR blocked=?`, [username, username]);
    await dbRun(`DELETE FROM bots WHERE username=?`, [username]);
    await dbRun(`DELETE FROM users WHERE username=?`, [username]);
    BOT_USERNAMES.delete(username);
  }

  app.delete("/api/bots/:username", verifyAuth, async (req, res) => {
    const row = await ownBot(req, res);
    if (!row) return;
    await removeBot(row.username);
    res.json({ ok: true });
  });

  return {
    onUserMessage,
    // когда удаляется аккаунт владельца — его боты удаляются вместе с ним
    async deleteBotsOf(owner) {
      const rows = await dbAll(`SELECT username FROM bots WHERE owner=?`, [owner]);
      for (const r of rows) await removeBot(r.username);
    }
  };
};
