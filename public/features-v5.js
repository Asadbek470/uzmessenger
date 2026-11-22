/* ================================================================
   Zumo v5 — «Быстрый контакт» + конструктор чат-ботов (features-v5.js)
   Подключается в chat.html ПОСЛЕ app.js. Использует его общие функции:
   authHeaders, esc, toast, avatarHtml, openChat, userInfoCache, ws, currentChat, me.
   ================================================================ */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const E = (s) => (typeof esc === "function" ? esc(s) : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])));

  async function zxApi(path, method, body) {
    const opts = { method: method || "GET", headers: Object.assign({}, authHeaders()) };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(path, opts); } catch { return { ok: false, error: "Нет связи с сервером" }; }
    let d = {};
    try { d = await r.json(); } catch {}
    if (!r.ok && d.ok !== false) d.ok = false;
    return d;
  }

  function overlay(inner, onClose) {
    const ov = document.createElement("div");
    ov.className = "zx-overlay";
    ov.innerHTML = `<div class="zx-sheet">${inner}</div>`;
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    function close() { if (!ov.isConnected) return; ov.remove(); if (onClose) onClose(); }
    ov.close = close;
    return ov;
  }

  function avaBox(info, cls) {
    return `<div class="${cls || "zx-ava"}">${avatarHtml(info)}</div>`;
  }

  /* ---------- плашки-уведомления сверху ---------- */
  function banners() {
    let el = document.getElementById("zxBanners");
    if (!el) { el = document.createElement("div"); el.id = "zxBanners"; document.body.appendChild(el); }
    return el;
  }
  function banner(html, actions, ttl) {
    const b = document.createElement("div");
    b.className = "zx-banner";
    b.innerHTML = html;
    (actions || []).forEach((a) => {
      const btn = document.createElement("button");
      btn.className = "btn " + (a.primary ? "primary" : "ghost");
      btn.textContent = a.label;
      btn.onclick = async () => { b.remove(); if (a.run) await a.run(); };
      b.appendChild(btn);
    });
    banners().appendChild(b);
    if (ttl) setTimeout(() => b.remove(), ttl);
    return b;
  }

  /* ================================================================
     БЫСТРЫЙ КОНТАКТ
     ================================================================ */
  const qc = { timer: null, selected: new Set(), users: [], on: false, err: "", ov: null };

  function getPos() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => reject(e),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    });
  }

  function qcStop(sendOff) {
    clearInterval(qc.timer); qc.timer = null;
    qc.on = false; qc.users = []; qc.selected.clear(); qc.err = "";
    if (sendOff) zxApi("/api/quick/off", "POST", {});
  }

  function qcRender() {
    const body = $("#zxQcBody"), foot = $("#zxQcFoot");
    if (!body || !foot) return;

    if (!qc.on) {
      body.innerHTML = `
        <div class="zx-radar"><span></span><span></span><span></span><i class="fa-solid fa-location-dot"></i></div>
        <div class="zx-note" style="text-align:center">
          Включи — и ты увидишь людей рядом, у которых тоже есть Zumo и открыт этот экран. Они увидят тебя.<br><br>
          <b>Что видят другие:</b> только имя и фото.<br>
          <b>Координаты</b> никому не показываются и не сохраняются.<br>
          Ты виден, <b>пока открыт этот экран</b>. Закрыл — тебя уже не видно.
        </div>
        ${qc.err ? `<div class="zx-err">${qc.err}</div>` : ""}`;
      foot.innerHTML = `<button class="btn primary" id="zxQcOn"><i class="fa-solid fa-location-crosshairs"></i> Включить</button>`;
      $("#zxQcOn").onclick = qcStart;
      return;
    }

    const list = qc.users.map((u) => {
      const sel = qc.selected.has(u.username);
      const tag = u.isContact ? `<button class="btn ghost" data-open="${E(u.username)}">Открыть чат</button>`
        : u.invited ? `<span class="zx-tag">приглашение отправлено</span>` : "";
      const pick = (!u.isContact && !u.invited) ? `<input type="checkbox" data-pick="${E(u.username)}" ${sel ? "checked" : ""}>` : "";
      return `<label class="zx-person ${sel ? "sel" : ""}">
        ${pick}
        ${avaBox(u)}
        <div class="zx-meta"><div class="zx-name">${nameHtml(u)}</div><div class="zx-sub">@${E(u.username)} · ${E(u.distance ? u.distance.text : "рядом")}</div></div>
        ${tag}
      </label>`;
    }).join("");

    body.innerHTML = `
      <div class="zx-radar"><span></span><span></span><span></span><i class="fa-solid fa-location-dot"></i></div>
      <div class="zx-status">${qc.users.length ? `Рядом с тобой: ${qc.users.length}` : "Ищу людей рядом…"}</div>
      ${qc.err ? `<div class="zx-err">${qc.err}</div>` : ""}
      ${qc.users.length ? `<div class="zx-note">Отметь одного или нескольких, с кем хочешь переписываться. Им придёт приглашение.</div>` : `<div class="zx-note" style="text-align:center">Пока никого. Пусть человек рядом тоже откроет «Быстрый контакт».</div>`}
      <div class="zx-list">${list}</div>`;

    const n = qc.selected.size;
    foot.innerHTML = `
      <button class="btn ghost" id="zxQcOff">Выключить</button>
      <button class="btn primary" id="zxQcSend" ${n ? "" : "disabled"}>Написать${n ? ` (${n})` : ""}</button>`;
    $("#zxQcOff").onclick = () => { qcStop(true); qcRender(); };
    $("#zxQcSend").onclick = qcInvite;

    body.querySelectorAll("[data-pick]").forEach((cb) => {
      cb.onchange = () => {
        if (cb.checked) qc.selected.add(cb.dataset.pick); else qc.selected.delete(cb.dataset.pick);
        qcRender();
      };
    });
    body.querySelectorAll("[data-open]").forEach((b) => {
      b.onclick = (e) => { e.preventDefault(); const u = b.dataset.open; qc.ov && qc.ov.close(); openChat(u); };
    });
  }

  async function qcPing() {
    let pos;
    try {
      pos = await getPos();
    } catch (e) {
      if (e && e.code === 1) {
        qc.err = "Нет доступа к геолокации. Разреши её для этого сайта в настройках браузера и включи снова.";
        qcStop(true);
      } else {
        qc.err = "Не получается определить место. Проверь, что включён GPS.";
      }
      qcRender();
      return;
    }
    const r = await zxApi("/api/quick/ping", "POST", pos);
    if (!qc.on) return; // пока ждали ответ, человек выключил режим
    if (r.ok) {
      qc.err = "";
      qc.users = r.users || [];
      for (const u of [...qc.selected]) if (!qc.users.some((x) => x.username === u)) qc.selected.delete(u);
    } else {
      qc.err = E(r.error || "Не удалось обновить список");
    }
    qcRender();
  }

  async function qcStart() {
    qc.err = "";
    if (!navigator.geolocation) {
      qc.err = "Этот браузер не умеет определять место.";
      return qcRender();
    }
    if (!window.isSecureContext) {
      qc.err = "Определение места работает только на защищённом сайте (https).";
      return qcRender();
    }
    qc.on = true;
    qcRender();
    await qcPing();
    if (qc.on) qc.timer = setInterval(qcPing, 10000);
  }

  async function qcInvite() {
    const list = [...qc.selected];
    if (!list.length) return;
    const btn = $("#zxQcSend");
    if (btn) btn.disabled = true;
    const r = await zxApi("/api/quick/invite", "POST", { usernames: list });
    if (!r.ok) { toast(r.error || "Не получилось"); return qcRender(); }
    qc.selected.clear();
    if (r.sent.length) toast(`Приглашение отправлено: ${r.sent.length}. Ждём ответ.`);
    else toast("Приглашения уже отправлены или человек отошёл.");
    qcPing();
  }

  window.openQuickContact = function () {
    qcStop(false);
    qc.ov = overlay(`
      <div class="zx-top">
        <div class="zx-title">📍 Быстрый контакт</div>
        <button class="iconbtn" id="zxQcClose"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="zx-body" id="zxQcBody"></div>
      <div class="zx-foot" id="zxQcFoot"></div>`,
      () => { qcStop(true); qc.ov = null; });
    $("#zxQcClose").onclick = () => qc.ov && qc.ov.close();
    qcRender();
  };

  /* входящие приглашения */
  function showInvite(inv) {
    const from = inv.from || {};
    if (document.querySelector(`.zx-banner[data-inv="${inv.id}"]`)) return;
    const b = banner(
      `${avaBox(from)}<div class="zx-text"><b>${E(from.displayName || from.username)}</b> (@${E(from.username)}) рядом и хочет связаться через «Быстрый контакт»</div>`,
      [
        { label: "Принять", primary: true, run: async () => {
          const r = await zxApi(`/api/quick/invites/${inv.id}/accept`, "POST", {});
          if (r.ok) { toast("Контакт добавлен"); openChat(r.username); } else toast(r.error || "Не получилось");
        } },
        { label: "Нет", run: () => zxApi(`/api/quick/invites/${inv.id}/decline`, "POST", {}) }
      ]
    );
    b.dataset.inv = inv.id;
  }

  /* ================================================================
     КОНСТРУКТОР БОТОВ
     ================================================================ */
  const TEMPLATES = {
    hours: { label: "🕒 Часы работы", rule: { title: "Часы работы", type: "reply", match: "contains", keywordsText: "время, график, часы работы, когда работаете", reply: "Мы работаем ежедневно с 9:00 до 18:00.", buttonsText: "", questionsText: "", done: "" } },
    price: { label: "💰 Цены", rule: { title: "Цены", type: "reply", match: "contains", keywordsText: "цен, прайс, сколько стоит, стоимость", reply: "Напишите здесь ваши цены.", buttonsText: "", questionsText: "", done: "" } },
    addr: { label: "📍 Адрес", rule: { title: "Адрес", type: "reply", match: "contains", keywordsText: "адрес, где вы, как добраться, локация", reply: "Наш адрес: …", buttonsText: "", questionsText: "", done: "" } },
    form: { label: "📝 Заявка", rule: { title: "Заявка", type: "form", match: "contains", keywordsText: "заявка, заказать, записаться", reply: "Отлично, оформим заявку!", buttonsText: "", questionsText: "Как вас зовут?\nВаш номер телефона?\nЧто вы хотите заказать?", done: "Спасибо, {name}! Мы скоро свяжемся с вами." } }
  };

  let bb = { ov: null, ed: null, bots: [] };

  const joinList = (a) => (Array.isArray(a) ? a.join(", ") : "");
  const splitComma = (s) => String(s || "").split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
  const splitLines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

  function toEditable(bot) {
    const c = bot.config || {};
    return {
      username: bot.username, name: bot.name, description: bot.description || "", enabled: bot.enabled !== false,
      welcome: { text: (c.welcome || {}).text || "", buttonsText: joinList((c.welcome || {}).buttons) },
      fallback: { text: (c.fallback || {}).text || "", buttonsText: joinList((c.fallback || {}).buttons) },
      rules: (c.rules || []).map((r) => ({
        id: r.id, title: r.title || "", type: r.type, match: r.match, keywordsText: joinList(r.keywords),
        reply: r.reply || "", buttonsText: joinList(r.buttons), questionsText: (r.questions || []).join("\n"), done: r.done || ""
      }))
    };
  }

  function fromEditable(ed) {
    return {
      name: ed.name, description: ed.description, enabled: ed.enabled,
      config: {
        welcome: { text: ed.welcome.text, buttons: splitComma(ed.welcome.buttonsText) },
        fallback: { text: ed.fallback.text, buttons: splitComma(ed.fallback.buttonsText) },
        rules: ed.rules.map((r) => ({
          id: r.id, title: r.title, type: r.type, match: r.match,
          keywords: splitComma(r.keywordsText), reply: r.reply, buttons: splitComma(r.buttonsText),
          questions: splitLines(r.questionsText), done: r.done
        }))
      }
    };
  }

  function bbShell(title, bodyHtml, footHtml, backFn) {
    const sheet = bb.ov.querySelector(".zx-sheet");
    sheet.innerHTML = `
      <div class="zx-top">
        ${backFn ? `<button class="iconbtn" id="zxBack"><i class="fa-solid fa-chevron-left"></i></button>` : ""}
        <div class="zx-title">${title}</div>
        <button class="iconbtn" id="zxBbClose"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="zx-body" id="zxBbBody">${bodyHtml}</div>
      ${footHtml ? `<div class="zx-foot" id="zxBbFoot">${footHtml}</div>` : ""}`;
    $("#zxBbClose").onclick = () => bb.ov.close();
    if (backFn) $("#zxBack").onclick = backFn;
  }

  /* ----- список ботов ----- */
  async function bbList() {
    bbShell("🤖 Мои боты", `<div class="zx-note">Загрузка…</div>`, "", null);
    const r = await zxApi("/api/bots");
    if (!r.ok) { $("#zxBbBody").innerHTML = `<div class="zx-err">${E(r.error || "Не удалось загрузить")}</div>`; return; }
    bb.bots = r.bots;
    const rows = r.bots.map((b) => `
      <div class="zx-botrow ${b.enabled ? "" : "zx-off"}" data-bot="${E(b.username)}">
        <div class="zx-ico">🤖</div>
        <div class="zx-meta">
          <div class="zx-name">${E(b.name)}</div>
          <div class="zx-sub">@${E(b.username)} · людей: ${b.people} · сообщений: ${b.messages}${b.enabled ? "" : " · выключен"}</div>
        </div>
        <i class="fa-solid fa-chevron-right" style="opacity:.5"></i>
      </div>`).join("");
    bbShell("🤖 Мои боты",
      `<div class="zx-note">Здесь можно сделать своего чат-бота без программирования. Бот отвечает людям сам, пока ты занят.</div>
       ${rows || `<div class="zx-note" style="text-align:center;padding:18px 0">У тебя пока нет ботов.</div>`}`,
      `<button class="btn primary" id="zxNewBot" ${r.bots.length >= r.limit ? "disabled" : ""}>＋ Создать бота</button>`, null);
    $("#zxNewBot").onclick = bbCreate;
    bb.ov.querySelectorAll("[data-bot]").forEach((el) => { el.onclick = () => bbOpen(el.dataset.bot); });
  }

  /* ----- создание ----- */
  function bbCreate() {
    bbShell("Новый бот",
      `<div class="zx-sec">
         <label>Имя бота (его увидят люди)</label>
         <input type="text" id="zxNbName" maxlength="40" placeholder="Например: Кофейня Ашхабад">
         <label>Юзернейм (по нему бота найдут в поиске)</label>
         <div class="zx-userinput"><span>@</span><input type="text" id="zxNbUser" maxlength="16" placeholder="coffee" autocapitalize="off" autocomplete="off"><em>_bot</em></div>
         <label>Коротко: чем занимается бот</label>
         <input type="text" id="zxNbDesc" maxlength="200" placeholder="Отвечает на вопросы и принимает заявки">
         <div class="zx-note">Только латиница, цифры и _ . Юзернейм нельзя поменять потом.</div>
         <div class="zx-err hidden" id="zxNbErr"></div>
       </div>`,
      `<button class="btn primary" id="zxNbGo">Создать</button>`, bbList);
    $("#zxNbGo").onclick = async () => {
      const base = $("#zxNbUser").value.trim().toLowerCase().replace(/^@+/, "").replace(/_bot$/, "");
      const r = await zxApi("/api/bots", "POST", { name: $("#zxNbName").value, username: base + "_bot", description: $("#zxNbDesc").value });
      if (!r.ok) { const e = $("#zxNbErr"); e.textContent = r.error || "Не получилось"; e.classList.remove("hidden"); return; }
      toast("Бот создан 🎉");
      bbEdit(r.bot);
    };
  }

  async function bbOpen(username) {
    const r = await zxApi(`/api/bots/${encodeURIComponent(username)}`);
    if (!r.ok) return toast(r.error || "Не получилось открыть");
    bbEdit(r.bot);
  }

  /* ----- редактор ----- */
  function ruleHtml(r, i, total) {
    const isForm = r.type === "form";
    return `<div class="zx-rule" data-i="${i}">
      <div class="zx-rulehead">
        <div class="zx-rn">Правило ${i + 1}</div>
        <button class="zx-mini" data-act="up" ${i === 0 ? "disabled" : ""} title="Выше">↑</button>
        <button class="zx-mini" data-act="down" ${i === total - 1 ? "disabled" : ""} title="Ниже">↓</button>
        <button class="zx-mini" data-act="del" title="Удалить">🗑</button>
      </div>
      <label>Что делает правило</label>
      <select data-r="type">
        <option value="reply" ${isForm ? "" : "selected"}>Просто ответить</option>
        <option value="form" ${isForm ? "selected" : ""}>Задать вопросы по очереди (заявка)</option>
      </select>
      <label>Название (только для тебя)</label>
      <input type="text" data-r="title" maxlength="60" value="${E(r.title)}" placeholder="Например: Цены">
      <label>Если человек написал… (слова через запятую)</label>
      <input type="text" data-r="keywordsText" value="${E(r.keywordsText)}" placeholder="цен, прайс, сколько стоит">
      <label>Как искать слова</label>
      <select data-r="match">
        <option value="contains" ${r.match === "exact" ? "" : "selected"}>Слово есть в сообщении</option>
        <option value="exact" ${r.match === "exact" ? "selected" : ""}>Сообщение точно такое</option>
      </select>
      <label>${isForm ? "Вступление перед вопросами (можно пусто)" : "Бот ответит"}</label>
      <textarea data-r="reply" maxlength="1000" placeholder="Текст ответа. {name} — имя человека">${E(r.reply)}</textarea>
      ${isForm ? `
        <label>Вопросы (каждый с новой строки)</label>
        <textarea data-r="questionsText" maxlength="1600" placeholder="Как вас зовут?&#10;Ваш телефон?">${E(r.questionsText)}</textarea>
        <label>Сообщение в конце</label>
        <input type="text" data-r="done" maxlength="500" value="${E(r.done)}" placeholder="Спасибо! Мы скоро свяжемся.">
        <div class="zx-note">Ответы человека бот пришлёт тебе в личный чат.</div>
      ` : `
        <label>Кнопки под ответом (через запятую, можно пусто)</label>
        <input type="text" data-r="buttonsText" value="${E(r.buttonsText)}" placeholder="Заказать, Адрес">
      `}
    </div>`;
  }

  function bbEditorBody() {
    const ed = bb.ed;
    return `
      <div class="zx-sec">
        <h4>Основное</h4>
        <label>Имя</label>
        <input type="text" data-k="name" maxlength="40" value="${E(ed.name)}">
        <label>Описание</label>
        <input type="text" data-k="description" maxlength="200" value="${E(ed.description)}">
        <label class="zx-switch"><input type="checkbox" data-k="enabled" ${ed.enabled ? "checked" : ""}> Бот включён</label>
        <div class="zx-note">Юзернейм: <b>@${E(ed.username)}</b></div>
      </div>

      <div class="zx-sec">
        <h4>👋 Приветствие</h4>
        <div class="zx-note">Бот пишет это, когда человек открыл чат или нажал «Запустить».</div>
        <textarea data-w="text" maxlength="1000">${E(ed.welcome.text)}</textarea>
        <label>Кнопки меню (через запятую)</label>
        <input type="text" data-w="buttonsText" value="${E(ed.welcome.buttonsText)}" placeholder="Цены, Адрес, Заказать">
        <div class="zx-note">Нажатие на кнопку — как будто человек написал этот текст. Значит, нужное правило сработает.</div>
      </div>

      <div class="zx-sec">
        <h4>⚙️ Правила</h4>
        <div class="zx-note">Бот проверяет правила сверху вниз и берёт первое подходящее. Пиши корень слова: «цен» поймает «цена», «цены», «ценник».</div>
        <div class="zx-tpls">${Object.keys(TEMPLATES).map((k) => `<button class="zx-tpl" data-tpl="${k}">${TEMPLATES[k].label}</button>`).join("")}<button class="zx-tpl" data-tpl="blank">＋ Пустое</button></div>
        <div id="zxRules">${ed.rules.map((r, i) => ruleHtml(r, i, ed.rules.length)).join("")}</div>
      </div>

      <div class="zx-sec">
        <h4>🤷 Если бот не понял</h4>
        <textarea data-f="text" maxlength="1000">${E(ed.fallback.text)}</textarea>
        <label>Кнопки (через запятую, можно пусто — тогда покажет кнопки меню)</label>
        <input type="text" data-f="buttonsText" value="${E(ed.fallback.buttonsText)}">
      </div>

      <div class="zx-sec">
        <h4>Ещё</h4>
        <button class="btn ghost" id="zxTest"><i class="fa-solid fa-paper-plane"></i> Открыть чат с ботом (проверить)</button>
        <button class="btn ghost zx-btn-danger" id="zxDelBot"><i class="fa-solid fa-trash"></i> Удалить бота</button>
        <div class="zx-note">Сообщения боту не защищены сквозным шифрованием: бот должен их прочитать, чтобы ответить.</div>
      </div>`;
  }

  function bbEdit(bot) {
    bb.ed = toEditable(bot);
    bbShell(`🤖 ${E(bot.name)}`, bbEditorBody(), `<button class="btn primary" id="zxSave"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>`, bbList);
    bbWire();
  }

  function rerenderRules() {
    const box = $("#zxRules");
    if (box) box.innerHTML = bb.ed.rules.map((r, i) => ruleHtml(r, i, bb.ed.rules.length)).join("");
  }

  function bbWire() {
    const body = $("#zxBbBody");
    body.oninput = body.onchange = (e) => {
      const t = e.target, ed = bb.ed;
      const val = t.type === "checkbox" ? t.checked : t.value;
      if (t.dataset.k) ed[t.dataset.k] = val;
      else if (t.dataset.w) ed.welcome[t.dataset.w] = val;
      else if (t.dataset.f) ed.fallback[t.dataset.f] = val;
      else if (t.dataset.r) {
        const i = Number(t.closest(".zx-rule").dataset.i);
        ed.rules[i][t.dataset.r] = val;
        if (t.dataset.r === "type" && e.type === "change") rerenderRules();
      }
    };
    body.onclick = (e) => {
      const ed = bb.ed;
      const tpl = e.target.closest("[data-tpl]");
      if (tpl) {
        const k = tpl.dataset.tpl;
        const base = k === "blank"
          ? { title: "", type: "reply", match: "contains", keywordsText: "", reply: "", buttonsText: "", questionsText: "", done: "" }
          : Object.assign({}, TEMPLATES[k].rule);
        if (ed.rules.length >= 40) return toast("Максимум 40 правил");
        ed.rules.push(base);
        rerenderRules();
        const last = $("#zxRules").lastElementChild;
        if (last) last.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const act = e.target.closest("[data-act]");
      if (act) {
        const i = Number(act.closest(".zx-rule").dataset.i);
        if (act.dataset.act === "del") ed.rules.splice(i, 1);
        if (act.dataset.act === "up" && i > 0) [ed.rules[i - 1], ed.rules[i]] = [ed.rules[i], ed.rules[i - 1]];
        if (act.dataset.act === "down" && i < ed.rules.length - 1) [ed.rules[i + 1], ed.rules[i]] = [ed.rules[i], ed.rules[i + 1]];
        rerenderRules();
      }
    };
    $("#zxSave").onclick = bbSave;
    $("#zxTest").onclick = () => { const u = bb.ed.username; bb.ov.close(); openChat(u); };
    $("#zxDelBot").onclick = async () => {
      if (!confirm(`Удалить бота @${bb.ed.username}? Все его чаты тоже удалятся.`)) return;
      const r = await zxApi(`/api/bots/${encodeURIComponent(bb.ed.username)}`, "DELETE");
      if (r.ok) { toast("Бот удалён"); bbList(); } else toast(r.error || "Не получилось");
    };
  }

  async function bbSave() {
    const btn = $("#zxSave");
    if (btn) btn.disabled = true;
    const ed = bb.ed;
    // правило без слов-триггеров или без ответа сервер отбросит — предупредим заранее
    const bad = ed.rules.findIndex((r) => !splitComma(r.keywordsText).length || (r.type === "form" ? !splitLines(r.questionsText).length : !String(r.reply).trim()));
    if (bad >= 0) {
      if (btn) btn.disabled = false;
      const el = $("#zxRules").children[bad];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return toast(`Правило ${bad + 1}: заполни слова и ответ (или вопросы)`);
    }
    const r = await zxApi(`/api/bots/${encodeURIComponent(ed.username)}`, "PUT", fromEditable(ed));
    if (btn) btn.disabled = false;
    if (!r.ok) return toast(r.error || "Не удалось сохранить");
    bb.ed = toEditable(r.bot);
    toast("Сохранено ✅");
  }

  window.openBotBuilder = function () {
    bb.ov = overlay(`<div></div>`, () => { bb.ov = null; });
    bbList();
  };

  /* ================================================================
     ХУКИ В app.js
     ================================================================ */
  function chipsFor(m) {
    let btns = m.botButtons;
    if (typeof btns === "string" && btns) { try { btns = JSON.parse(btns); } catch { btns = []; } }
    return Array.isArray(btns) ? btns : [];
  }

  function sendAsMe(text) {
    if (!ws || ws.readyState !== 1) return toast("Нет связи, попробуй ещё раз");
    ws.send(JSON.stringify({ type: "text-message", receiver: currentChat, text }));
  }

  const isBotCache = new Map();
  async function isBotChat(chat) {
    if (!chat || chat === "global" || chat === "support" || String(chat).startsWith("group:")) return false;
    const c = userInfoCache.get(chat);
    if (c && typeof c.isBot === "boolean") return c.isBot;
    if (isBotCache.has(chat)) return isBotCache.get(chat);
    const r = await zxApi(`/api/users/${encodeURIComponent(chat)}`);
    const v = !!(r.ok && r.user && r.user.isBot);
    isBotCache.set(chat, v);
    return v;
  }

  window.zumoExt = {
    // события сокета; true = «я обработал, дальше не передавай»
    onWs(data) {
      if (data.type === "quick-invite") { showInvite(data.invite); return true; }
      if (data.type === "quick-accepted") {
        const by = data.by || {};
        banner(`${avaBox(by)}<div class="zx-text"><b>${E(by.displayName || by.username)}</b> принял(а) приглашение. Можно писать!</div>`,
          [{ label: "Написать", primary: true, run: () => openChat(by.username) }], 12000);
        return true;
      }
      return false;
    },
    // после отрисовки каждого сообщения: кнопки быстрых ответов под сообщением бота
    afterRender(row, m) {
      const box = row.parentElement;
      if (!box) return;
      box.querySelectorAll(".zx-botstart").forEach((e) => e.remove());
      box.querySelectorAll(".zx-chips").forEach((e) => e.remove());
      const btns = chipsFor(m);
      if (!btns.length || (me && m.sender === me.username)) return;
      const wrap = document.createElement("div");
      wrap.className = "zx-chips";
      btns.forEach((t) => {
        const b = document.createElement("button");
        b.className = "zx-chip";
        b.textContent = t;
        b.onclick = () => sendAsMe(t);
        wrap.appendChild(b);
      });
      const bubble = row.querySelector(".bubble");
      const time = bubble && bubble.querySelector(".mtime");
      if (bubble) bubble.insertBefore(wrap, time || null);
    }
  };

  // «Запустить» в пустом чате с ботом + подпись «бот» в шапке
  function wrapGlobals() {
    if (typeof openChat === "function" && !openChat.__zx) {
      const orig = openChat;
      const wrapped = async function () {
        const out = await orig.apply(this, arguments);
        try {
          const chat = currentChat;
          if (await isBotChat(chat) && currentChat === chat) {
            const box = document.getElementById("messages");
            if (box && !box.querySelector(".mrow") && !box.querySelector(".zx-botstart")) {
              const d = document.createElement("div");
              d.className = "zx-botstart";
              d.innerHTML = `<div>🤖 Это бот. Он отвечает автоматически.<br>Сообщения боту не шифруются сквозным шифрованием.</div><button class="btn primary">▶ Запустить</button>`;
              d.querySelector("button").onclick = () => { d.remove(); sendAsMe("/start"); };
              box.appendChild(d);
            }
            const sub = document.getElementById("chatSub");
            if (sub) sub.textContent = "бот · отвечает автоматически";
          }
        } catch {}
        return out;
      };
      wrapped.__zx = true;
      window.openChat = wrapped;
    }
    if (typeof updateHeader === "function" && !updateHeader.__zx) {
      const origH = updateHeader;
      const wh = function () {
        const out = origH.apply(this, arguments);
        const c = userInfoCache.get(currentChat);
        if (c && c.isBot) { const sub = document.getElementById("chatSub"); if (sub) sub.textContent = "бот · отвечает автоматически"; }
        return out;
      };
      wh.__zx = true;
      window.updateHeader = wh;
    }
  }
  wrapGlobals();

  // приглашения, пришедшие, пока приложение было закрыто
  setTimeout(async () => {
    const r = await zxApi("/api/quick/invites");
    if (r.ok) (r.invites || []).slice(0, 3).forEach(showInvite);
  }, 3000);
})();
