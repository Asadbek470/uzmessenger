// The admin panel has its own token, completely separate from a regular
// user's chat login token. Never mix these up.
let adminToken = localStorage.getItem("adminToken");
let currentUser = null;

// Отдельный «запретный» токен для чтения переписок. Обычный вход в админку
// (adminToken) его НЕ даёт — его выдаёт только правильный код через
// /api/admin/unlock-messages, и живёт он 30 минут. Не сохраняем его в
// localStorage специально — при перезагрузке страницы код нужно вводить заново.
let msgUnlockToken = null;
let pendingUnlockAction = null;

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}

// Заголовки для запросов, читающих текст переписки — используют
// разблокированный токен, если он уже есть, иначе обычный (сервер всё
// равно отклонит его с needUnlock, и мы откроем модалку с кодом).
function msgHeaders() {
  return { Authorization: `Bearer ${msgUnlockToken || adminToken}` };
}

// ---------------- MESSAGE UNLOCK (код на чтение переписок) ----------------
function openMsgUnlockModal(onSuccess) {
  pendingUnlockAction = onSuccess || null;
  document.getElementById("msgUnlockError").textContent = "";
  document.getElementById("msgUnlockInput").value = "";
  document.getElementById("msgUnlockModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("msgUnlockInput").focus(), 50);
}
function closeMsgUnlockModal() {
  document.getElementById("msgUnlockModal").classList.add("hidden");
  pendingUnlockAction = null;
}
async function submitMsgUnlockCode() {
  const code = document.getElementById("msgUnlockInput").value.trim();
  const errBox = document.getElementById("msgUnlockError");
  errBox.textContent = "";
  if (!code) return;

  const r = await fetch("/api/admin/unlock-messages", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  const d = await r.json();
  if (!d.ok) { errBox.textContent = d.error || "Неверный код"; return; }

  msgUnlockToken = d.token;
  document.getElementById("msgUnlockModal").classList.add("hidden");
  const action = pendingUnlockAction;
  pendingUnlockAction = null;
  if (action) action();
}

// ---------------- LOGIN / SESSION ----------------
window.addEventListener("DOMContentLoaded", async () => {
  if (adminToken) {
    const ok = await checkAdminSession();
    if (ok) return showDashboard();
  }
  showLogin();
});

function showLogin() {
  document.getElementById("adminLoginScreen").classList.remove("hidden");
  document.getElementById("adminDashboard").classList.add("hidden");
}

function showDashboard() {
  document.getElementById("adminLoginScreen").classList.add("hidden");
  document.getElementById("adminDashboard").classList.remove("hidden");
  loadVerificationRequests();
  refreshReportsBadge();
}

async function checkAdminSession() {
  try {
    const r = await fetch("/api/admin/users?q=", { headers: adminHeaders() });
    return r.ok;
  } catch {
    return false;
  }
}

async function adminLogin() {
  const login = document.getElementById("adminLoginInput").value.trim();
  const password = document.getElementById("adminPasswordInput").value;
  const errBox = document.getElementById("adminLoginError");
  errBox.textContent = "";

  const r = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password })
  });
  const d = await r.json();
  if (!d.ok) { errBox.textContent = d.error || "Ошибка входа"; return; }

  adminToken = d.token;
  localStorage.setItem("adminToken", adminToken);
  showDashboard();
}

function adminLogout() {
  localStorage.removeItem("adminToken");
  adminToken = null;
  msgUnlockToken = null;
  showLogin();
}

