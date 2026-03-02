function getAdminToken() {
  return localStorage.getItem("admin_token") || "";
}

async function adminLogin() {
  const username = document.getElementById("adminUser").value.trim();
  const pin = document.getElementById("adminPin").value.trim();

  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username, pin })
  });

  const data = await res.json();

  if (!data.success) {
    alert(data.error || "Ошибка входа");
    return;
  }

  localStorage.setItem("admin_token", data.token);
  showAdminPanel();
  loadAdminUsers();
}

function logoutAdmin() {
  localStorage.removeItem("admin_token");
  document.getElementById("loginCard").classList.remove("hidden");
  document.getElementById("adminPanel").classList.add("hidden");
}

function showAdminPanel() {
  document.getElementById("loginCard").classList.add("hidden");
  document.getElementById("adminPanel").classList.remove("hidden");
}

async function loadAdminUsers() {
  const q = document.getElementById("searchAdminUser").value.trim();

  const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, {
    headers: {
      "x-admin-token": getAdminToken()
    }
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Ошибка загрузки пользователей");
    return;
  }

  const list = document.getElementById("usersList");
  list.innerHTML = data.users.map(user => `
    <div class="user-row">
      <div>
        <div><b>@${user.username}</b></div>
        <div class="mini">${user.displayName || user.username}</div>
        <div class="mini">${user.bio || ""}</div>
        <div>
          ${user.isBanned ? `<span class="status-badge">Заблокирован</span>` : `<span class="status-badge">Активен</span>`}
          ${user.textBlocked ? `<span class="status-badge">Text off</span>` : ""}
          ${user.imageBlocked ? `<span class="status-badge">Photo off</span>` : ""}
          ${user.videoBlocked ? `<span class="status-badge">Video off</span>` : ""}
          ${user.audioBlocked ? `<span class="status-badge">Audio off</span>` : ""}
        </div>
      </div>

      <div>
        <select id="banType_${user.username}">
          <option value="none">Без бана</option>
          <option value="1d">1 день</option>
          <option value="2d">2 дня</option>
          <option value="3d">3 дня</option>
          <option value="30d">30 дней</option>
          <option value="1y">1 год</option>
          <option value="10y">10 лет</option>
          <option value="forever">Почти навсегда</option>
        </select>
        <button class="danger" onclick="setBan('${user.username}')">Установить бан</button>
      </div>

      <div>
        <select id="restrictType_${user.username}">
          <option value="text">Запретить текст</option>
          <option value="image">Запретить фото</option>
          <option value="video">Запретить видео</option>
          <option value="audio">Запретить аудио</option>
        </select>

        <select id="restrictTime_${user.username}">
          <option value="1h">1 час</option>
          <option value="6h">6 часов</option>
          <option value="12h">12 часов</option>
          <option value="1d">1 день</option>
          <option value="3d">3 дня</option>
          <option value="7d">7 дней</option>
          <option value="30d">30 дней</option>
        </select>

        <button onclick="setRestriction('${user.username}')">Ограничить</button>
      </div>

      <div>
        <button class="gray" onclick="clearRestrictions('${user.username}')">Снять все ограничения</button>
      </div>
    </div>
  `).join("");
}

function durationToMs(value) {
  const map = {
    "1h": 1 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "1d": 1 * 24 * 60 * 60 * 1000,
    "2d": 2 * 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "1y": 365 * 24 * 60 * 60 * 1000,
    "10y": 10 * 365 * 24 * 60 * 60 * 1000,
    "forever": 100 * 365 * 24 * 60 * 60 * 1000
  };
  return map[value] || 0;
}

async function setBan(username) {
  const duration = document.getElementById(`banType_${username}`).value;

  const res = await fetch("/api/admin/ban", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": getAdminToken()
    },
    body: JSON.stringify({
      username,
      durationMs: durationToMs(duration)
    })
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Ошибка бана");
    return;
  }

  loadAdminUsers();
}

async function setRestriction(username) {
  const type = document.getElementById(`restrictType_${username}`).value;
  const duration = document.getElementById(`restrictTime_${username}`).value;

  const res = await fetch("/api/admin/restrict", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": getAdminToken()
    },
    body: JSON.stringify({
      username,
      type,
      durationMs: durationToMs(duration)
    })
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Ошибка ограничения");
    return;
  }

  loadAdminUsers();
}

async function clearRestrictions(username) {
  const res = await fetch("/api/admin/clear", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": getAdminToken()
    },
    body: JSON.stringify({ username })
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Ошибка очистки");
    return;
  }

  loadAdminUsers();
}

window.addEventListener("DOMContentLoaded", () => {
  if (getAdminToken()) {
    showAdminPanel();
    loadAdminUsers();
  }
});
