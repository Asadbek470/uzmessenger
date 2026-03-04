let adminToken = localStorage.getItem("adminToken") || "";

function $(id){ return document.getElementById(id); }

function showAdminUI() {
  $("adminWrap").classList.remove("hidden");
  document.querySelector(".auth-card").classList.add("hidden");
  loadUsers();
}

function hideAdminUI() {
  $("adminWrap").classList.add("hidden");
  document.querySelector(".auth-card").classList.remove("hidden");
}

if (adminToken) showAdminUI();

async function adminLogin() {
  const user = $("adminUser").value.trim();
  const pass = $("adminPass").value.trim();
  $("aerr").textContent = "";

  const r = await fetch("/api/admin/login", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ user, pass })
  });
  const d = await r.json();
  if (!d.ok) {
    $("aerr").textContent = "Неверный логин/пароль";
    return;
  }

  adminToken = d.token;
  localStorage.setItem("adminToken", adminToken);
  showAdminUI();
}

function adminLogout() {
  localStorage.removeItem("adminToken");
  adminToken = "";
  hideAdminUI();
}

async function loadUsers() {
  const r = await fetch("/api/admin/users", {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const d = await r.json();
  if (!d.ok) return alert("Нет доступа");

  const wrap = $("usersTable");
  wrap.innerHTML = "";

  d.users.forEach(u => {
    const row = document.createElement("div");
    row.className = "admin-row";

    const until = Number(u.blockedUntil || 0);
    const blocked = until > Date.now();

    row.innerHTML = `
      <div class="ar">
        <div><b>@${u.username}</b> ${u.displayName ? `(${u.displayName})` : ""}</div>
        <div class="small">${blocked ? `🚫 Заблокирован до: ${new Date(until).toLocaleString()}` : "✅ Не заблокирован"}</div>
      </div>

      <div class="ar-controls">
        <label>Блок (минут)</label>
        <input type="number" min="0" value="0" data-min="${u.username}" />
        <button class="btn primary" onclick="applyBlock('${u.username}')">Применить</button>
      </div>

      <div class="ar-controls">
        <label><input type="checkbox" ${u.canSendText ? "checked" : ""} data-t="${u.username}" /> Сообщения</label>
        <label><input type="checkbox" ${u.canSendMedia ? "checked" : ""} data-m="${u.username}" /> Медиа</label>
        <label><input type="checkbox" ${u.canCall ? "checked" : ""} data-c="${u.username}" /> Звонки</label>
        <button class="btn ghost" onclick="saveRules('${u.username}')">Сохранить</button>
      </div>
    `;

    wrap.appendChild(row);
  });
}

async function applyBlock(username) {
  const inp = document.querySelector(`input[data-min="${username}"]`);
  const mins = Number(inp.value || 0);
  const blockedUntil = mins > 0 ? Date.now() + mins * 60 * 1000 : 0;

  await updateUser(username, { blockedUntil });
  alert("Сохранено");
  loadUsers();
}

async function saveRules(username) {
  const canSendText = !!document.querySelector(`input[data-t="${username}"]`).checked;
  const canSendMedia = !!document.querySelector(`input[data-m="${username}"]`).checked;
  const canCall = !!document.querySelector(`input[data-c="${username}"]`).checked;

  await updateUser(username, { canSendText, canSendMedia, canCall });
  alert("Сохранено");
  loadUsers();
}

async function updateUser(username, patch) {
  const r = await fetch("/api/admin/user/update", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username, ...patch })
  });
  const d = await r.json();
  if (!d.ok) alert("Ошибка");
}
