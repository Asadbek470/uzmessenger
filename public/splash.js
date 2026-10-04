/* ================================================================
   Zumo — заставка при входе.
   Подключается одной строкой в самом начале <head> (chat.html, index.html).

   Сценарий «гиперпрыжок»: звёзды разгоняются и летят навстречу → вспышка
   в центре → из неё с доворотом вылетает синяя плашка, от неё расходятся
   ударные волны, вокруг вращаются две энергетические орбиты → буква Z
   рисуется светящейся линией → сноп искр → буквы названия влетают издалека
   → полоска загрузки. Звёзды и искры — на canvas, остальное на CSS и SVG.

   Показывается при входе и не повторяется чаще, чем раз в 8 секунд
   (чтобы не мигать дважды при переходе со страницы входа в чаты).
   Нажми на заставку — она закроется сразу.
   ================================================================ */
(function () {
  try {
    var last = Number(sessionStorage.getItem("omSplashAt") || 0);
    if (Date.now() - last < 8000) return;
    sessionStorage.setItem("omSplashAt", String(Date.now()));
  } catch (e) {}

  var reduce = false;
  try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  var css = [
    "#omSplash{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;overflow:hidden;",
    "background:radial-gradient(120% 90% at 50% 45%,#122150 0%,#0b132b 55%,#060b1c 100%);",
    "font-family:Onest,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#eef3ff;",
    "transition:opacity .5s ease,transform .5s ease,filter .5s ease}",
    "#omSplash.out{opacity:0;transform:scale(1.12);filter:blur(8px);pointer-events:none}",
    "#omSplash canvas{position:absolute;inset:0;width:100%;height:100%}",

    "#omSplash .stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:26px;padding:24px}",
    "#omSplash .logowrap{position:relative;width:128px;height:128px;margin-bottom:30px;animation:omTap .45s ease 1.66s both}",
    "@keyframes omTap{0%{transform:scale(1)}35%{transform:scale(1.13)}100%{transform:scale(1)}}",

    /* вспышка в центре — звёзды «прилетели», из неё появляется значок */
    "#omSplash .nova{position:absolute;left:50%;top:50%;width:560px;height:560px;margin:-280px 0 0 -280px;border-radius:50%;",
    "background:radial-gradient(circle,#fff 0%,rgba(140,185,255,.9) 14%,rgba(58,134,255,.45) 34%,rgba(58,134,255,0) 66%);",
    "opacity:0;transform:scale(.05);animation:omNova .75s cubic-bezier(.2,.8,.3,1) .62s forwards}",
    "@keyframes omNova{0%{opacity:0;transform:scale(.05)}30%{opacity:1}100%{opacity:0;transform:scale(1.25)}}",
    /* постоянное сияние за значком */
    "#omSplash .aura{position:absolute;left:50%;top:50%;width:380px;height:380px;margin:-190px 0 0 -190px;border-radius:50%;",
    "background:radial-gradient(circle,rgba(58,134,255,.5),rgba(58,134,255,0) 66%);opacity:0;",
    "animation:omFade .6s ease .9s forwards,omBreath 2.4s ease-in-out 1.5s infinite}",
    "@keyframes omFade{to{opacity:1}}",
    "@keyframes omBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}",

    /* ударные волны */
    "#omSplash .ring{position:absolute;inset:0;border-radius:36px;border:2px solid rgba(150,195,255,.9);opacity:0;",
    "animation:omRing 1s cubic-bezier(.15,.7,.3,1) forwards}",
    "#omSplash .ring.r1{animation-delay:.8s}#omSplash .ring.r2{animation-delay:.95s}",
    "#omSplash .ring.r3{animation-delay:1.66s;border-color:#fff}#omSplash .ring.r4{animation-delay:1.8s}",
    "@keyframes omRing{0%{transform:scale(.9);opacity:.95}100%{transform:scale(2.6);opacity:0;border-width:.5px}}",

    /* две энергетические орбиты вращаются вокруг значка в разные стороны */
    "#omSplash .orbit{position:absolute;left:50%;top:50%;border-radius:50%;opacity:0;",
    "-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));",
    "mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px))}",
    "#omSplash .o1{width:204px;height:204px;margin:-102px 0 0 -102px;",
    "background:conic-gradient(from 0deg,rgba(58,134,255,0) 0 62%,#3a86ff 86%,#fff 100%);",
    "animation:omFade .4s ease .95s forwards,omSpin 1.25s linear .95s infinite}",
    "#omSplash .o2{width:232px;height:232px;margin:-116px 0 0 -116px;",
    "background:conic-gradient(from 180deg,rgba(94,156,255,0) 0 70%,rgba(94,156,255,.75) 92%,#cfe0ff 100%);",
    "animation:omFade .4s ease 1.1s forwards,omSpinR 2.1s linear 1.1s infinite}",
    "@keyframes omSpin{to{transform:rotate(360deg)}}",
    "@keyframes omSpinR{to{transform:rotate(-360deg)}}",

    /* плашка вылетает из вспышки с доворотом */
    "#omSplash .badge{position:relative;width:128px;height:128px;opacity:0;",
    "filter:drop-shadow(0 0 34px rgba(58,134,255,.85)) drop-shadow(0 18px 40px rgba(20,60,160,.6));",
    "animation:omPop .7s cubic-bezier(.18,1.5,.32,1) .78s forwards}",
    "@keyframes omPop{0%{transform:scale(0) rotate(-200deg);opacity:0}45%{opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}",
    "#omSplash .badge svg{display:block;overflow:visible}",

    /* буква Z рисуется светящейся линией */
    "#omSplash .zglow{stroke-dasharray:1;stroke-dashoffset:1;opacity:.9;animation:omDraw .6s cubic-bezier(.6,0,.25,1) 1.08s forwards,omGlowOff .7s ease 1.7s forwards}",
    "#omSplash .zline{stroke-dasharray:1;stroke-dashoffset:1;animation:omDraw .6s cubic-bezier(.6,0,.25,1) 1.08s forwards}",
    "@keyframes omDraw{to{stroke-dashoffset:0}}",
    "@keyframes omGlowOff{to{opacity:.35}}",

    /* название: буквы влетают издалека, с размытием и свечением */
    "#omSplash .word{display:flex;font-size:36px;font-weight:800;letter-spacing:.5px;line-height:1.1}",
    "#omSplash .word span{display:inline-block;opacity:0;transform:translateY(34px) scale(2.2);filter:blur(10px);",
    "text-shadow:0 0 24px rgba(94,156,255,.95);animation:omLetter .55s cubic-bezier(.2,1.2,.3,1) forwards}",
    "@keyframes omLetter{60%{filter:blur(0)}100%{opacity:1;transform:none;filter:blur(0);text-shadow:0 0 14px rgba(94,156,255,.45)}}",

    "#omSplash .tag{margin-top:-16px;font-size:14px;color:#9db0dc;opacity:0;transform:translateY(8px);letter-spacing:.2px;",
    "animation:omTagIn .5s ease 2.2s forwards}",
    "@keyframes omTagIn{to{opacity:1;transform:none}}",

    /* полоска загрузки с бегущим бликом */
    "#omSplash .bar{position:relative;width:128px;height:3px;border-radius:3px;background:rgba(160,185,255,.16);",
    "overflow:hidden;opacity:0;animation:omTagIn .4s ease 2s forwards}",
    "#omSplash .bar i{display:block;height:100%;width:100%;border-radius:3px;background:linear-gradient(90deg,#3a86ff,#9cc2ff);",
    "transform:translateX(-101%);animation:omBar 1.2s cubic-bezier(.4,0,.2,1) 2.05s forwards}",
    "@keyframes omBar{to{transform:none}}",

    "@media (prefers-reduced-motion:reduce){",
    "#omSplash *{animation:none!important}",
    "#omSplash canvas,#omSplash .nova,#omSplash .ring,#omSplash .orbit{display:none}",
    "#omSplash .aura,#omSplash .badge{opacity:1;transform:none}",
    "#omSplash .zline,#omSplash .zglow{stroke-dashoffset:0}",
    "#omSplash .word span{opacity:1;transform:none;filter:none}",
    "#omSplash .tag,#omSplash .bar{opacity:1;transform:none}",
    "#omSplash .bar i{transform:none}}"
  ].join("");

  var word = "Zumo", letters = "";
  for (var i = 0; i < word.length; i++) {
    letters += '<span style="animation-delay:' + (1.72 + i * 0.09).toFixed(2) + 's">' + word.charAt(i) + '</span>';
  }

  var Z = "M66 62 H134 L66 138 H134";
  var html =
    '<canvas></canvas>' +
    '<div class="stage">' +
      '<div class="logowrap">' +
        '<div class="aura"></div><div class="nova"></div>' +
        '<div class="orbit o2"></div><div class="orbit o1"></div>' +
        '<div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div><div class="ring r4"></div>' +
        '<div class="badge">' +
          '<svg viewBox="0 0 200 200" width="128" height="128" aria-hidden="true">' +
            '<defs>' +
              '<linearGradient id="omg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4e96ff"/><stop offset="1" stop-color="#2c74f0"/></linearGradient>' +
              '<filter id="omblur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="7"/></filter>' +
            '</defs>' +
            '<rect width="200" height="200" rx="46" fill="url(#omg)"/>' +
            '<path class="zglow" pathLength="1" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" filter="url(#omblur)" d="' + Z + '"/>' +
            '<path class="zline" pathLength="1" fill="none" stroke="#fff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" d="' + Z + '"/>' +
          '</svg>' +
        '</div>' +
      '</div>' +
      '<div class="word" aria-label="' + word + '">' + letters + '</div>' +
      '<div class="tag">Общение без номера телефона</div>' +
      '<div class="bar"><i></i></div>' +
    '</div>';

  var style = document.createElement("style");
  style.textContent = css;
  var el = document.createElement("div");
  el.id = "omSplash";
  el.innerHTML = html;
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(el);

  // ---- звёзды: «гиперпрыжок» к центру экрана, затем спокойный полёт; и искры, когда буква дорисована ----
  var raf = 0, closed = false;
  (function () {
    if (reduce) return;
    var cv = el.querySelector("canvas"), g = cv.getContext && cv.getContext("2d");
    if (!g) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2), W = 0, H = 0;
    function size() { W = el.clientWidth; H = el.clientHeight; cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); }
    size();
    var N = 150, stars = [], sparks = [], sparked = false, t0 = 0, cx = 0, cy = 0;
    function reset(s, far) { s.x = (Math.random() * 2 - 1) * 1.3; s.y = (Math.random() * 2 - 1) * 1.3; s.z = far ? 1 : Math.random() * 0.9 + 0.1; s.px = null; }
    for (var k = 0; k < N; k++) { var s = {}; reset(s, false); stars.push(s); }
    function frame(now) {
      if (closed) return;
      if (!t0) t0 = now;
      var t = now - t0;
      var lw = el.querySelector(".logowrap").getBoundingClientRect();
      cx = lw.left + lw.width / 2; cy = lw.top + lw.height / 2;
      // скорость: разгон → прыжок → плавный полёт
      var speed = t < 650 ? 0.006 + 0.05 * Math.pow(t / 650, 2) : Math.max(0.0022, 0.056 * Math.exp(-(t - 650) / 170));
      g.clearRect(0, 0, W, H);
      var f = Math.max(W, H) * 0.6;
      g.lineCap = "round";
      for (var i = 0; i < N; i++) {
        var s = stars[i];
        s.z -= speed;
        if (s.z <= 0.02) { reset(s, true); continue; }
        var x = cx + (s.x / s.z) * f, y = cy + (s.y / s.z) * f;
        if (x < -40 || x > W + 40 || y < -40 || y > H + 40) { reset(s, true); continue; }
        var a = Math.min(1, (1 - s.z) * 1.4), w = (1 - s.z) * 2.2 + 0.4;
        if (s.px !== null && speed > 0.004) {
          g.strokeStyle = "rgba(170,205,255," + a + ")"; g.lineWidth = w;
          g.beginPath(); g.moveTo(s.px, s.py); g.lineTo(x, y); g.stroke();
        } else {
          g.fillStyle = "rgba(190,215,255," + a * 0.9 + ")";
          g.beginPath(); g.arc(x, y, w * 0.6, 0, 6.283); g.fill();
        }
        s.px = x; s.py = y;
      }
      // искры
      if (!sparked && t >= 1660) {
        sparked = true;
        for (var j = 0; j < 54; j++) {
          var ang = Math.random() * 6.283, v = 2.5 + Math.random() * 7.5;
          sparks.push({ x: cx, y: cy, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1, d: 0.014 + Math.random() * 0.02, r: 1 + Math.random() * 2.2, w: Math.random() < 0.4 });
        }
      }
      for (var n = sparks.length - 1; n >= 0; n--) {
        var p = sparks[n];
        p.x += p.vx; p.y += p.vy; p.vx *= 0.95; p.vy = p.vy * 0.95 + 0.06; p.life -= p.d;
        if (p.life <= 0) { sparks.splice(n, 1); continue; }
        g.fillStyle = p.w ? "rgba(255,255,255," + p.life + ")" : "rgba(94,156,255," + p.life + ")";
        g.shadowColor = "rgba(94,156,255,.9)"; g.shadowBlur = 10;
        g.beginPath(); g.arc(p.x, p.y, p.r * (0.5 + p.life * 0.5), 0, 6.283); g.fill();
        g.shadowBlur = 0;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  })();

  function hide() {
    if (closed) return;
    el.classList.add("out");
    setTimeout(function () {
      closed = true;
      if (raf) cancelAnimationFrame(raf);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (style.parentNode) style.parentNode.removeChild(style);
    }, 550);
    hide = function () {};
  }
  el.addEventListener("click", function () { hide(); });
  setTimeout(function () { hide(); }, reduce ? 700 : 3500);
})();