function switchAdminTab(tab) {
  document.querySelectorAll(".admintab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("tabUsers").classList.toggle("hidden", tab !== "users");
  document.getElementById("tabReports").classList.toggle("hidden", tab !== "reports");
  document.getElementById("tabVerification").classList.toggle("hidden", tab !== "verification");
  document.getElementById("tabSupport").classList.toggle("hidden", tab !== "support");
  document.getElementById("tabSessions").classList.toggle("hidden", tab !== "sessions");
  if (tab === "reports") loadReports("open");
  if (tab === "verification") loadVerificationRequests();
  if (tab === "support") loadSupportConversations();
  if (tab === "sessions") loadAdminSessions();
}

// ---------------- USER SEARCH / LIST ----------------
async function searchUser() {
  const q = document.getElementById("searchUser").value.replace("@", "").trim().toLowerCase();

  const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return;

  const list = document.getElementById("userList");
  document.getElementById("userCard").classList.add("hidden");
  closeThread();

  if (data.users.length === 0) { list.innerHTML = "<p class='hint'>Никого не нашлось</p>"; return; }

  list.innerHTML = data.users.map(u => `
    <button class="chatitem" onclick="openUser('${esc(u.username)}')">
      <div class="avatar">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="">` : `<span>${esc((u.displayName || u.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(u.displayName || u.username)}${u.verified ? ' <i class="fa-solid fa-circle-check verified-badge"></i>' : ""}</div>
        <div class="preview">@${esc(u.username)} ${u.banned ? "· 🚫 бан " + untilLabel(u.bannedUntil) : ""} ${u.muted ? "· 🔇 мут " + untilLabel(u.mutedUntil) : ""}</div>
      </div>
    </button>
  `).join("");
}

// Открыть карточку пользователя — просто просмотр профиля для бана/мута,
// пин-код тут НЕ нужен. Переписки/сессии/контакты подгружаются отдельно,
// по кнопке, и уже спросят код.
async function openUser(username) {
  currentUser = username;
  closeThread();
  document.getElementById("userOverviewBox").classList.add("hidden");

  const res = await fetch(`/api/admin/user/${encodeURIComponent(username)}`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) {
    return alert(data.error || "Не найден");
  }

  const user = data.user;
  document.getElementById("userCard").classList.remove("hidden");
  document.getElementById("userName").innerText = user.displayName || user.username;
  document.getElementById("userUsername").innerText = "@" + user.username;
  document.getElementById("userBio").innerText = user.bio || "";
  document.getElementById("userAvatar").src = user.avatarUrl || "/icon-192.png?v=4";
  const r = user.rating || { up: 0, down: 0 };
  document.getElementById("userFlags").innerText =
    `${user.verified ? "подтверждён ✅" : "не подтверждён"} · рейтинг: 👍 ${r.up} / 👎 ${r.down}` + (user.openReports ? ` · жалоб: ${user.openReports}` : "");
  document.getElementById("userSanctions").innerHTML =
    (user.banned
      ? `<div class="bad">🚫 Забанен ${untilLabel(user.bannedUntil)}${user.banReason ? " — " + esc(user.banReason) : ""}</div>`
      : `<div>✅ Не забанен</div>`) +
    (user.muted
      ? `<div class="bad">🔇 В муте ${untilLabel(user.mutedUntil)}${user.muteReason ? " — " + esc(user.muteReason) : ""}</div>`
      : `<div>🔊 Не в муте</div>`);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function untilLabel(ts) {
  return ts ? "до " + fmtDate(ts) : "без срока";
}

// Кнопка «Переписки / группы / контакты» в карточке — вот тут уже спрашиваем код.
async function revealUserOverview() {
  if (!currentUser) return;
  document.getElementById("userOverviewBox").classList.remove("hidden");
  await loadUserOverview(currentUser);
}

async function loadUserOverview(username) {
  if (!msgUnlockToken) return openMsgUnlockModal(() => loadUserOverview(username));

  const res = await fetch(`/api/admin/user/${encodeURIComponent(username)}/overview`, { headers: msgHeaders() });
  const data = await res.json();
  if (!data.ok) {
    if (data.needUnlock) { msgUnlockToken = null; return openMsgUnlockModal(() => loadUserOverview(username)); }
    return;
  }

  const partnerBox = document.getElementById("partnerList");
  partnerBox.innerHTML = data.partners.length === 0
    ? "<p class='hint'>Личных переписок нет</p>"
    : data.partners.map(p => `
        <button class="chatitem" onclick="openPrivateThread('${esc(username)}','${esc(p.username)}')">
          <div class="meta">
            <div class="name">@${esc(p.username)}</div>
            <div class="preview">${p.total} сообщени${pluralRu(p.total)} · последнее ${new Date(p.lastAt).toLocaleString("ru-RU")}</div>
          </div>
        </button>
      `).join("");

  const groupBox = document.getElementById("groupList");
  groupBox.innerHTML = data.groups.length === 0
    ? "<p class='hint'>Не состоит в группах/каналах</p>"
    : data.groups.map(g => `
        <button class="chatitem" onclick="openGroupThread(${g.id}, '${esc(g.name)}')">
          <div class="meta">
            <div class="name">${esc(g.name)} ${g.isChannel ? "(канал)" : ""}</div>
            <div class="preview">роль: ${g.role === "owner" ? "владелец" : g.role === "admin" ? "админ" : "участник"}</div>
          </div>
        </button>
      `).join("");

  const contactBox = document.getElementById("userContactsList");
  if (contactBox) {
    const contacts = data.contacts || [];
    contactBox.innerHTML = contacts.length === 0
      ? "<p class='hint'>Нет сохранённых контактов</p>"
      : contacts.map(c => `
          <div class="chatitem" style="cursor:default">
            <div class="meta">
              <div class="name">${esc(c.name || c.username)}</div>
              <div class="preview">@${esc(c.username)}${c.note ? " · " + esc(c.note) : ""}</div>
            </div>
          </div>
        `).join("");
  }
}

function pluralRu(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "е";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "я";
  return "й";
}

// ---------------- THREAD VIEWER ----------------
async function openPrivateThread(userA, userB) {
  if (!msgUnlockToken) return openMsgUnlockModal(() => openPrivateThread(userA, userB));

  const res = await fetch(`/api/admin/messages/private/${encodeURIComponent(userA)}/${encodeURIComponent(userB)}`, { headers: msgHeaders() });
  const data = await res.json();
  if (!data.ok) {
    if (data.needUnlock) { msgUnlockToken = null; return openMsgUnlockModal(() => openPrivateThread(userA, userB)); }
    return alert(data.error || "Ошибка загрузки переписки");
  }

  showThread(`@${userA} ↔ @${userB}`, data.messages);
}

async function openGroupThread(groupId, name) {
  if (!msgUnlockToken) return openMsgUnlockModal(() => openGroupThread(groupId, name));

  const res = await fetch(`/api/admin/messages/group/${groupId}`, { headers: msgHeaders() });
  const data = await res.json();
  if (!data.ok) {
    if (data.needUnlock) { msgUnlockToken = null; return openMsgUnlockModal(() => openGroupThread(groupId, name)); }
    return alert(data.error || "Ошибка загрузки сообщений");
  }

  showThread(`Группа: ${name}`, data.messages);
}

function showThread(title, messages) {
  document.getElementById("threadViewer").classList.remove("hidden");
  document.getElementById("threadTitle").textContent = title;

  const box = document.getElementById("threadMessages");
  if (messages.length === 0) {
    box.innerHTML = "<p class='hint'>Сообщений нет</p>";
    return;
  }

  box.innerHTML = messages.map(m => {
    let body;
    if (m.mediaType === "image") body = `<img src="${esc(m.mediaUrl)}" class="thread-media">`;
    else if (m.mediaType === "video") body = `<video src="${esc(m.mediaUrl)}" controls class="thread-media"></video>`;
    else if (m.mediaType === "audio") body = `<audio src="${esc(m.mediaUrl)}" controls></audio>`;
    else if (m.mediaType === "list") {
      let list; try { list = JSON.parse(m.text); } catch { list = { title: "", items: [] }; }
      body = `<b>${esc(list.title)}</b><br>` + (list.items || []).map(it => `${it.checked ? "☑" : "☐"} ${esc(it.text)}`).join("<br>");
    } else {
      // сквозное шифрование: текст зашифрован на устройствах собеседников, сервер и админка его не видят
      body = String(m.text || "").startsWith("e2e:1:")
        ? `<i style="opacity:.7">🔒 Зашифрованное сообщение (сквозное шифрование)</i>`
        : esc(m.text || "");
    }

    return `
      <div class="thread-msg">
        <div class="thread-meta">
          <b>@${esc(m.sender)}</b>
          <span class="hint">${new Date(m.createdAt).toLocaleString("ru-RU")}</span>
          <button class="iconbtn small" onclick="adminDeleteMessage(${m.id}, this)" title="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="thread-body">${body}</div>
      </div>
    `;
  }).join("");
}

function closeThread() {
  document.getElementById("threadViewer").classList.add("hidden");
  document.getElementById("threadMessages").innerHTML = "";
}

async function adminDeleteMessage(id, btn) {
  if (!confirm("Удалить это сообщение?")) return;
  const res = await fetch(`/api/admin/messages/${id}`, { method: "DELETE", headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return alert(data.error || "Ошибка");
  btn.closest(".thread-msg").remove();
}

// ---------------- MODERATION ACTIONS ----------------
async function callAdmin(path, method, body) {
  if (!currentUser) return;
  const res = await fetch(`/api/admin/${path}/${encodeURIComponent(currentUser)}`, {
    method,
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!data.ok) alert(data.error || "Ошибка");
  return data;
}

function onSanctionTermChange() {
  const v = document.getElementById("sanctionTerm").value;
  const inp = document.getElementById("sanctionCustom");
  inp.classList.toggle("hidden", v !== "hours" && v !== "days");
  inp.placeholder = v === "days" ? "Дней (1–50)" : "Часов";
  inp.max = v === "days" ? "50" : "";
  inp.value = "";
}

// Срок из формы → часы. 0 — без срока. null — срок введён неправильно.
function readSanctionHours() {
  const v = document.getElementById("sanctionTerm").value;
  if (v !== "hours" && v !== "days") return Number(v);
  const n = Number(document.getElementById("sanctionCustom").value);
  if (!Number.isFinite(n) || n <= 0) { alert("Укажи срок числом"); return null; }
  if (v === "days") {
    if (n < 1 || n > 50) { alert("Срок в днях — от 1 до 50"); return null; }
    return n * 24;
  }
  return n;
}
function termText(hours) {
  if (!hours) return "без срока (пока сам не снимешь)";
  return hours % 24 === 0 && hours >= 48 ? `на ${hours / 24} дн.` : `на ${hours} ч.`;
}

async function applySanction(kind) {
  const hours = readSanctionHours();
  if (hours === null) return;
  const reason = document.getElementById("sanctionReason").value.trim();
  const word = kind === "ban" ? "Забанить" : "Дать мут";
  if (!confirm(`${word} @${currentUser} ${termText(hours)}?`)) return;
  const d = await callAdmin(kind, "POST", { hours, reason });
  if (d && d.ok) openUser(currentUser);
}
async function banUser() { return applySanction("ban"); }
async function muteUser() { return applySanction("mute"); }
async function unbanUser() {
  const d = await callAdmin("unban", "POST");
  if (d && d.ok) openUser(currentUser);
}
async function unmuteUser() {
  const d = await callAdmin("unmute", "POST");
  if (d && d.ok) openUser(currentUser);
}

// ---------------- ЖАЛОБЫ ----------------
const REPORT_TYPE_LABEL = { story: "История", comment: "Комментарий к истории", post: "Пост", postcomment: "Комментарий к посту", user: "Человек", message: "Сообщение в переписке" };
let reportsStatus = "open";
async function loadReports(status) {
  reportsStatus = status || reportsStatus;
  document.getElementById("repOpenBtn").classList.toggle("active", reportsStatus === "open");
  document.getElementById("repClosedBtn").classList.toggle("active", reportsStatus === "closed");
  const res = await fetch(`/api/admin/reports?status=${reportsStatus}`, { headers: adminHeaders() });
  const d = await res.json();
  if (!d.ok) return;
  document.getElementById("reportsBadge").textContent = d.openCount ? String(d.openCount) : "";
  const box = document.getElementById("reportsList");
  if (!d.reports.length) { box.innerHTML = `<p class="hint">${reportsStatus === "open" ? "Новых жалоб нет" : "Пока пусто"}</p>`; return; }
  box.innerHTML = d.reports.map(r => {
    const isVideo = /\.(mp4|webm|mov)$/i.test(r.mediaUrl || "");
    const media = r.mediaUrl
      ? `<a href="${esc(r.mediaUrl)}" target="_blank" rel="noopener"><img class="rep-media" src="${esc(r.mediaUrl)}" alt="" onerror="this.outerHTML='Открыть вложение'"></a>`
      : "";
    const state = (r.ownerBanned ? " · 🚫 уже в бане" : "") + (r.ownerMuted ? " · 🔇 уже в муте" : "");
    return `
      <div class="ver-item">
        <div class="rep-head">
          <span class="rep-type">${REPORT_TYPE_LABEL[r.targetType] || esc(r.targetType)}</span>
          <span>автор: <b>@${esc(r.targetOwner)}</b>${state}</span>
          <span>· пожаловался @${esc(r.reporter)}</span>
          <span>· ${fmtDate(r.createdAt)}</span>
        </div>
        ${r.snapshot ? `<div class="rep-body">${esc(r.snapshot)}</div>` : ""}
        ${media}
        <div class="rep-reason"><b>Причина:</b> ${esc(r.reason || "не указана")}</div>
        <div class="ver-actions admin-actions">
          ${reportsStatus === "open" && r.targetType !== "user" && r.targetType !== "message" ? `<button class="danger" onclick="reportDeleteContent(${r.id})">Удалить это</button>` : ""}
          <button onclick="reportOpenUser('${esc(r.targetOwner)}')">Мут / бан автора</button>
          ${reportsStatus === "open" ? `<button class="success" onclick="reportClose(${r.id})">Закрыть жалобу</button>` : ""}
        </div>
      </div>`;
  }).join("");
}
async function reportClose(id) {
  await fetch(`/api/admin/reports/${id}/close`, { method: "POST", headers: adminHeaders() });
  loadReports();
}
async function reportDeleteContent(id) {
  if (!confirm("Удалить то, на что пожаловались? Вернуть будет нельзя.")) return;
  const res = await fetch(`/api/admin/reports/${id}/delete-content`, { method: "POST", headers: adminHeaders() });
  const d = await res.json();
  if (!d.ok) alert(d.error || "Ошибка");
  loadReports();
}
function reportOpenUser(username) {
  switchAdminTab("users");
  openUser(username);
  document.getElementById("userCard").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function refreshReportsBadge() {
  try {
    const d = await (await fetch(`/api/admin/reports?status=open`, { headers: adminHeaders() })).json();
    if (d.ok) document.getElementById("reportsBadge").textContent = d.openCount ? String(d.openCount) : "";
  } catch (e) {}
}

// Удаление аккаунта необратимо и затрагивает все данные человека — в отличие
// от бана/мута, это не «быстрый инструмент», поэтому тоже под пин-кодом.
async function deleteUser() {
  if (!currentUser) return;
  if (!msgUnlockToken) return openMsgUnlockModal(() => deleteUser());
  if (!confirm("Удалить аккаунт навсегда? Это действие необратимо.")) return;

  const res = await fetch(`/api/admin/delete/${encodeURIComponent(currentUser)}`, { method: "DELETE", headers: msgHeaders() });
  const d = await res.json();
  if (!d.ok) {
    if (d.needUnlock) { msgUnlockToken = null; return openMsgUnlockModal(() => deleteUser()); }
    return alert(d.error || "Ошибка");
  }

  alert("Аккаунт удалён");
  document.getElementById("userCard").classList.add("hidden");
  closeThread();
  currentUser = null;
  searchUser();
}

// ---------------- VERIFICATION REQUESTS ----------------
async function loadVerificationRequests() {
  const box = document.getElementById("verificationList");
  if (!box) return;

  const res = await fetch("/api/admin/verification-requests", { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) { box.innerHTML = "<p>Ошибка загрузки заявок</p>"; return; }

  if (data.requests.length === 0) {
    box.innerHTML = "<p class='hint'>Нет заявок на рассмотрении</p>";
    return;
  }

  box.innerHTML = data.requests.map(r => `
    <div class="ver-item" data-id="${r.id}">
      <div><b>@${esc(r.username)}</b> — ${esc(r.orgName)}, ${esc(r.role)}</div>
      <div><a href="${esc(r.proofUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.proofUrl)}</a></div>
      <div class="ver-actions">
        <button class="success" onclick="decideVerification(${r.id}, 'approve')">Одобрить</button>
        <button class="danger" onclick="decideVerification(${r.id}, 'reject')">Отклонить</button>
      </div>
    </div>
  `).join("");
}

async function decideVerification(id, action) {
  const res = await fetch(`/api/admin/verification-requests/${id}/${action}`, {
    method: "POST",
    headers: adminHeaders()
  });
  const data = await res.json();
  if (!data.ok) return alert(data.error || "Ошибка");
  loadVerificationRequests();
}

// ---------------- SUPPORT ----------------
let currentSupportUser = null;

async function loadSupportConversations() {
  const box = document.getElementById("supportConversations");
  const res = await fetch("/api/admin/support/conversations", { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) { box.innerHTML = "<p>Ошибка загрузки</p>"; return; }

  if (data.conversations.length === 0) {
    box.innerHTML = "<p class='hint'>Обращений пока нет</p>";
    return;
  }

  box.innerHTML = data.conversations.map(c => `
    <button class="chatitem" onclick="openSupportThread('${esc(c.username)}')">
      <div class="meta">
        <div class="name">@${esc(c.username)} ${c.fromUser > 0 ? "" : "<span class='hint'>(отвечено)</span>"}</div>
        <div class="preview">${c.total} сообщени${pluralRu(c.total)} · последнее ${new Date(c.lastAt).toLocaleString("ru-RU")}</div>
      </div>
    </button>
  `).join("");
}

async function openSupportThread(username) {
  currentSupportUser = username;
  const res = await fetch(`/api/admin/support/${encodeURIComponent(username)}`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return alert(data.error || "Ошибка");

  document.getElementById("supportThreadViewer").classList.remove("hidden");
  document.getElementById("supportThreadTitle").textContent = `Обращение @${username}`;

  const box = document.getElementById("supportThreadMessages");
  box.innerHTML = data.messages.map(m => `
    <div class="thread-msg">
      <div class="thread-meta"><b>${m.sender === "support" ? "Поддержка" : "@" + esc(m.sender)}</b>
        <span class="hint">${new Date(m.createdAt).toLocaleString("ru-RU")}</span></div>
      <div class="thread-body">${esc(m.text || "")}</div>
    </div>
  `).join("");
}

function closeSupportThread() {
  document.getElementById("supportThreadViewer").classList.add("hidden");
  currentSupportUser = null;
}

async function sendSupportReply() {
  if (!currentSupportUser) return;
  const input = document.getElementById("supportReplyInput");
  const text = input.value.trim();
  if (!text) return;

  const res = await fetch(`/api/admin/support/${encodeURIComponent(currentSupportUser)}/reply`, {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (!data.ok) return alert(data.error || "Ошибка отправки");

  input.value = "";
  openSupportThread(currentSupportUser);
  loadSupportConversations();
}

// ---------------- SESSIONS ----------------
// Сессии — это IP, устройство, история входов конкретного человека, то есть
// тоже личные данные. Поэтому, как и с перепиской/профилем, без кода
// разблокировки список сессий не отдаётся.
async function loadAdminSessions() {
  if (!msgUnlockToken) return openMsgUnlockModal(() => loadAdminSessions());

  const q = document.getElementById("searchSessions").value.trim();
  const res = await fetch(`/api/admin/sessions?q=${encodeURIComponent(q)}`, { headers: msgHeaders() });
  const data = await res.json();
  const box = document.getElementById("sessionsList");
  if (!data.ok) {
    if (data.needUnlock) { msgUnlockToken = null; return openMsgUnlockModal(() => loadAdminSessions()); }
    box.innerHTML = "<p>Ошибка загрузки</p>";
    return;
  }

  if (data.sessions.length === 0) {
    box.innerHTML = "<p class='hint'>Сессий не найдено</p>";
    return;
  }

  box.innerHTML = data.sessions.map(s => `
    <div class="ver-item">
      <div><b>@${esc(s.username)}</b> ${s.online ? "<span style='color:#29d17d'>● онлайн</span>" : "<span class='hint'>оффлайн</span>"} ${s.revoked ? "<span class='hint'>· завершена</span>" : ""}</div>
      <div class="hint">${new Date(s.createdAt).toLocaleString("ru-RU")} · ${esc(s.ip || "IP неизвестен")}</div>
      <div class="hint">${esc((s.userAgent || "").slice(0, 90))}</div>
      ${!s.revoked ? `<div class="ver-actions"><button class="danger" onclick="revokeAdminSession(${s.id})">Завершить сессию</button></div>` : ""}
    </div>
  `).join("");
}

async function revokeAdminSession(id) {
  if (!msgUnlockToken) return openMsgUnlockModal(() => revokeAdminSession(id));
  const res = await fetch(`/api/admin/sessions/${id}/revoke`, { method: "POST", headers: msgHeaders() });
  const data = await res.json();
  if (!data.ok) {
    if (data.needUnlock) { msgUnlockToken = null; return openMsgUnlockModal(() => revokeAdminSession(id)); }
    return alert(data.error || "Ошибка");
  }
  loadAdminSessions();
}
