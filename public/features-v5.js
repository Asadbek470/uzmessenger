/* ================================================================
   Zumo v5.1 — «Люди рядом» + конструктор чат-ботов (features-v5.js)
   Подключается в chat.html ПОСЛЕ app.js. Использует его общие функции:
   authHeaders, esc, toast, avatarHtml, nameHtml, openChat, userInfoCache, ws, currentChat, me.
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
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) ov.requestClose(); });
    document.body.appendChild(ov);
    function close() { if (!ov.isConnected) return; ov.remove(); if (onClose) onClose(); }
    ov.close = close;
    ov.requestClose = close;
    return ov;
  }

  function avaBox(info, cls) {
    return `<div class="${cls || "zx-ava"}">${avatarHtml(info)}</div>`;
  }

  const GRADS = [["#ff885e", "#ff516a"], ["#ffcd6a", "#ffa85c"], ["#82b1ff", "#665fff"], ["#a0de7e", "#54cb68"], ["#53edd6", "#28c9b7"], ["#72d5fd", "#2a9ef1"], ["#e0a2f3", "#d669ed"]];
  function botAva(name, size) {
    let h = 0; for (const ch of String(name || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const g = GRADS[h % GRADS.length];
    const letter = (String(name || "?").trim()[0] || "?").toUpperCase();
    return `<div class="zx-botava ${size || ""}" style="background:linear-gradient(135deg,${g[0]},${g[1]})">${E(letter)}</div>`;
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
     ЛЮДИ РЯДОМ («Быстрый контакт»)
     ================================================================ */
  const qc = { timer: null, selected: new Set(), users: [], on: false, err: "", ov: null, last: null, acc: null, others: 0, located: false, busy: false };

  // Язык интерфейса берём из app.js (currentLang): ru / en / uz
  function LX(ru, en, uz) {
    const l = typeof currentLang !== "undefined" ? currentLang : "ru";
    return l === "en" ? en : l === "uz" ? uz : ru;
  }
  function distText(d) {
    const k = d && d.key;
    if (k === "very-close") return LX("очень близко", "very close", "juda yaqin");
    if (k === "close") return LX("рядом", "nearby", "yaqin");
    return LX("поблизости", "around", "atrofda");
  }

  function geo(opts) {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        reject, opts
      );
    });
  }
  // Сначала точный GPS; если не успел (часто в помещении) — быстрое определение по Wi-Fi/вышкам.
  async function getPos() {
    try {
      return await geo({ enableHighAccuracy: true, timeout: 10000, maximumAge: 3000 });
    } catch (e) {
      if (e && e.code === 1) throw e;
      return await geo({ enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
    }
  }

  function qcStop(sendOff) {
    clearInterval(qc.timer); qc.timer = null;
    qc.on = false; qc.users = []; qc.selected.clear(); qc.err = ""; qc.last = null; qc.acc = null; qc.others = 0; qc.located = false; qc.busy = false;
    if (sendOff) zxApi("/api/quick/off", "POST", {});
  }

  function permHelp() {
    return LX(
      `Доступ к геолокации запрещён.<br><b>Телефон:</b> Настройки → Приложения/Браузер → Разрешения → Геолокация → Разрешить.<br><b>Компьютер:</b> нажми на значок 🔒 слева от адреса сайта → Геолокация → Разрешить.<br>Потом нажми «Включить» ещё раз.`,
      `Location access is blocked.<br><b>Phone:</b> Settings → Apps/Browser → Permissions → Location → Allow.<br><b>Computer:</b> click the 🔒 icon left of the address → Location → Allow.<br>Then press “Turn on” again.`,
      `Geolokatsiyaga ruxsat berilmagan.<br><b>Telefon:</b> Sozlamalar → Ilovalar/Brauzer → Ruxsatlar → Geolokatsiya → Ruxsat berish.<br><b>Kompyuter:</b> manzil yonidagi 🔒 belgisini bosing → Geolokatsiya → Ruxsat berish.<br>So'ng «Yoqish» tugmasini yana bosing.`
    );
  }

  function qcRender() {
    const body = $("#zxQcBody"), foot = $("#zxQcFoot");
    if (!body || !foot) return;

    if (!qc.on) {
      body.innerHTML = `
        <div class="zx-hero">
          <div class="zx-radar"><span></span><span></span><span></span><i class="fa-solid fa-location-dot"></i></div>
          <div class="zx-hero-title">${LX("Найди людей рядом", "Find people nearby", "Yaqin atrofdagi odamlarni toping")}</div>
          <div class="zx-hero-text">${LX("Увидишь тех, кто тоже открыл этот экран. Они увидят тебя. Можно сразу познакомиться и начать переписку.", "You'll see people who also opened this screen, and they'll see you. You can say hi and start chatting right away.", "Ushbu ekranni ochgan odamlarni ko'rasiz, ular ham sizni ko'radi. Darhol tanishib, yozishishingiz mumkin.")}</div>
        </div>
        <div class="zx-points">
          <div><i class="fa-solid fa-user"></i><span>${LX("Другие видят только твоё <b>имя и фото</b>", "Others see only your <b>name and photo</b>", "Boshqalar faqat <b>ismingiz va rasmingizni</b> ko'radi")}</span></div>
          <div><i class="fa-solid fa-lock"></i><span>${LX("<b>Координаты</b> никому не показываются и не сохраняются", "<b>Coordinates</b> are never shown or saved", "<b>Koordinatalar</b> hech kimga ko'rsatilmaydi va saqlanmaydi")}</span></div>
          <div><i class="fa-solid fa-eye-slash"></i><span>${LX("Ты виден, <b>пока открыт этот экран</b>. Закрыл — исчез", "You're visible <b>while this screen is open</b>. Close it and you're gone", "Siz <b>shu ekran ochiq bo'lganda</b> ko'rinasiz. Yopsangiz — yo'qolasiz")}</span></div>
        </div>
        ${qc.err ? `<div class="zx-err">${qc.err}</div>` : ""}`;
      foot.innerHTML = `<button class="btn primary zx-wide" id="zxQcOn"><i class="fa-solid fa-location-crosshairs"></i> ${LX("Включить", "Turn on", "Yoqish")}</button>`;
      $("#zxQcOn").onclick = qcStart;
      return;
    }

    const list = qc.users.map((u) => {
      const sel = qc.selected.has(u.username);
      const can = !u.isContact && !u.invited;
      const right = u.isContact ? `<button class="zx-pill" data-open="${E(u.username)}">${LX("Открыть", "Open", "Ochish")}</button>`
        : u.invited ? `<span class="zx-tag">${LX("ждём ответ", "waiting", "javob kutilmoqda")}</span>`
        : `<span class="zx-check ${sel ? "on" : ""}"><i class="fa-solid fa-check"></i></span>`;
      return `<div class="zx-person ${sel ? "sel" : ""}" ${can ? `data-pick="${E(u.username)}"` : ""}>
        ${avaBox(u)}
        <div class="zx-meta"><div class="zx-name">${nameHtml(u)}</div><div class="zx-sub">${E(distText(u.distance))} · @${E(u.username)}</div></div>
        ${right}
      </div>`;
    }).join("");

    let status;
    if (!qc.located) status = `<div class="zx-spin"></div><span>${LX("Определяю твоё место…", "Finding your location…", "Joylashuvingiz aniqlanmoqda…")}</span>`;
    else status = `<i class="fa-solid fa-circle zx-live"></i><span>${LX("Ты в списке", "You're listed", "Siz ro'yxatdasiz")} · ${LX("точность", "accuracy", "aniqlik")} ±${qc.acc != null ? qc.acc : "?"} ${LX("м", "m", "m")}</span>`;

    let empty = "";
    if (qc.located && !qc.users.length) {
      empty = `<div class="zx-empty">
        <div class="zx-empty-ico"><i class="fa-solid fa-people-group"></i></div>
        <div class="zx-empty-title">${LX("Пока никого рядом", "Nobody nearby yet", "Hozircha yaqin atrofda hech kim yo'q")}</div>
        <div class="zx-empty-text">${qc.others > 0
          ? LX(`Сейчас в режиме есть ещё ${qc.others} чел., но они далеко от тебя.`, `There are ${qc.others} more people online, but they're far from you.`, `Yana ${qc.others} kishi onlayn, lekin ular sizdan uzoqda.`)
          : LX("Кроме тебя в режиме сейчас никого нет. Пусть человек рядом откроет «Люди рядом» и нажмёт «Включить».", "No one else is online right now. Ask someone nearby to open “Nearby people” and press “Turn on”.", "Hozir siz boshqa hech kim yo'q. Yaqin atrofdagi odamdan «Yaqin odamlar»ni ochib, «Yoqish»ni bosishini so'rang.")}</div>
      </div>`;
    }

    body.innerHTML = `
      <div class="zx-radarwrap"><div class="zx-radar sm"><span></span><span></span><span></span><i class="fa-solid fa-location-dot"></i></div></div>
      <div class="zx-statusbar">${status}</div>
      ${qc.err ? `<div class="zx-err">${qc.err}</div>` : ""}
      ${qc.users.length ? `<div class="zx-section">${LX("Рядом с тобой", "Near you", "Siz yonida")} · ${qc.users.length}</div><div class="zx-list">${list}</div><div class="zx-hint">${LX("Отметь тех, с кем хочешь переписываться — им придёт приглашение.", "Pick the people you want to chat with — they'll get an invite.", "Yozishmoqchi bo'lgan odamlarni belgilang — ularga taklif yuboriladi.")}</div>` : empty}`;

    const n = qc.selected.size;
    foot.innerHTML = `
      <button class="btn ghost" id="zxQcOff">${LX("Выключить", "Turn off", "O'chirish")}</button>
      <button class="btn primary" id="zxQcSend" ${n ? "" : "disabled"}>${LX("Пригласить", "Invite", "Taklif qilish")}${n ? ` (${n})` : ""}</button>`;
    $("#zxQcOff").onclick = () => { qcStop(true); qcRender(); };
    $("#zxQcSend").onclick = qcInvite;

    body.querySelectorAll("[data-pick]").forEach((row) => {
      row.onclick = () => {
        const u = row.dataset.pick;
        if (qc.selected.has(u)) qc.selected.delete(u); else qc.selected.add(u);
        qcRender();
      };
    });
    body.querySelectorAll("[data-open]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); const u = b.dataset.open; qc.ov && qc.ov.close(); openChat(u); };
    });
  }

  async function qcPing() {
    if (qc.busy || !qc.on) return;
    qc.busy = true;
    try {
      let pos = null;
      try {
        pos = await getPos();
        qc.last = { pos, at: Date.now() };
      } catch (e) {
        if (e && e.code === 1) { qc.err = permHelp(); qcStop(true); qcRender(); return; }
        // не получилось сейчас — используем недавнее место, чтобы не пропасть из списка
        if (qc.last && Date.now() - qc.last.at < 120000) pos = qc.last.pos;
        else {
          qc.err = (e && e.code === 3)
            ? LX("Не удалось поймать сигнал вовремя. Включи GPS («Точное местоположение»), подойди к окну и подожди — пробую снова.", "Couldn't get a signal in time. Turn on GPS (precise location), go near a window and wait — trying again.", "Signal o'z vaqtida ushlanmadi. GPS ni («Aniq joylashuv») yoqing, derazaga yaqinroq turing va kuting — qayta urinilmoqda.")
            : LX("Не получается определить место. Проверь, что на телефоне включена геолокация. Пробую снова…", "Can't determine your location. Check that location is on in your phone's settings. Trying again…", "Joylashuvni aniqlab bo'lmadi. Telefonda geolokatsiya yoqilganini tekshiring. Qayta urinilmoqda…");
        }
      }
      if (!qc.on) return;
      if (!pos) { qcRender(); return; }

      const r = await zxApi("/api/quick/ping", "POST", pos);
      if (!qc.on) return; // пока ждали ответ, человек выключил режим
      if (r.ok) {
        qc.err = "";
        qc.located = true;
        qc.acc = r.acc;
        qc.others = r.others || 0;
        qc.users = r.users || [];
        for (const u of [...qc.selected]) if (!qc.users.some((x) => x.username === u)) qc.selected.delete(u);
      } else {
        qc.err = r.weak
          ? LX(`Очень слабый сигнал (±${Math.round(r.acc || 0)} м). Включи GPS и выйди к окну или на улицу`, `Very weak signal (±${Math.round(r.acc || 0)} m). Turn on GPS and step near a window or outside`, `Signal juda kuchsiz (±${Math.round(r.acc || 0)} m). GPS ni yoqing va deraza yoki ko'chaga chiqing`)
          : E(r.error || LX("Не удалось обновить список", "Couldn't refresh the list", "Ro'yxatni yangilab bo'lmadi"));
      }
      qcRender();
    } finally { qc.busy = false; }
  }

  async function qcStart() {
    qc.err = "";
    if (!navigator.geolocation) { qc.err = LX("Этот браузер не умеет определять место.", "This browser can't determine location.", "Bu brauzer joylashuvni aniqlay olmaydi."); return qcRender(); }
    if (!window.isSecureContext) { qc.err = LX("Определение места работает только на защищённом сайте (https).", "Location works only on a secure site (https).", "Joylashuv faqat xavfsiz saytda (https) ishlaydi."); return qcRender(); }
    qc.on = true; qc.located = false;
    qcRender();
    qc.timer = setInterval(qcPing, 8000);
    await qcPing();
  }

  async function qcInvite() {
    const list = [...qc.selected];
    if (!list.length) return;
    const btn = $("#zxQcSend");
    if (btn) btn.disabled = true;
    const r = await zxApi("/api/quick/invite", "POST", { usernames: list });
    if (!r.ok) { toast(r.error || LX("Не получилось", "Something went wrong", "Xatolik yuz berdi")); return qcRender(); }
    qc.selected.clear();
    if (r.sent.length) toast(LX(`Приглашение отправлено: ${r.sent.length}. Ждём ответ.`, `Invite sent: ${r.sent.length}. Waiting for a reply.`, `Taklif yuborildi: ${r.sent.length}. Javob kutilmoqda.`));
    else toast(LX("Приглашения уже отправлены или человек отошёл.", "Invites already sent, or the person has moved away.", "Takliflar allaqachon yuborilgan yoki odam uzoqlashgan."));
    qcPing();
  }

  window.openQuickContact = function () {
    qcStop(false);
    qc.ov = overlay(`
      <div class="zx-top">
        <div class="zx-title">${LX("Люди рядом", "Nearby people", "Yaqin odamlar")}</div>
        <button class="zx-x" id="zxQcClose"><i class="fa-solid fa-xmark"></i></button>
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
      `${avaBox(from)}<div class="zx-text"><b>${E(from.displayName || from.username)}</b> (@${E(from.username)}) ${LX("рядом и хочет связаться", "is nearby and wants to connect", "yaqin atrofda va bog'lanmoqchi")}</div>`,
      [
        { label: LX("Принять", "Accept", "Qabul qilish"), primary: true, run: async () => {
          const r = await zxApi(`/api/quick/invites/${inv.id}/accept`, "POST", {});
          if (r.ok) { toast(LX("Контакт добавлен", "Contact added", "Kontakt qo'shildi")); openChat(r.username); } else toast(r.error || LX("Не получилось", "Something went wrong", "Xatolik yuz berdi"));
        } },
        { label: LX("Нет", "No", "Yo'q"), run: () => zxApi(`/api/quick/invites/${inv.id}/decline`, "POST", {}) }
      ]
    );
    b.dataset.inv = inv.id;
  }

  /* ================================================================
     КОНСТРУКТОР БОТОВ
     ================================================================ */
  const R = (title, kws, reply, buttons) => ({ title, type: "reply", match: "contains", keywords: kws, reply, buttons: buttons || [], questions: [], done: "" });
  const F = (title, kws, intro, questions, done) => ({ title, type: "form", match: "contains", keywords: kws, reply: intro, buttons: [], questions, done });

  const BOT_TEMPLATES = {
    blank: { icon: "✨", label: "Пустой бот", hint: "Начну с нуля", welcome: { text: "Здравствуйте, {name}! 👋 Чем могу помочь?", buttons: [] }, rules: [] },
    shop: { icon: "🛍", label: "Магазин", hint: "Каталог, цены, доставка, заказ", welcome: { text: "Здравствуйте, {name}! 👋 Добро пожаловать в «{bot}». Выберите, что вас интересует:", buttons: ["Каталог", "Цены", "Доставка", "Заказать"] }, rules: [
      R("Каталог", ["каталог", "ассортимент", "товар"], "Наш каталог: …\nНапишите, что вас интересует, и мы подскажем.", ["Цены", "Заказать"]),
      R("Цены", ["цен", "прайс", "сколько стоит", "стоимость"], "Цены: …", ["Заказать"]),
      R("Доставка", ["доставк", "курьер", "привез"], "Доставляем по городу за 1–2 дня. Стоимость: …"),
      F("Заказ", ["заказать", "заказ", "купить"], "Отлично, оформим заказ!", ["Как вас зовут?", "Ваш номер телефона?", "Что хотите заказать?", "Адрес доставки?"], "Спасибо, {name}! Мы скоро свяжемся с вами.")
    ] },
    cafe: { icon: "☕️", label: "Кафе", hint: "Меню, часы, адрес, бронь", welcome: { text: "Здравствуйте, {name}! ☕️ Это «{bot}». Чем можем помочь?", buttons: ["Меню", "Часы работы", "Адрес", "Забронировать"] }, rules: [
      R("Меню", ["меню", "блюд", "что есть"], "Наше меню: …"),
      R("Часы работы", ["часы", "график", "работаете", "время"], "Мы работаем ежедневно с 9:00 до 22:00."),
      R("Адрес", ["адрес", "где вы", "как добраться", "локация"], "Мы находимся по адресу: …"),
      F("Бронь", ["забронировать", "бронь", "столик"], "Забронируем столик!", ["Как вас зовут?", "На какое время?", "Сколько человек?", "Номер телефона?"], "Готово, {name}! Мы подтвердим бронь по телефону.")
    ] },
    service: { icon: "💼", label: "Услуги и запись", hint: "Услуги, цены, запись", welcome: { text: "Здравствуйте, {name}! 👋 Я помогу записаться и узнать об услугах.", buttons: ["Услуги", "Цены", "Записаться", "Контакты"] }, rules: [
      R("Услуги", ["услуг", "что делаете", "чем занимаетесь"], "Мы предлагаем: …"),
      R("Цены", ["цен", "прайс", "сколько стоит", "стоимость"], "Стоимость услуг: …", ["Записаться"]),
      F("Запись", ["записаться", "запись", "записать"], "С радостью запишем вас!", ["Как вас зовут?", "Какая услуга нужна?", "Удобные дата и время?", "Номер телефона?"], "Спасибо, {name}! Подтвердим запись в ближайшее время."),
      R("Контакты", ["контакт", "телефон", "связаться"], "Телефон: …\nАдрес: …")
    ] },
    support: { icon: "🛟", label: "Поддержка", hint: "Частые вопросы и обращение", welcome: { text: "Здравствуйте, {name}! 🛟 Это поддержка «{bot}». Выберите тему или опишите проблему.", buttons: ["Частые вопросы", "Связаться с оператором"] }, rules: [
      R("Частые вопросы", ["вопрос", "помощь", "как"], "Ответы на частые вопросы:\n1) …\n2) …"),
      F("Оператор", ["оператор", "связаться", "проблем"], "Передам ваше обращение оператору.", ["Как вас зовут?", "Опишите проблему", "Как с вами связаться?"], "Спасибо, {name}! Оператор ответит в ближайшее время.")
    ] }
  };

  let bb = { ov: null, ed: null, bots: [], tab: "main", snap: "", sim: null };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function toEditable(bot) {
    const c = bot.config || {};
    return {
      username: bot.username, name: bot.name, description: bot.description || "", enabled: bot.enabled !== false,
      welcome: { text: (c.welcome || {}).text || "", buttons: [...((c.welcome || {}).buttons || [])] },
      fallback: { text: (c.fallback || {}).text || "", buttons: [...((c.fallback || {}).buttons || [])] },
      rules: (c.rules || []).map((r) => ({
        id: r.id, title: r.title || "", type: r.type, match: r.match, keywords: [...(r.keywords || [])],
        reply: r.reply || "", buttons: [...(r.buttons || [])], questions: [...(r.questions || [])], done: r.done || "", open: false
      }))
    };
  }
  function fromEditable(ed) {
    return {
      name: ed.name, description: ed.description, enabled: ed.enabled,
      config: {
        welcome: { text: ed.welcome.text, buttons: ed.welcome.buttons },
        fallback: { text: ed.fallback.text, buttons: ed.fallback.buttons },
        rules: ed.rules.map((r) => ({
          id: r.id, title: r.title, type: r.type, match: r.match, keywords: r.keywords,
          reply: r.reply, buttons: r.buttons, questions: r.questions, done: r.done
        }))
      }
    };
  }
  const isDirty = () => !!bb.ed && JSON.stringify(fromEditable(bb.ed)) !== bb.snap;
  const markSnap = () => { bb.snap = JSON.stringify(fromEditable(bb.ed)); };

  function bbShell(title, bodyHtml, footHtml, backFn, extraTop) {
    const sheet = bb.ov.querySelector(".zx-sheet");
    sheet.innerHTML = `
      <div class="zx-top">
        ${backFn ? `<button class="zx-x" id="zxBack"><i class="fa-solid fa-arrow-left"></i></button>` : ""}
        <div class="zx-title">${title}</div>
        <button class="zx-x" id="zxBbClose"><i class="fa-solid fa-xmark"></i></button>
      </div>
      ${extraTop || ""}
      <div class="zx-body" id="zxBbBody">${bodyHtml}</div>
      ${footHtml ? `<div class="zx-foot" id="zxBbFoot">${footHtml}</div>` : ""}`;
    $("#zxBbClose").onclick = () => bb.ov.requestClose();
    if (backFn) $("#zxBack").onclick = backFn;
  }

  /* ----- список ботов ----- */
  async function bbList() {
    bb.ed = null;
    bbShell("Мои боты", `<div class="zx-spinwrap"><div class="zx-spin"></div></div>`, "", null);
    const r = await zxApi("/api/bots");
    if (!r.ok) { $("#zxBbBody").innerHTML = `<div class="zx-err">${E(r.error || "Не удалось загрузить")}</div>`; return; }
    bb.bots = r.bots;
    const rows = r.bots.map((b) => `
      <div class="zx-botrow ${b.enabled ? "" : "zx-off"}" data-bot="${E(b.username)}">
        ${botAva(b.name)}
        <div class="zx-meta">
          <div class="zx-name">${E(b.name)} <span class="botbadge">БОТ</span></div>
          <div class="zx-sub">@${E(b.username)}</div>
          <div class="zx-sub">${b.enabled ? "🟢 работает" : "⚪️ выключен"} · людей: ${b.people} · сообщений: ${b.messages}</div>
        </div>
        <i class="fa-solid fa-chevron-right zx-chev"></i>
      </div>`).join("");
    bbShell("Мои боты",
      `<div class="zx-intro">
         <div class="zx-intro-ico">🤖</div>
         <div><b>Свой бот без программирования</b><br>Он сам отвечает людям, принимает заявки и присылает их тебе в чат.</div>
       </div>
       ${rows ? `<div class="zx-section">Твои боты · ${r.bots.length}/${r.limit}</div><div class="zx-list">${rows}</div>` : `<div class="zx-empty"><div class="zx-empty-ico">🤖</div><div class="zx-empty-title">Пока нет ботов</div><div class="zx-empty-text">Выбери готовый шаблон — магазин, кафе, запись или поддержку — и настрой за пару минут.</div></div>`}`,
      `<button class="btn primary zx-wide" id="zxNewBot" ${r.bots.length >= r.limit ? "disabled" : ""}><i class="fa-solid fa-plus"></i> Создать бота</button>`, null);
    $("#zxNewBot").onclick = bbCreate;
    bb.ov.querySelectorAll("[data-bot]").forEach((el) => { el.onclick = () => bbOpen(el.dataset.bot); });
  }

  /* ----- создание ----- */
  function bbCreate() {
    let tpl = "shop";
    bbShell("Новый бот",
      `<div class="zx-section">1. Выбери шаблон</div>
       <div class="zx-tplgrid">${Object.keys(BOT_TEMPLATES).map((k) => `
         <button class="zx-tplcard ${k === tpl ? "on" : ""}" data-t="${k}">
           <div class="zx-tplico">${BOT_TEMPLATES[k].icon}</div>
           <div class="zx-tplname">${BOT_TEMPLATES[k].label}</div>
           <div class="zx-tplhint">${BOT_TEMPLATES[k].hint}</div>
         </button>`).join("")}</div>
       <div class="zx-section">2. Назови бота</div>
       <div class="zx-fields">
         <label>Имя (его увидят люди)</label>
         <input type="text" id="zxNbName" maxlength="40" placeholder="Например: Кофейня «Ашхабад»">
         <label>Юзернейм (по нему бота найдут в поиске)</label>
         <div class="zx-userinput"><span>@</span><input type="text" id="zxNbUser" maxlength="16" placeholder="coffee" autocapitalize="off" autocomplete="off" spellcheck="false"><em>_bot</em></div>
         <div class="zx-hint">Латиница, цифры и «_». Юзернейм потом поменять нельзя.</div>
         <label>Чем занимается бот</label>
         <input type="text" id="zxNbDesc" maxlength="200" placeholder="Отвечает на вопросы и принимает заявки">
         <div class="zx-err hidden" id="zxNbErr"></div>
       </div>`,
      `<button class="btn primary zx-wide" id="zxNbGo">Создать и настроить</button>`, bbList);

    bb.ov.querySelectorAll("[data-t]").forEach((c) => {
      c.onclick = () => { tpl = c.dataset.t; bb.ov.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === c)); };
    });
    $("#zxNbUser").oninput = (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""); };

    $("#zxNbGo").onclick = async () => {
      const err = $("#zxNbErr");
      const name = $("#zxNbName").value.trim();
      const base = $("#zxNbUser").value.trim().toLowerCase().replace(/^@+/, "").replace(/_bot$/, "");
      const showErr = (t) => { err.textContent = t; err.classList.remove("hidden"); };
      if (!name) return showErr("Введи имя бота");
      if (base.length < 3) return showErr("Юзернейм — минимум 3 символа");
      const btn = $("#zxNbGo"); btn.disabled = true;
      const r = await zxApi("/api/bots", "POST", { name, username: base + "_bot", description: $("#zxNbDesc").value });
      if (!r.ok) { btn.disabled = false; return showErr(r.error || "Не получилось"); }
      // применяем шаблон
      const t = BOT_TEMPLATES[tpl];
      const ed = toEditable(r.bot);
      if (t.welcome.text) ed.welcome = clone(t.welcome);
      ed.rules = t.rules.map((x) => Object.assign({ id: "", open: false }, clone(x)));
      const saved = await zxApi(`/api/bots/${encodeURIComponent(ed.username)}`, "PUT", fromEditable(ed));
      toast("Бот создан 🎉");
      bbEdit(saved.ok ? saved.bot : r.bot, "rules");
    };
  }

  async function bbOpen(username) {
    const r = await zxApi(`/api/bots/${encodeURIComponent(username)}`);
    if (!r.ok) return toast(r.error || "Не получилось открыть");
    bbEdit(r.bot, "main");
  }

  /* ----- редактор ----- */
  const TABS = [["main", "Основное"], ["rules", "Сценарии"], ["menu", "Меню"], ["test", "Проверка"]];

  function chipsField(path, arr, placeholder) {
    return `<div class="zx-chipsfield" data-chips="${path}">
      ${arr.map((t, i) => `<span class="zx-tagchip">${E(t)}<b data-chipdel="${i}">×</b></span>`).join("")}
      <input data-chipin type="text" placeholder="${arr.length ? "" : E(placeholder || "Добавь и нажми Enter")}" maxlength="60">
    </div>`;
  }

  function resolveArr(path) {
    const ed = bb.ed;
    if (path === "w.buttons") return ed.welcome.buttons;
    if (path === "f.buttons") return ed.fallback.buttons;
    const m = /^r:(\d+)\.(keywords|buttons)$/.exec(path);
    return m ? ed.rules[Number(m[1])][m[2]] : null;
  }

  function ruleHtml(r, i, total) {
    const isForm = r.type === "form";
    const kw = r.keywords.length ? r.keywords.join(", ") : "нет слов-триггеров";
    return `<div class="zx-rule ${r.open ? "open" : ""}" data-i="${i}">
      <div class="zx-rulehead" data-act="toggle">
        <div class="zx-rulenum">${i + 1}</div>
        <div class="zx-meta">
          <div class="zx-name">${E(r.title || (isForm ? "Анкета" : "Ответ"))} <span class="zx-kind ${isForm ? "form" : ""}">${isForm ? "анкета" : "ответ"}</span></div>
          <div class="zx-sub">${E(kw)}</div>
        </div>
        <i class="fa-solid fa-chevron-down zx-chev"></i>
      </div>
      <div class="zx-rulebody">
        <div class="zx-seg">
          <button data-settype="reply" class="${isForm ? "" : "on"}">Просто ответить</button>
          <button data-settype="form" class="${isForm ? "on" : ""}">Задать вопросы</button>
        </div>
        <label>Название (видишь только ты)</label>
        <input type="text" data-r="title" maxlength="60" value="${E(r.title)}" placeholder="Например: Цены">
        <label>Если человек написал… <span class="zx-lh">(Enter — добавить слово)</span></label>
        ${chipsField(`r:${i}.keywords`, r.keywords, "цен, прайс, сколько стоит")}
        <div class="zx-seg sm">
          <button data-setmatch="contains" class="${r.match === "exact" ? "" : "on"}">Слово есть в тексте</button>
          <button data-setmatch="exact" class="${r.match === "exact" ? "on" : ""}">Точное совпадение</button>
        </div>
        <label>${isForm ? "Вступление перед вопросами (можно пусто)" : "Бот ответит"}</label>
        <textarea data-r="reply" maxlength="1000" placeholder="Текст ответа. {name} — имя человека">${E(r.reply)}</textarea>
        ${isForm ? `
          <label>Вопросы (каждый с новой строки, до 8)</label>
          <textarea data-r="questions" maxlength="1600" placeholder="Как вас зовут?&#10;Ваш телефон?">${E(r.questions.join("\n"))}</textarea>
          <label>Сообщение в конце</label>
          <input type="text" data-r="done" maxlength="500" value="${E(r.done)}" placeholder="Спасибо, {name}! Мы скоро свяжемся.">
          <div class="zx-hint">📩 Ответы человека бот пришлёт тебе в личный чат.</div>
        ` : `
          <label>Кнопки под ответом</label>
          ${chipsField(`r:${i}.buttons`, r.buttons, "Заказать, Адрес")}
        `}
        <div class="zx-ruleacts">
          <button class="zx-pill" data-act="up" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i> Выше</button>
          <button class="zx-pill" data-act="down" ${i === total - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i> Ниже</button>
          <button class="zx-pill danger" data-act="del"><i class="fa-solid fa-trash"></i> Удалить</button>
        </div>
      </div>
    </div>`;
  }

  function tabHtml() {
    const ed = bb.ed;
    if (bb.tab === "main") return `
      <div class="zx-botcard">
        ${botAva(ed.name, "lg")}
        <div class="zx-botcard-name">${E(ed.name)} <span class="botbadge">БОТ</span></div>
        <div class="zx-botcard-user">@${E(ed.username)}</div>
        <div class="zx-botcard-acts">
          <button class="zx-pill" id="zxCopy"><i class="fa-regular fa-copy"></i> Скопировать @</button>
          <button class="zx-pill" id="zxTest"><i class="fa-solid fa-paper-plane"></i> Открыть чат</button>
        </div>
      </div>
      <div class="zx-fields">
        <label>Имя</label>
        <input type="text" data-k="name" maxlength="40" value="${E(ed.name)}">
        <label>Описание</label>
        <input type="text" data-k="description" maxlength="200" value="${E(ed.description)}">
        <label class="zx-switchrow"><span><b>Бот включён</b><small>Выключенный бот не отвечает людям</small></span><input type="checkbox" class="zx-sw" data-k="enabled" ${ed.enabled ? "checked" : ""}></label>
      </div>
      <div class="zx-hint">Сообщения боту не защищены сквозным шифрованием: бот должен их прочитать, чтобы ответить.</div>
      <button class="btn ghost zx-btn-danger zx-wide" id="zxDelBot"><i class="fa-solid fa-trash"></i> Удалить бота</button>`;

    if (bb.tab === "menu") return `
      <div class="zx-section">👋 Приветствие</div>
      <div class="zx-fields">
        <div class="zx-hint">Бот пишет это, когда человек открыл чат или нажал «Запустить». Можно использовать {name}, {bot}.</div>
        <textarea data-w="text" maxlength="1000">${E(ed.welcome.text)}</textarea>
        <label>Кнопки меню</label>
        ${chipsField("w.buttons", ed.welcome.buttons, "Цены, Адрес, Заказать")}
        <div class="zx-hint">Нажатие на кнопку — как будто человек написал этот текст, и сработает нужный сценарий.</div>
      </div>
      <div class="zx-section">🤷 Если бот не понял</div>
      <div class="zx-fields">
        <textarea data-f="text" maxlength="1000">${E(ed.fallback.text)}</textarea>
        <label>Кнопки (пусто — покажет кнопки меню)</label>
        ${chipsField("f.buttons", ed.fallback.buttons, "Можно оставить пустым")}
      </div>`;

    if (bb.tab === "rules") return `
      <div class="zx-hint top">Бот проверяет сценарии сверху вниз и берёт первый подходящий. Пиши корень слова: «цен» поймает «цена», «цены», «ценник».</div>
      <div class="zx-tpls">
        <button class="zx-pill" data-addrule="reply"><i class="fa-solid fa-plus"></i> Ответ</button>
        <button class="zx-pill" data-addrule="form"><i class="fa-solid fa-plus"></i> Анкета</button>
        <button class="zx-pill" data-addrule="hours">🕒 Часы работы</button>
        <button class="zx-pill" data-addrule="addr">📍 Адрес</button>
      </div>
      <div id="zxRules">${ed.rules.length ? ed.rules.map((r, i) => ruleHtml(r, i, ed.rules.length)).join("") : `<div class="zx-empty"><div class="zx-empty-ico">⚙️</div><div class="zx-empty-title">Сценариев пока нет</div><div class="zx-empty-text">Добавь первый — например, ответ про цены или анкету для заявок.</div></div>`}</div>`;

    // test
    return `<div class="zx-simwrap">
      <div class="zx-simhead">${botAva(ed.name, "sm")}<div><b>${E(ed.name)}</b><small>проверка — сообщения не уходят людям</small></div><button class="zx-pill" id="zxSimReset"><i class="fa-solid fa-rotate-left"></i> Заново</button></div>
      <div class="zx-simchat" id="zxSimChat"></div>
      <div class="zx-simbar"><input type="text" id="zxSimIn" placeholder="Напиши боту…" maxlength="300"><button id="zxSimSend"><i class="fa-solid fa-paper-plane"></i></button></div>
    </div>`;
  }

  function topTabs() {
    return `<div class="zx-tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${bb.tab === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  }

  function footHtml() {
    const d = isDirty();
    return `<div class="zx-dirty ${d ? "on" : ""}">${d ? "Есть несохранённые изменения" : "Всё сохранено"}</div>
            <button class="btn primary" id="zxSave" ${d ? "" : "disabled"}><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>`;
  }
  function refreshFoot() {
    const f = $("#zxBbFoot"); if (!f) return;
    f.innerHTML = footHtml();
    $("#zxSave").onclick = bbSave;
  }

  function bbEdit(bot, tab) {
    bb.ed = toEditable(bot);
    bb.tab = tab || "main";
    markSnap();
    bb.sim = null;
    bbShell(E(bot.name), tabHtml(), footHtml(), bbBack, topTabs());
    bb.ov.requestClose = () => { if (isDirty() && !confirm("Есть несохранённые изменения. Закрыть без сохранения?")) return; bb.ov.close(); };
    bbWire();
    if (bb.tab === "test") simStart();
  }

  function bbBack() {
    if (isDirty() && !confirm("Есть несохранённые изменения. Выйти без сохранения?")) return;
    bbList();
  }

  function repaint(focusPath) {
    const body = $("#zxBbBody"); if (!body) return;
    const st = body.scrollTop;
    body.innerHTML = tabHtml();
    body.scrollTop = st;
    $(".zx-tabs").querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === bb.tab));
    bbWireTab();
    if (focusPath) { const inp = body.querySelector(`[data-chips="${focusPath}"] [data-chipin]`); if (inp) inp.focus(); }
    if (bb.tab === "test") simStart(true);
    refreshFoot();
  }

  function addChip(path, input) {
    const arr = resolveArr(path);
    const v = input.value.replace(/,/g, " ").trim();
    input.value = "";
    if (!arr || !v) return false;
    const max = /buttons$/.test(path) ? 8 : 20;
    if (arr.length >= max) { toast(`Максимум ${max}`); return false; }
    if (!arr.includes(v)) arr.push(v);
    return true;
  }

  function bbWire() {
    $(".zx-tabs").onclick = (e) => {
      const b = e.target.closest("[data-tab]"); if (!b || b.dataset.tab === bb.tab) return;
      bb.tab = b.dataset.tab; repaint();
    };
    refreshFoot();
    bbWireTab();
  }

  function bbWireTab() {
    const body = $("#zxBbBody");
    if (bb.tab === "test") {
      $("#zxSimSend").onclick = simSendFromInput;
      $("#zxSimIn").onkeydown = (e) => { if (e.key === "Enter") simSendFromInput(); };
      $("#zxSimReset").onclick = () => simStart(false, true);
      return;
    }
    body.oninput = body.onchange = (e) => {
      const t = e.target, ed = bb.ed;
      if (t.matches("[data-chipin]")) return;
      const val = t.type === "checkbox" ? t.checked : t.value;
      if (t.dataset.k) ed[t.dataset.k] = val;
      else if (t.dataset.w) ed.welcome[t.dataset.w] = val;
      else if (t.dataset.f) ed.fallback[t.dataset.f] = val;
      else if (t.dataset.r) {
        const rule = ed.rules[Number(t.closest(".zx-rule").dataset.i)];
        if (t.dataset.r === "questions") rule.questions = String(val).split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8);
        else rule[t.dataset.r] = val;
        if (t.dataset.r === "title") { const nm = t.closest(".zx-rule").querySelector(".zx-name"); if (nm) nm.firstChild.textContent = (val || (rule.type === "form" ? "Анкета" : "Ответ")) + " "; }
      }
      refreshFoot();
    };
    body.onkeydown = (e) => {
      const inp = e.target.closest && e.target.closest("[data-chipin]"); if (!inp) return;
      const path = inp.parentElement.dataset.chips;
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (addChip(path, inp)) repaint(path); }
      else if (e.key === "Backspace" && !inp.value) { const arr = resolveArr(path); if (arr && arr.length) { arr.pop(); repaint(path); } }
    };
    body.onfocusout = (e) => {
      const inp = e.target.closest && e.target.closest("[data-chipin]"); if (!inp || !inp.value.trim()) return;
      const path = inp.parentElement.dataset.chips;
      if (addChip(path, inp)) repaint();
    };
    body.onclick = (e) => {
      const ed = bb.ed, t = e.target;
      const del = t.closest("[data-chipdel]");
      if (del) { const path = del.closest("[data-chips]").dataset.chips; const arr = resolveArr(path); if (arr) { arr.splice(Number(del.dataset.chipdel), 1); repaint(); } return; }
      const add = t.closest("[data-addrule]");
      if (add) {
        if (ed.rules.length >= 40) return toast("Максимум 40 сценариев");
        const k = add.dataset.addrule;
        let rule;
        if (k === "form") rule = Object.assign({ id: "", open: true }, clone(F("", [], "", [], "")));
        else if (k === "hours") rule = Object.assign({ id: "", open: true }, clone(R("Часы работы", ["время", "график", "часы работы", "когда работаете"], "Мы работаем ежедневно с 9:00 до 18:00.")));
        else if (k === "addr") rule = Object.assign({ id: "", open: true }, clone(R("Адрес", ["адрес", "где вы", "как добраться", "локация"], "Наш адрес: …")));
        else rule = Object.assign({ id: "", open: true }, clone(R("", [], "")));
        ed.rules.push(rule); repaint();
        const last = $("#zxRules").lastElementChild; if (last) last.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const ruleEl = t.closest(".zx-rule");
      if (ruleEl) {
        const i = Number(ruleEl.dataset.i), rule = ed.rules[i];
        const st = t.closest("[data-settype]"); if (st) { rule.type = st.dataset.settype; repaint(); return; }
        const sm = t.closest("[data-setmatch]"); if (sm) { rule.match = sm.dataset.setmatch; repaint(); return; }
        const act = t.closest("[data-act]");
        if (act) {
          const a = act.dataset.act;
          if (a === "toggle") { rule.open = !rule.open; ruleEl.classList.toggle("open", rule.open); return; }
          if (a === "del") { if (!confirm("Удалить этот сценарий?")) return; ed.rules.splice(i, 1); }
          if (a === "up" && i > 0) [ed.rules[i - 1], ed.rules[i]] = [ed.rules[i], ed.rules[i - 1]];
          if (a === "down" && i < ed.rules.length - 1) [ed.rules[i + 1], ed.rules[i]] = [ed.rules[i], ed.rules[i + 1]];
          repaint();
          return;
        }
      }
      if (t.closest("#zxCopy")) { try { navigator.clipboard.writeText("@" + ed.username); toast("Юзернейм скопирован"); } catch { toast("@" + ed.username); } return; }
      if (t.closest("#zxTest")) { const u = ed.username; if (isDirty() && !confirm("Есть несохранённые изменения — бот в чате ответит по старым настройкам. Всё равно открыть?")) return; bb.ov.close(); openChat(u); return; }
      if (t.closest("#zxDelBot")) {
        if (!confirm(`Удалить бота @${ed.username}? Все его чаты тоже удалятся.`)) return;
        zxApi(`/api/bots/${encodeURIComponent(ed.username)}`, "DELETE").then((r) => { if (r.ok) { toast("Бот удалён"); bb.ed = null; bbList(); } else toast(r.error || "Не получилось"); });
      }
    };
  }

  async function bbSave() {
    const btn = $("#zxSave");
    if (btn) btn.disabled = true;
    const ed = bb.ed;
    const bad = ed.rules.findIndex((r) => !r.keywords.length || (r.type === "form" ? !r.questions.length : !String(r.reply).trim()));
    if (bad >= 0) {
      ed.rules[bad].open = true;
      bb.tab = "rules"; repaint();
      const el = $("#zxRules") && $("#zxRules").children[bad];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return toast(`Сценарий ${bad + 1}: добавь слова-триггеры и ответ (или вопросы)`);
    }
    const r = await zxApi(`/api/bots/${encodeURIComponent(ed.username)}`, "PUT", fromEditable(ed));
    if (!r.ok) { refreshFoot(); return toast(r.error || "Не удалось сохранить"); }
    const keepTab = bb.tab, open = ed.rules.map((x) => x.open);
    bb.ed = toEditable(r.bot);
    bb.ed.rules.forEach((x, i) => { x.open = !!open[i]; });
    markSnap();
    toast("Сохранено ✅");
    repaint();
    bb.tab = keepTab;
  }

  /* ----- проверка бота: тот же алгоритм, что и на сервере, но по несохранённым настройкам ----- */
  const normalize = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  const fillT = (t) => String(t || "").replaceAll("{name}", "Ты").replaceAll("{username}", "@you").replaceAll("{bot}", bb.ed.name || bb.ed.username);

  function simStart(keep, reset) {
    if (!bb.sim || reset) bb.sim = { msgs: [], sess: null, met: false };
    simRender();
  }
  function simBot(text, buttons) { bb.sim.msgs.push({ from: "bot", text: fillT(text), buttons: buttons || [] }); }
  function simNote(text) { bb.sim.msgs.push({ from: "note", text }); }

  function simHandle(text) {
    const s = bb.sim, ed = bb.ed, norm = normalize(text);
    if (s.sess) {
      const rule = ed.rules[s.sess.ri];
      if (!rule) s.sess = null;
      else if (norm === "отмена" || norm === "cancel") { s.sess = null; return simBot("Хорошо, отменили. Напишите, когда будете готовы.", ed.welcome.buttons); }
      else {
        s.sess.answers.push(text);
        const next = s.sess.step + 1;
        if (next < rule.questions.length) { s.sess.step = next; return simBot(rule.questions[next], ["Отмена"]); }
        s.sess = null;
        simNote("📩 Тебе в личный чат пришла бы заявка с этими ответами");
        return simBot(rule.done || "Спасибо! Мы получили ваши ответы и скоро свяжемся.", ed.welcome.buttons);
      }
    }
    const isStart = text === "/start" || norm === "start" || norm === "старт";
    const wasMet = s.met; s.met = true;
    if (!wasMet || isStart) {
      simBot(ed.welcome.text || "Здравствуйте, {name}! 👋 Чем могу помочь?", ed.welcome.buttons);
      if (isStart) return;
    }
    for (let ri = 0; ri < ed.rules.length; ri++) {
      const rule = ed.rules[ri];
      const hit = rule.keywords.some((k) => { const kw = normalize(k); return kw && (rule.match === "exact" ? norm === kw : norm.includes(kw)); });
      if (!hit) continue;
      if (rule.type === "form") {
        if (!rule.questions.length) continue;
        s.sess = { ri, step: 0, answers: [] };
        if (rule.reply) simBot(rule.reply);
        return simBot(rule.questions[0], ["Отмена"]);
      }
      if (!rule.reply) continue;
      return simBot(rule.reply, rule.buttons);
    }
    if (!wasMet && !isStart) return;
    simBot(ed.fallback.text || "Я пока не понял вопрос. Выберите вариант из меню или напишите по-другому.", ed.fallback.buttons.length ? ed.fallback.buttons : ed.welcome.buttons);
  }

  function simSend(text) {
    text = String(text || "").trim(); if (!text) return;
    bb.sim.msgs.push({ from: "me", text });
    simHandle(text);
    simRender();
  }
  function simSendFromInput() { const i = $("#zxSimIn"); const v = i.value; i.value = ""; simSend(v); i.focus(); }

  function simRender() {
    const box = $("#zxSimChat"); if (!box) return;
    if (!bb.sim.msgs.length) {
      box.innerHTML = `<div class="zx-botstart sim"><div>🤖 Так выглядит чат с твоим ботом.<br>Нажми «Запустить» или напиши любое слово.</div><button class="btn primary" id="zxSimStart">▶ Запустить</button></div>`;
      $("#zxSimStart").onclick = () => simSend("/start");
      return;
    }
    const last = bb.sim.msgs.length - 1;
    box.innerHTML = bb.sim.msgs.map((m, i) => {
      if (m.from === "note") return `<div class="zx-simnote">${E(m.text)}</div>`;
      const chips = (m.from === "bot" && i === last && m.buttons.length) ? `<div class="zx-chips">${m.buttons.map((b) => `<button class="zx-chip" data-simchip="${E(b)}">${E(b)}</button>`).join("")}</div>` : "";
      return `<div class="zx-simrow ${m.from}"><div class="zx-simbubble">${E(m.text).replace(/\n/g, "<br>")}${chips}</div></div>`;
    }).join("");
    box.querySelectorAll("[data-simchip]").forEach((b) => { b.onclick = () => simSend(b.dataset.simchip); });
    box.scrollTop = box.scrollHeight;
  }

  window.openBotBuilder = function () {
    bb.ov = overlay(`<div></div>`, () => { bb.ov = null; bb.ed = null; });
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
        banner(`${avaBox(by)}<div class="zx-text"><b>${E(by.displayName || by.username)}</b> ${LX("принял(а) приглашение. Можно писать!", "accepted your invite. You can chat now!", "taklifni qabul qildi. Endi yozishishingiz mumkin!")}</div>`,
          [{ label: LX("Написать", "Message", "Yozish"), primary: true, run: () => openChat(by.username) }], 12000);
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

  /* ================================================================
     КРУГЛАЯ КНОПКА В ПРАВОМ НИЖНЕМ УГЛУ → МЕНЮ ДЕЙСТВИЙ
     Создать бота · Создать группу · Создать канал · Люди рядом
     ================================================================ */
  function openBotCreate() {
    bb.ov = overlay(`<div></div>`, () => { bb.ov = null; bb.ed = null; });
    bbCreate();
  }

  function fabItems() {
    return [
      { id: "bot", icon: "fa-robot", label: t("fab.bot"), run: openBotCreate },
      { id: "group", icon: "fa-users", label: t("fab.group"), run: () => openCreateGroupModal(false) },
      { id: "channel", icon: "fa-bullhorn", label: t("fab.channel"), run: () => openCreateGroupModal(true) },
      { id: "nearby", icon: "fa-location-dot", label: t("fab.nearby"), run: () => window.openQuickContact() }
    ];
  }

  window.zxAction = function (id) {
    const it = fabItems().find((x) => x.id === id);
    if (it) it.run();
  };

  let fab = null;
  function renderFabMenu() {
    const menu = fab.querySelector(".zx-fabmenu");
    menu.innerHTML = fabItems().map((it) =>
      `<button type="button" data-fab="${it.id}"><i class="fa-solid ${it.icon}"></i><span>${E(it.label)}</span></button>`
    ).join("");
    menu.querySelectorAll("[data-fab]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); fab.classList.remove("open"); window.zxAction(b.dataset.fab); };
    });
  }

  // кнопка видна только на списке чатов и не поверх открытого окна
  function syncFab() {
    if (!fab) return;
    const cs = document.getElementById("screenChats");
    const ch = document.getElementById("screenChat");
    const show = !!cs && !cs.classList.contains("hidden") && (!ch || ch.classList.contains("hidden"))
      && !document.querySelector(".zx-overlay");
    fab.classList.toggle("hidden", !show);
    if (!show) fab.classList.remove("open");
  }

  function buildFab() {
    fab = document.createElement("div");
    fab.className = "zx-fabwrap hidden";
    fab.innerHTML = `<div class="zx-fabmenu"></div><button type="button" class="zx-fab" id="zxFab" aria-label="Создать"><i class="fa-solid fa-pen"></i></button>`;
    document.body.appendChild(fab);
    fab.querySelector("#zxFab").onclick = (e) => {
      e.stopPropagation();
      if (!fab.classList.contains("open")) renderFabMenu();
      fab.classList.toggle("open");
    };
    document.addEventListener("click", (e) => { if (!fab.contains(e.target)) fab.classList.remove("open"); });

    const obs = new MutationObserver(syncFab);
    obs.observe(document.body, { childList: true });
    ["screenChats", "screenChat"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    });
    syncFab();
  }
  buildFab();

  // приглашения, пришедшие, пока приложение было закрыто
  setTimeout(async () => {
    const r = await zxApi("/api/quick/invites");
    if (r.ok) (r.invites || []).slice(0, 3).forEach(showInvite);
  }, 3000);
})();
