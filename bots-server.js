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
    broadcastMessage, wsSendToUser, isUsernameReserved, isNameTaken,
    BOT_USERNAMES, RESERVED_USERNAMES, levelPerks
  } = ctx;
  const BF = "botfather";

  // лимит ботов задаётся уровнем аккаунта (см. LEVELS в server.js)
  const botLimitFor = async (username) => {
    const u = await dbGet(`SELECT level, verified FROM users WHERE username=?`, [username]);
    return levelPerks(u).maxBots;
  };
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
      enabled: !!row.enabled, createdAt: row.createdAt, updatedAt: row.updatedAt,
      mode: row.mode || "builder"
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
    return r.lastID;
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
    if (msg.receiver === BF) return botFatherMsg(msg, text);
    await queueUpdate(msg.receiver, msg);
    const bot = await getBot(msg.receiver);
    if (!bot || !bot.enabled || bot.mode === "api") return;
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
    res.json({ ok: true, bots: out, limit: await botLimitFor(req.user.username) });
  });

  app.post("/api/bots", verifyAuth, rateLimit(10, 60 * 60 * 1000), async (req, res) => {
    const r = await createBot(req.user.username, clean(req.body.username), str(req.body.name, 40), str(req.body.description, 200));
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true, bot: publicBot(r.bot, true), token: r.token });
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
    const mode = req.body.mode === undefined ? (row.mode || "builder") : (req.body.mode === "api" ? "api" : "builder");
    const config = cleanConfig(req.body.config);
    await dbRun(`UPDATE bots SET name=?, description=?, enabled=?, mode=?, configJson=?, updatedAt=? WHERE username=?`,
      [name, description, enabled, mode, JSON.stringify(config), now(), row.username]);
    await dbRun(`UPDATE users SET displayName=?, bio=? WHERE username=?`, [name, description, row.username]);
    res.json({ ok: true, bot: publicBot(await getBot(row.username), true) });
  });

  async function removeBot(username) {
    await dbRun(`DELETE FROM messages WHERE chatType='private' AND (sender=? OR receiver=?)`, [username, username]);
    await dbRun(`DELETE FROM bot_sessions WHERE bot=?`, [username]);
    await dbRun(`DELETE FROM bot_updates WHERE bot=?`, [username]);
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

  // ---------- создание бота (общее для веб-конструктора и BotFather) ----------
  function newToken(username) {
    const secret = crypto.randomBytes(24).toString("base64url");
    return { token: `${username}:${secret}`, hash: sha(secret) };
  }
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

  async function createBot(owner, username, name, description) {
    if (!/^[a-z0-9_]{2,16}_bot$/.test(username)) {
      return { error: "Юзернейм бота должен заканчиваться на _bot (например shop_bot). Буквы a-z, цифры и _" };
    }
    if (!name) return { error: "Напиши имя бота" };
    if (RESERVED_USERNAMES.includes(username) || await isNameTaken(username)) return { error: "Этот юзернейм занят" };

    const ownerRow = await dbGet(`SELECT username, level, verified FROM users WHERE username=?`, [owner]);
    const maxBots = levelPerks(ownerRow).maxBots;
    const count = await dbGet(`SELECT COUNT(*) AS c FROM bots WHERE owner=?`, [owner]);
    if (count && count.c >= maxBots) return { error: `Можно создать не больше ${maxBots} ботов` };

    const t = now();
    const { token, hash } = newToken(username);
    // пароль-заглушка: войти в аккаунт бота нельзя
    await dbRun(`INSERT INTO users (username, passwordHash, displayName, bio, createdAt) VALUES (?,?,?,?,?)`,
      [username, "!bot-account-no-login", name, description, t]);
    await dbRun(`INSERT INTO bots (username, owner, name, description, enabled, configJson, createdAt, updatedAt, tokenHash, mode) VALUES (?,?,?,?,1,?,?,?,?,'builder')`,
      [username, owner, name, description, JSON.stringify(DEFAULT_CONFIG()), t, t, hash]);
    BOT_USERNAMES.add(username);
    return { bot: await getBot(username), token };
  }

  app.post("/api/bots/:username/token", verifyAuth, rateLimit(10, 60 * 60 * 1000), async (req, res) => {
    const row = await ownBot(req, res);
    if (!row) return;
    const { token, hash } = newToken(row.username);
    await dbRun(`UPDATE bots SET tokenHash=?, updatedAt=? WHERE username=?`, [hash, now(), row.username]);
    res.json({ ok: true, token });
  });

  // ---------- очередь апдейтов для HTTP API ----------
  const UPDATES_KEEP = 1000;
  async function queueUpdate(botName, msg) {
    const user = await dbGet(`SELECT displayName FROM users WHERE username=?`, [msg.sender]);
    const name = (user && user.displayName) || msg.sender;
    const payload = JSON.stringify({
      message: {
        message_id: msg.id || 0,
        date: Math.floor((msg.createdAt || now()) / 1000),
        text: msg.text,
        from: { id: msg.sender, is_bot: false, username: msg.sender, first_name: name },
        chat: { id: msg.sender, type: "private", username: msg.sender, first_name: name }
      }
    });
    await dbRun(`INSERT INTO bot_updates (bot, payload, createdAt) VALUES (?,?,?)`, [botName, payload, now()]);
    await dbRun(`DELETE FROM bot_updates WHERE bot=? AND id <= (SELECT MAX(id) FROM bot_updates WHERE bot=?) - ?`, [botName, botName, UPDATES_KEEP]);
  }

  // ---------- BotFather: создание ботов и токенов в чате ----------
  const BF_HELP = "Я BotFather: помогу создать бота и выдам токен для HTTP API.\n\n/newbot — создать бота\n/mybots — мои боты\n/token <юзернейм_бота> — выпустить новый токен\n/cancel — отменить текущее действие";

  async function botFatherMsg(msg, text) {
    const user = await dbGet(`SELECT username FROM users WHERE username=?`, [msg.sender]);
    if (!user) return;
    const reply = (t) => say({ username: BF }, user.username, t);
    const clearSess = () => dbRun(`DELETE FROM bot_sessions WHERE bot=? AND user=?`, [BF, user.username]);
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/@botfather$/, "");
    const arg = parts.slice(1).join(" ").trim();
    const sess = await dbGet(`SELECT * FROM bot_sessions WHERE bot=? AND user=?`, [BF, user.username]);

    if (cmd === "/cancel") { await clearSess(); return reply("Отменено."); }
    if (cmd === "/start" || cmd === "/help") return reply(BF_HELP);
    if (cmd === "/newbot") {
      await dbRun(`INSERT INTO bot_sessions (bot, user, ruleId, step, answersJson, updatedAt) VALUES (?,?,'newbot',1,'[]',?)
                   ON CONFLICT(bot, user) DO UPDATE SET ruleId='newbot', step=1, answersJson='[]', updatedAt=excluded.updatedAt`,
        [BF, user.username, now()]);
      return reply("Хорошо. Как назовём бота? Это имя увидят люди в чатах.");
    }
    if (cmd === "/mybots") {
      const rows = await dbAll(`SELECT username, name FROM bots WHERE owner=? ORDER BY createdAt DESC`, [user.username]);
      if (!rows.length) return reply("У тебя пока нет ботов. Создать: /newbot");
      return reply(rows.map(r => `• ${r.name} — @${r.username}`).join("\n"));
    }
    if (cmd === "/token") {
      const target = clean(arg);
      if (!target) return reply("Укажи юзернейм бота: /token shop_bot");
      const row = await dbGet(`SELECT * FROM bots WHERE username=? AND owner=?`, [target, user.username]);
      if (!row) return reply("Такого бота у тебя нет.");
      const { token, hash } = newToken(row.username);
      await dbRun(`UPDATE bots SET tokenHash=?, updatedAt=? WHERE username=?`, [hash, now(), row.username]);
      return reply(`Новый токен для @${row.username}:\n${token}\n\nСтарый токен больше не работает. Никому его не передавай.`);
    }
    if (sess && sess.ruleId === "newbot") {
      if (sess.step === 1) {
        const name = str(text, 40);
        if (!name) return reply("Имя не может быть пустым, попробуй ещё раз.");
        await dbRun(`UPDATE bot_sessions SET step=2, answersJson=?, updatedAt=? WHERE bot=? AND user=?`,
          [JSON.stringify([name]), now(), BF, user.username]);
        return reply("Теперь выбери юзернейм. Он должен заканчиваться на _bot, например shop_bot.");
      }
      let name = "";
      try { name = JSON.parse(sess.answersJson || "[]")[0] || ""; } catch {}
      const r = await createBot(user.username, clean(text), name, "");
      if (r.error) return reply(`${r.error}. Попробуй другой юзернейм.`);
      await clearSess();
      return reply(`Готово! Твой бот @${r.bot.username} создан.\n\nТокен для HTTP API:\n${r.token}\n\nДержи токен в секрете. Запрос выглядит так: /bot<токен>/getMe`);
    }
    return reply(BF_HELP);
  }

  // ---------- HTTP API, как у Telegram: /bot<токен>/<метод> ----------
  const TOKEN_RE = /^([a-z0-9_]{2,16}_bot):([A-Za-z0-9_-]{20,})$/;
  function secretMatches(row, secret) {
    if (!row || !row.tokenHash) return false;
    const a = Buffer.from(sha(secret)), b = Buffer.from(row.tokenHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function flattenButtons(markup) {
    let m = markup;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch { m = null; } }
    const rows = (m && (m.inline_keyboard || m.keyboard)) || [];
    const out = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const b of row) out.push(typeof b === "string" ? b : String((b && b.text) || ""));
    }
    return out.filter(Boolean);
  }
  const apiError = (res, code, description) => res.status(code).json({ ok: false, error_code: code, description });

  app.all("/bot:token/:method", rateLimit(300, 60 * 1000), async (req, res) => {
    const m = TOKEN_RE.exec(req.params.token || "");
    if (!m) return apiError(res, 401, "Unauthorized");
    const bot = await getBot(m[1]);
    if (!secretMatches(bot, m[2])) return apiError(res, 401, "Unauthorized");
    if (!bot.enabled) return apiError(res, 403, "Forbidden: bot is disabled");

    const p = { ...(req.query || {}), ...(req.body && typeof req.body === "object" ? req.body : {}) };
    const method = req.params.method;

    if (method === "getMe") {
      return res.json({ ok: true, result: { id: bot.username, is_bot: true, first_name: bot.name, username: bot.username } });
    }

    if (method === "sendMessage") {
      const chat = clean(p.chat_id);
      const text = str(p.text, 2000);
      if (!chat || !text) return apiError(res, 400, "Bad Request: chat_id and text are required");
      const wrote = await dbGet(`SELECT 1 FROM messages WHERE chatType='private' AND sender=? AND receiver=? LIMIT 1`, [chat, bot.username]);
      if (!wrote) return apiError(res, 400, "Bad Request: chat not found (пользователь ещё не писал боту)");
      const blocked = await dbGet(`SELECT 1 FROM blocked_users WHERE (owner=? AND blocked=?) OR (owner=? AND blocked=?)`, [chat, bot.username, bot.username, chat]);
      if (blocked) return apiError(res, 403, "Forbidden: bot can't send messages to this user");
      if (!floodOk(bot.username + "|api|" + chat)) return apiError(res, 429, "Too Many Requests: retry later");
      const id = await say(bot, chat, text, flattenButtons(p.reply_markup));
      return res.json({ ok: true, result: { message_id: id, chat: { id: chat, type: "private" }, text } });
    }

    if (method === "getUpdates") {
      const offset = Math.max(0, parseInt(p.offset, 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(p.limit, 10) || 100));
      const timeout = Math.min(25, Math.max(0, parseInt(p.timeout, 10) || 0));
      // offset подтверждает всё, что меньше него
      if (offset) await dbRun(`DELETE FROM bot_updates WHERE bot=? AND id<?`, [bot.username, offset]);
      const load = () => dbAll(`SELECT id, payload FROM bot_updates WHERE bot=? AND id>=? ORDER BY id ASC LIMIT ?`, [bot.username, offset, limit]);
      let rows = await load();
      const until = now() + timeout * 1000;
      while (!rows.length && now() < until) { await sleep(1000); rows = await load(); }
      return res.json({ ok: true, result: rows.map(r => ({ update_id: r.id, ...JSON.parse(r.payload) })) });
    }

    return apiError(res, 404, "Not Found: method not found");
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
