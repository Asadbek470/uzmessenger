/* ================================================================
   Zumo — темы оформления (themes.js). Подключается в конце chat.html.

   Что делает:
   • выбирает тему: Авто / Тёмная / AMOLED / Светлая / Океан / Сумерки;
   • запоминает выбор на телефоне (localStorage) и в аккаунте (settings.theme),
     поэтому на другом устройстве после входа будет та же тема;
   • добавляет в Настройки → Оформление блок «Тема» + скругление сообщений,
     размер текста в чатах, отключение анимаций (эти три — только на этом устройстве);
   • даёт window.ZumoTheme, им пользуется приветственный тур (welcome.js).

   Ранний запуск (до отрисовки, чтобы не мигало) — маленький скрипт в <head> chat.html.
   ================================================================ */
(function () {
  "use strict";

  var THEMES = [
    { id: "auto" },
    { id: "dark",   bg: "#07090d", panel: "#0e1218", field: "#171c24", meta: "#0e1218" },
    { id: "amoled", bg: "#000000", panel: "#000000", field: "#1c1c1c", meta: "#000000" },
    { id: "light",  bg: "#eef1f6", panel: "#ffffff", field: "#d9dfe8", meta: "#ffffff" },
    { id: "ocean",  bg: "#05121c", panel: "#0a1f2f", field: "#12304a", meta: "#0a1f2f" },
    { id: "dusk",   bg: "#0e0a19", panel: "#171128", field: "#2b2048", meta: "#171128" }
  ];
  var IDS = THEMES.map(function (x) { return x.id; });

  var L = {
    ru: {
      title: "Тема оформления", auto: "Авто", dark: "Тёмная", amoled: "AMOLED", light: "Светлая", ocean: "Океан", dusk: "Сумерки",
      autoHint: "Авто: тема телефона — днём светлая, ночью тёмная.",
      bubble: "Скругление сообщений", square: "Острые", round: "Обычные", pill: "Круглые",
      font: "Размер текста в чатах", anim: "Анимации интерфейса", replay: "Показать приветствие ещё раз",
      local: "Скругление, размер текста и анимации сохраняются на этом устройстве."
    },
    en: {
      title: "Theme", auto: "Auto", dark: "Dark", amoled: "AMOLED", light: "Light", ocean: "Ocean", dusk: "Dusk",
      autoHint: "Auto follows your phone: light by day, dark at night.",
      bubble: "Message corners", square: "Sharp", round: "Normal", pill: "Round",
      font: "Chat text size", anim: "Interface animations", replay: "Show the welcome tour again",
      local: "Corners, text size and animations are saved on this device."
    },
    uz: {
      title: "Mavzu", auto: "Avto", dark: "Qorong'i", amoled: "AMOLED", light: "Yorug'", ocean: "Okean", dusk: "Shom",
      autoHint: "Avto: telefon mavzusiga mos — kunduzi yorug', kechasi qorong'i.",
      bubble: "Xabar burchaklari", square: "O'tkir", round: "Oddiy", pill: "Yumaloq",
      font: "Chatdagi matn o'lchami", anim: "Interfeys animatsiyalari", replay: "Xush kelibsiz turini qayta ko'rsatish",
      local: "Burchaklar, matn o'lchami va animatsiyalar shu qurilmada saqlanadi."
    }
  };
  function lang() {
    try { if (typeof currentLang === "string" && L[currentLang]) return currentLang; } catch (e) {}
    return "ru";
  }
  function T(k) { return (L[lang()] || L.ru)[k] || L.ru[k] || k; }

  var root = document.documentElement;
  var mq = null;
  try { mq = window.matchMedia("(prefers-color-scheme: light)"); } catch (e) {}

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function getPref() { var p = ls("zumoTheme"); return IDS.indexOf(p) >= 0 ? p : "dark"; }
  function resolve(p) { return p === "auto" ? (mq && mq.matches ? "light" : "dark") : p; }
  function byId(id) { return THEMES.filter(function (x) { return x.id === id; })[0]; }

  function paint(pref, fade) {
    var real = resolve(pref);
    if (fade) {
      root.classList.add("theme-fade");
      clearTimeout(paint._t);
      paint._t = setTimeout(function () { root.classList.remove("theme-fade"); }, 450);
    }
    root.setAttribute("data-theme", real);
    root.setAttribute("data-theme-pref", pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", (byId(real) || byId("dark")).meta);
  }

  // opts.silent — не отправлять на сервер; opts.instant — без плавного перехода
  function setTheme(pref, opts) {
    opts = opts || {};
    if (IDS.indexOf(pref) < 0) pref = "dark";
    ls("zumoTheme", pref);
    paint(pref, !opts.instant);
    if (!opts.silent) {
      try {
        if (typeof saveSettingsPatch === "function" && typeof me !== "undefined" && me) saveSettingsPatch({ theme: pref });
      } catch (e) {}
    }
    renderPickers();
  }

  if (mq) {
    var onSys = function () { if (getPref() === "auto") paint("auto", true); };
    if (mq.addEventListener) mq.addEventListener("change", onSys); else if (mq.addListener) mq.addListener(onSys);
  }

  /* ---------- дополнительные настройки (только это устройство) ---------- */
  function getBubble() { var b = ls("zumoBubble"); return b === "square" || b === "pill" ? b : "round"; }
  function getFont() { var f = ls("zumoFont"); return ["s", "m", "l", "xl"].indexOf(f) >= 0 ? f : "m"; }
  function getAnim() { return ls("zumoAnim") !== "off"; }
  function applyExtras() {
    root.setAttribute("data-bubble", getBubble());
    root.setAttribute("data-fontsize", getFont());
    root.classList.toggle("no-anim", !getAnim());
  }

  /* ---------- разметка выбора темы (используется и в настройках, и в приветствии) ---------- */
  function cardsHTML(pref) {
    return '<div class="thm-grid">' + THEMES.map(function (th) {
      var prev = th.id === "auto"
        ? '<div class="thm-prev" style="background:linear-gradient(135deg,#07090d 50%,#eef1f6 50%)"><i class="top" style="background:rgba(128,128,128,.4)"></i><i style="background:rgba(128,128,128,.5)"></i><i class="me"></i></div>'
        : '<div class="thm-prev" style="background:' + th.bg + '"><i class="top" style="background:' + th.panel + '"></i><i style="background:' + th.field + '"></i><i class="me"></i></div>';
      return '<button type="button" class="thm-card' + (pref === th.id ? " on" : "") + '" data-theme-id="' + th.id + '">' + prev + "<span>" + T(th.id) + "</span></button>";
    }).join("") + "</div>";
  }

  function seg(name, items, cur) {
    return '<div class="thm-seg" data-seg="' + name + '">' + items.map(function (it) {
      return '<button type="button" data-v="' + it[0] + '"' + (it[0] === cur ? ' class="on"' : "") + ">" + it[1] + "</button>";
    }).join("") + "</div>";
  }

  function settingsHTML() {
    var pref = getPref();
    return '<div class="thm-block">' +
      cardsHTML(pref) +
      (pref === "auto" ? '<div class="hint">' + T("autoHint") + "</div>" : "") +
      '<div class="thm-label">' + T("bubble") + "</div>" +
      seg("bubble", [["square", T("square")], ["round", T("round")], ["pill", T("pill")]], getBubble()) +
      '<div class="thm-label">' + T("font") + "</div>" +
      seg("font", [["s", "A−"], ["m", "A"], ["l", "A+"], ["xl", "A++"]], getFont()) +
      '<div class="thm-row"><span>' + T("anim") + '</span><button type="button" class="thm-switch' + (getAnim() ? " on" : "") + '" data-switch="anim" aria-label="' + T("anim") + '"></button></div>' +
      '<div class="hint">' + T("local") + "</div>" +
      '<button type="button" class="thm-btn" data-replay="1">✨ ' + T("replay") + "</button>" +
      "</div>";
  }

  function renderPickers() {
    var sec = document.getElementById("themeSection");
    if (sec) sec.innerHTML = settingsHTML();
    // карточки внутри приветствия обновляет сам welcome.js через событие
    try { document.dispatchEvent(new CustomEvent("zumo-theme-changed", { detail: { pref: getPref() } })); } catch (e) {}
  }

  function mountSettings() {
    var wp = document.getElementById("wallpaperSection");
    if (!wp || document.getElementById("themeSection")) return;
    var block = wp.closest(".settingsblock");
    if (!block || !block.parentNode) return;
    var nb = document.createElement("div");
    nb.className = "settingsblock";
    nb.innerHTML = '<div class="blocktitle" id="themeTitle"></div><div id="themeSection"></div>';
    block.parentNode.insertBefore(nb, block);
    nb.addEventListener("click", function (e) {
      var card = e.target.closest("[data-theme-id]");
      if (card) return setTheme(card.getAttribute("data-theme-id"));
      var sb = e.target.closest("[data-seg] button");
      if (sb) {
        var name = sb.parentNode.getAttribute("data-seg"), v = sb.getAttribute("data-v");
        if (name === "bubble") ls("zumoBubble", v); else ls("zumoFont", v);
        applyExtras(); return renderPickers();
      }
      var sw = e.target.closest("[data-switch]");
      if (sw) { ls("zumoAnim", getAnim() ? "off" : "on"); applyExtras(); return renderPickers(); }
      if (e.target.closest("[data-replay]")) {
        if (window.ZumoWelcome) window.ZumoWelcome.open();
      }
    });
    document.getElementById("themeTitle").textContent = T("title");
    renderPickers();
  }

  function refreshTexts() {
    var t = document.getElementById("themeTitle");
    if (t) t.textContent = T("title");
    renderPickers();
  }

  /* ---------- сервер: тема из аккаунта и смена языка ---------- */
  function hookApp() {
    var oa = window.applyTheme;
    if (typeof oa === "function" && !oa.__zt) {
      window.applyTheme = function (s) {
        var r = oa.apply(this, arguments);
        try {
          if (s && IDS.indexOf(s.theme) >= 0 && s.theme !== getPref()) setTheme(s.theme, { silent: true, instant: true });
          mountSettings();
        } catch (e) {}
        return r;
      };
      window.applyTheme.__zt = true;
    }
    var ol = window.applyLanguage;
    if (typeof ol === "function" && !ol.__zt) {
      window.applyLanguage = function () {
        var r = ol.apply(this, arguments);
        try { refreshTexts(); } catch (e) {}
        return r;
      };
      window.applyLanguage.__zt = true;
    }
    // если приложение уже успело применить настройки до подключения этого файла
    try {
      if (typeof me !== "undefined" && me && me.settings && IDS.indexOf(me.settings.theme) >= 0 && me.settings.theme !== getPref()) {
        setTheme(me.settings.theme, { silent: true, instant: true });
      }
    } catch (e) {}
  }

  applyExtras();
  paint(getPref(), false);
  hookApp();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountSettings);
  else mountSettings();

  window.ZumoTheme = {
    themes: THEMES, get: getPref, set: setTheme, cardsHTML: cardsHTML, text: T, applyExtras: applyExtras
  };
})();
