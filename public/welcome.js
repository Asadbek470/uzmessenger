/* ================================================================
   Zumo — приветственный тур (welcome.js). Подключается в конце chat.html.

   Когда показывается:
   • один раз для нового аккаунта на устройстве, сразу после заставки;
   • аккаунты, зарегистрированные больше 3 дней назад, тур сам не открывает
     (чтобы не навязываться старым пользователям) — им он доступен
     кнопкой в Настройки → Оформление → «Показать приветствие ещё раз».

   Управление: кнопка «Далее», свайп влево/вправо, стрелки на клавиатуре, точки внизу.
   «Пропустить» закрывает тур сразу. На последнем слайде можно выбрать тему и цвет.
   ================================================================ */
(function () {
  "use strict";

  var L = {
    ru: {
      skip: "Пропустить", next: "Далее", start: "Начать", of: " из ",
      hello: "Добро пожаловать в <b>мессенджер будущего</b>", helloName: "Привет, <b>{n}</b>!<br>Добро пожаловать в мессенджер будущего",
      s1p: "Zumo — быстрый, умный и защищённый. Давайте за полминуты покажем, что здесь есть.",
      s2t: "Чаты, группы и <b>каналы</b>", s2p: "Личные переписки, группы и каналы в одном месте. Папки над списком, избранное, реакции на сообщения и счётчики непрочитанных.",
      s3t: "Звонки, голосовые и <b>кружки</b>", s3p: "Аудио- и видеозвонки, голосовые сообщения и видеокружки — всё одним касанием.",
      s4t: "Истории и <b>люди рядом</b>", s4p: "Публикуйте сторис и посты. «Быстрый контакт» находит людей рядом по GPS, координаты никому не показываются.",
      s5t: "Боты и <b>защита</b>", s5p: "Создавайте своих ботов в конструкторе или через @botfather. Личные чаты защищены сквозным шифрованием, можно включить код-пароль и 2FA.",
      s6t: "Сделайте Zumo <b>своим</b>", s6p: "Выберите тему и цвет. Поменять их можно в любой момент: Настройки → Оформление.",
      accent: "Цвет акцента"
    },
    en: {
      skip: "Skip", next: "Next", start: "Get started", of: " of ",
      hello: "Welcome to the <b>messenger of the future</b>", helloName: "Hi, <b>{n}</b>!<br>Welcome to the messenger of the future",
      s1p: "A fast, friendly and secure messenger. Here is a 30-second look at what you can do.",
      s2t: "Chats, groups and <b>channels</b>", s2p: "Private chats, groups and channels in one place. Folders above the list, favorites, message reactions and unread counters.",
      s3t: "Calls, voice and <b>video notes</b>", s3p: "Audio and video calls, voice messages and round video notes — all one tap away.",
      s4t: "Stories and <b>people nearby</b>", s4p: "Share stories and posts. Quick Contact finds people around you by GPS; your coordinates are never shown to anyone.",
      s5t: "Bots and <b>protection</b>", s5p: "Build your own bots in the constructor or via @botfather. Private chats use end-to-end encryption; you can add a passcode and 2FA.",
      s6t: "Make Zumo <b>yours</b>", s6p: "Pick a theme and a color. You can change them any time in Settings → Appearance.",
      accent: "Accent color"
    },
    uz: {
      skip: "O'tkazib yuborish", next: "Keyingi", start: "Boshlash", of: " / ",
      hello: "<b>Kelajak messenjeri</b>ga xush kelibsiz", helloName: "Salom, <b>{n}</b>!<br>Kelajak messenjeriga xush kelibsiz",
      s1p: "Tez, qulay va xavfsiz messenjer. 30 soniyada imkoniyatlar bilan tanishib chiqamiz.",
      s2t: "Chatlar, guruhlar va <b>kanallar</b>", s2p: "Shaxsiy yozishmalar, guruhlar va kanallar bir joyda. Papkalar, tanlanganlar, reaksiyalar va o'qilmagan hisoblagichlari.",
      s3t: "Qo'ng'iroqlar, ovozli xabarlar va <b>doiralar</b>", s3p: "Audio va video qo'ng'iroqlar, ovozli xabarlar va video-doiralar — bir bosishda.",
      s4t: "Hikoyalar va <b>yaqin atrofdagilar</b>", s4p: "Hikoyalar va postlar joylang. «Tezkor kontakt» yaqin atrofdagi odamlarni GPS orqali topadi, koordinatalar hech kimga ko'rsatilmaydi.",
      s5t: "Botlar va <b>himoya</b>", s5p: "Konstruktor yoki @botfather orqali o'z botingizni yarating. Shaxsiy chatlar uchdan-uchga shifrlangan, kod-parol va 2FA yoqish mumkin.",
      s6t: "Zumo'ni <b>o'zingizga</b> moslang", s6p: "Mavzu va rangni tanlang. Istalgan vaqtda o'zgartirish mumkin: Sozlamalar → Ko'rinish.",
      accent: "Urg'u rangi"
    }
  };
  function lang() { try { if (typeof currentLang === "string" && L[currentLang]) return currentLang; } catch (e) {} return "ru"; }
  function T(k) { return (L[lang()] || L.ru)[k] || L.ru[k] || k; }

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function who() { try { return typeof me !== "undefined" && me ? me : null; } catch (e) { return null; } }
  function flagKey(u) { return "zumoWelcome:v1:" + u; }
  function markSeen() {
    var m = who(); if (m) ls(flagKey(m.username), "1");
    ls("zumoWelcomeAny", "1");
  }

  var el = null, idx = 0, count = 6, replay = false, busy = false;

  /* ---------- сцены ---------- */
  var SCENES = [
    // 1. приветствие
    '<div class="s-logo"><span class="s-ring"></span><span class="s-ring"></span><span class="s-ring"></span>' +
      '<img src="/icon-192.png?v=5" alt="Zumo"><span class="s-chip c1">💬</span><span class="s-chip c2">💙</span><span class="s-chip c3">✨</span><span class="s-chip c4">👋</span></div>',
    // 2. чаты
    '<div class="s-chats"><div class="s-folders"><span>Все</span><span>Группы</span><span>Каналы</span></div>' +
      row("A", "#3a86ff", "2", "12:40", true) + row("M", "#ff8a3d", "5", "11:02", false) + row("K", "#a06bff", "", "Вчера", true) + "</div>",
    // 3. звонки
    '<div class="s-call"><div class="s-phone"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg></div>' +
      '<div class="s-side"><div class="s-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
      '<div class="s-circle">🙂<svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="34"/></svg></div></div></div>',
    // 4. истории и люди рядом
    '<div class="s-col"><div class="s-story"><i></i><i></i><i></i><i></i></div><div class="s-radar"><span class="r r1"></span><span class="r r2"></span><span class="r r3"></span><span class="s-sweep"></span>' +
      '<span class="s-me"></span><span class="s-peer p1">A</span><span class="s-peer p2">D</span><span class="s-peer p3">S</span></div></div>',
    // 5. боты и защита
    '<div class="s-shield"><span class="s-orbit"><span class="s-bot">🤖</span></span>' +
      '<svg viewBox="0 0 100 116"><path class="sh" d="M50 6 12 20v30c0 25 16 46 38 60 22-14 38-35 38-60V20z"/><path class="ck" d="M33 58l12 12 23-26"/></svg><span class="s-lock">🔒</span></div>',
    // 6. оформление
    '<div class="s-brush">🎨</div>'
  ];
  function row(letter, color, badge, time, ticks) {
    return '<div class="s-row"><div class="s-av" style="background:' + color + '">' + letter + '</div>' +
      '<div class="s-lines"><i></i><i></i></div><div class="s-meta"><span class="s-time">' + time + "</span>" +
      (badge ? '<span class="s-badge">' + badge + "</span>" : '<span class="s-tick">✓✓</span>') + "</div></div>";
  }

  /* ---------- сборка ---------- */
  function themeExtra() {
    var accents = [];
    try { accents = ACCENT_PRESETS; } catch (e) { accents = ["#3a86ff", "#2a9df4", "#29d17d", "#ff8a3d", "#ff4d9d", "#a06bff", "#f5c542", "#00c2c7", "#ff5c5c", "#7c8cff", "#8bd450"]; }
    var cur = (document.documentElement.style.getPropertyValue("--z-accent") || "").trim().toLowerCase();
    var th = window.ZumoTheme ? window.ZumoTheme.cardsHTML(window.ZumoTheme.get()) : "";
    return '<div class="zw-extra"><div class="zw-themes" data-zw-themes>' + th + "</div>" +
      '<div class="zw-accents" aria-label="' + esc(T("accent")) + '">' + accents.map(function (c) {
        return '<button type="button" class="zw-acc' + (c.toLowerCase() === cur ? " on" : "") + '" data-acc="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>';
      }).join("") + "</div></div>";
  }

  function build() {
    var m = who();
    var name = m ? (m.displayName || m.username || "") : "";
    var titles = [
      name ? T("helloName").replace("{n}", esc(name)) : T("hello"),
      T("s2t"), T("s3t"), T("s4t"), T("s5t"), T("s6t")
    ];
    var texts = [T("s1p"), T("s2p"), T("s3p"), T("s4p"), T("s5p"), T("s6p")];

    var stars = "";
    for (var i = 0; i < 16; i++) {
      stars += '<span class="zw-star" style="left:' + Math.round(Math.random() * 100) + "%;top:" + Math.round(Math.random() * 100) +
        "%;animation-delay:" + (Math.random() * 4).toFixed(2) + "s;animation-duration:" + (3 + Math.random() * 3).toFixed(1) + 's"></span>';
    }
    var slides = "", dots = "";
    for (var k = 0; k < count; k++) {
      slides += '<section class="zw-slide' + (k === count - 1 ? " s-theme" : "") + '" data-i="' + k + '"><div class="zw-scene">' + SCENES[k] + "</div><h2>" + titles[k] + "</h2><p>" + texts[k] + "</p>" +
        (k === count - 1 ? themeExtra() : "") + "</section>";
      dots += '<button type="button" class="zw-dot" data-go="' + k + '" aria-label="' + (k + 1) + '"></button>';
    }

    var d = document.createElement("div");
    d.id = "zw"; d.className = "zw"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
    d.innerHTML =
      '<div class="zw-bg"><span class="zw-orb o1"></span><span class="zw-orb o2"></span><span class="zw-orb o3"></span>' + stars + "</div>" +
      '<div class="zw-top"><span class="zw-count"></span><button type="button" class="zw-skip" data-skip>' + T("skip") + "</button></div>" +
      '<div class="zw-viewport"><div class="zw-track">' + slides + "</div></div>" +
      '<div class="zw-foot"><div class="zw-dots">' + dots + '</div><button type="button" class="zw-next" data-next></button></div>';
    return d;
  }

  function go(i, instant) {
    if (i < 0 || i >= count) return;
    idx = i;
    var track = el.querySelector(".zw-track");
    if (instant) { track.style.transition = "none"; }
    track.style.transform = "translateX(" + (-100 * i) + "%)";
    if (instant) { void track.offsetWidth; track.style.transition = ""; }
    var slides = el.querySelectorAll(".zw-slide");
    for (var k = 0; k < slides.length; k++) slides[k].classList.toggle("active", k === i);
    var dots = el.querySelectorAll(".zw-dot");
    for (var j = 0; j < dots.length; j++) dots[j].classList.toggle("on", j === i);
    el.classList.toggle("last", i === count - 1);
    el.querySelector(".zw-count").textContent = (i + 1) + T("of") + count;
    el.querySelector("[data-next]").textContent = i === count - 1 ? T("start") : T("next");
  }

  function confetti() {
    var box = document.createElement("div"); box.className = "zw-conf";
    var cols = ["var(--z-accent)", "var(--z-accent-hi)", "#ff4d9d", "#f5c542", "#29d17d", "#a06bff"];
    var h = "";
    for (var i = 0; i < 34; i++) {
      var a = Math.random() * Math.PI - Math.PI, sp = 110 + Math.random() * 190;
      h += '<i style="background:' + cols[i % cols.length] + ";--dx:" + Math.round(Math.cos(a) * sp) + "px;--dy:" + Math.round(Math.sin(a) * sp * 1.3) +
        "px;--rot:" + Math.round(Math.random() * 720 - 360) + "deg;animation-delay:" + (Math.random() * 0.12).toFixed(2) + 's"></i>';
    }
    box.innerHTML = h; document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 1800);
  }

  function close(done) {
    if (!el || busy) return;
    busy = true;
    markSeen();
    if (done) confetti();
    var node = el;
    node.classList.remove("in"); node.classList.add("out");
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("zumo-theme-changed", onTheme);
    setTimeout(function () { node.remove(); }, 520);
    el = null; busy = false;
    if (replay) { try { if (typeof switchTab === "function") switchTab("settings"); } catch (e) {} }
  }

  function onKey(e) {
    if (!el) return;
    if (e.key === "ArrowRight") { e.preventDefault(); idx < count - 1 ? go(idx + 1) : close(true); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
    else if (e.key === "Escape") { e.preventDefault(); close(false); }
  }

  function onTheme() {
    if (!el) return;
    var box = el.querySelector("[data-zw-themes]");
    if (box && window.ZumoTheme) box.innerHTML = window.ZumoTheme.cardsHTML(window.ZumoTheme.get());
  }

  function pickAccent(color) {
    try {
      if (typeof saveSettingsPatch === "function") saveSettingsPatch({ accent: color });
      else if (typeof setAccent === "function") setAccent(color);
      else document.documentElement.style.setProperty("--z-accent", color);
    } catch (e) {}
    var all = el.querySelectorAll(".zw-acc");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i].getAttribute("data-acc") === color);
  }

  function bindSwipe(viewport) {
    var track = viewport.querySelector(".zw-track");
    var sx = 0, sy = 0, dx = 0, drag = false, locked = null, w = 1;
    function start(x, y) { sx = x; sy = y; dx = 0; drag = true; locked = null; w = viewport.clientWidth || 1; }
    function move(x, y, ev) {
      if (!drag) return;
      var mx = x - sx, my = y - sy;
      if (locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) locked = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (locked !== "x") return;
      if (ev && ev.cancelable) ev.preventDefault();
      dx = mx;
      var edge = (idx === 0 && dx > 0) || (idx === count - 1 && dx < 0) ? 0.3 : 1;
      track.classList.add("drag");
      track.style.transform = "translateX(calc(" + (-100 * idx) + "% + " + (dx * edge) + "px))";
    }
    function end() {
      if (!drag) return; drag = false;
      track.classList.remove("drag");
      if (locked === "x" && Math.abs(dx) > Math.min(70, w * 0.18)) {
        if (dx < 0) { idx < count - 1 ? go(idx + 1) : go(idx); }
        else go(idx - 1);
      } else go(idx);
    }
    viewport.addEventListener("touchstart", function (e) { start(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    viewport.addEventListener("touchmove", function (e) { move(e.touches[0].clientX, e.touches[0].clientY, e); }, { passive: false });
    viewport.addEventListener("touchend", end);
    viewport.addEventListener("touchcancel", end);
    // мышь (компьютер)
    viewport.addEventListener("mousedown", function (e) { if (e.target.closest("button")) return; start(e.clientX, e.clientY); });
    window.addEventListener("mousemove", function (e) { if (drag) move(e.clientX, e.clientY, e); });
    window.addEventListener("mouseup", end);
  }

  function open(opts) {
    if (el) return;
    replay = !!(opts && opts.replay) || !(opts && opts.first);
    if (opts && opts.first) replay = false;
    idx = 0;
    el = build();
    document.body.appendChild(el);
    el.addEventListener("click", function (e) {
      var t = e.target;
      if (t.closest("[data-skip]")) return close(false);
      if (t.closest("[data-next]")) return idx < count - 1 ? go(idx + 1) : close(true);
      var dot = t.closest("[data-go]"); if (dot) return go(Number(dot.getAttribute("data-go")));
      var card = t.closest("[data-theme-id]"); if (card && window.ZumoTheme) return window.ZumoTheme.set(card.getAttribute("data-theme-id"));
      var acc = t.closest("[data-acc]"); if (acc) return pickAccent(acc.getAttribute("data-acc"));
    });
    bindSwipe(el.querySelector(".zw-viewport"));
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("zumo-theme-changed", onTheme);
    go(0, true);
    requestAnimationFrame(function () { requestAnimationFrame(function () { if (el) el.classList.add("in"); }); });
    setTimeout(function () { var b = el && el.querySelector("[data-next]"); if (b) b.focus({ preventScroll: true }); }, 700);
  }

  /* ---------- когда показывать ---------- */
  function eligible() {
    var m = who();
    if (!m || !m.username) return false;
    if (ls(flagKey(m.username))) return false;
    var t = Number(m.tosAcceptedAt) || 0;
    if (t && t < 1e12) t *= 1000;
    if (t && Date.now() - t > 3 * 864e5) { markSeen(); return false; }
    return true;
  }

  function schedule() {
    if (!document.getElementById("screenChats")) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (tries > 80) return clearInterval(timer);            // ~24 секунды — хватит на заставку и загрузку
      if (!who()) return;                                      // ещё не вошли
      var sp = document.getElementById("omSplash");
      if (sp && !sp.classList.contains("out")) return;         // ждём конец заставки
      clearInterval(timer);
      if (eligible()) setTimeout(function () { open({ first: true }); }, 450);
    }, 300);
  }

  window.ZumoWelcome = { open: function () { open({ replay: true }); }, reset: function () { var m = who(); if (m) { try { localStorage.removeItem(flagKey(m.username)); } catch (e) {} } } };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", schedule); else schedule();
})();
