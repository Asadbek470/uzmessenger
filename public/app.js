/* ================= MISSING UI FUNCTIONS ================= */

async function loadChatList() {
  // 1) подгружаем личные чаты
  const res = await fetch("/api/chats", { headers: headers() });
  const chats = await res.json();

  const block = document.getElementById("privateChatsBlock");
  if (!block) return;

  block.innerHTML = "";

  chats.forEach(c => {
    const u = c.chatWith;
    const item = document.createElement("div");
    item.className = "chat-item";
    item.dataset.chat = u;
    item.onclick = () => switchChat(u);

    item.innerHTML = `
      <div class="avatar-circle">${escapeHtml(u[0] || "?")}</div>
      <div class="chat-meta">
        <span class="name">@${escapeHtml(u)}</span>
        <span class="preview">Открыть чат</span>
      </div>
    `;
    block.appendChild(item);
  });

  // подсветка активного
  document.querySelectorAll(".chat-item").forEach(el => {
    el.classList.toggle("active", el.dataset.chat === currentChat);
  });
}

function switchChat(chat) {
  currentChat = chat;
  document.getElementById("chatTitle").textContent = chat === "global" ? "Общий чат" : "@" + chat;
  document.getElementById("chatStatus").textContent = chat === "global" ? "общение со всеми" : "личная переписка";
  loadMessages(chat);
  loadChatList();
  // на телефоне закрыть сайдбар
  if (window.innerWidth <= 768) document.getElementById("sidebar")?.classList.remove("active-mobile");
}

function toggleSidebarMobile() {
  document.getElementById("sidebar")?.classList.toggle("active-mobile");
}

async function searchUsers(q) {
  const out = document.getElementById("searchResults");
  if (!out) return;

  const query = q.trim();
  if (!query) { out.innerHTML = ""; return; }

  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: headers() });
  const rows = await res.json();

  out.innerHTML = "";
  rows.forEach(r => {
    const u = r.username;
    if (!u || u === currentUser) return;

    const item = document.createElement("div");
    item.className = "chat-item";
    item.onclick = () => switchChat(u);

    item.innerHTML = `
      <div class="avatar-circle">${escapeHtml((u[0] || "?"))}</div>
      <div class="chat-meta">
        <span class="name">@${escapeHtml(u)} ${r.phone ? " · " + escapeHtml(r.phone) : ""}</span>
        <span class="preview">${escapeHtml(r.displayName || "")}</span>
      </div>
    `;
    out.appendChild(item);
  });
}

async function uploadMedia(input) {
  const file = input.files?.[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("receiver", currentChat);

  await fetch("/api/upload", { method: "POST", headers: headers(), body: fd });

  input.value = "";
}

/* ====== Improve render: show sender + nicer delete button ====== */
function renderMessage(msg) {
  const container = document.getElementById("messagesContainer");
  const mine = msg.sender === currentUser;

  let content = "";

  if (msg.mediaType === "image") {
    content = `<img class="msg-image" src="${msg.mediaUrl}">`;
  } else if (msg.mediaType === "video") {
    content = `<video class="msg-video" controls playsinline src="${msg.mediaUrl}"></video>`;
  } else if (msg.mediaType === "audio") {
    content = `<audio class="voice-audio" controls src="${msg.mediaUrl}"></audio>`;
  } else {
    content = `<div class="msg-text">${escapeHtml(msg.text)}</div>`;
  }

  const row = document.createElement("div");
  row.className = `message-row ${mine ? "mine" : "other"}`;
  row.dataset.messageId = msg.id;

  row.innerHTML = `
    <div class="bubble">
      <div class="bubble-top">
        <div class="sender-name">${mine ? "Вы" : "@" + escapeHtml(msg.sender)}</div>
        ${mine ? `<button class="delete-msg-btn" onclick="deleteMessage(${msg.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>` : ""}
      </div>
      ${content}
    </div>
  `;

  container.appendChild(row);
  scrollBottom();
}

/* ====== Calls: fix audio-only remote ====== */
async function createPeer(peer) {
  currentCallPeer = peer;
  peerConnection = new RTCPeerConnection(rtcConfig);

  await ensureLocalStream();

  localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

  peerConnection.onicecandidate = e => {
    if (!e.candidate) return;
    socket.send(JSON.stringify({ type: "ice-candidate", to: peer, from: currentUser, candidate: e.candidate }));
  };

  peerConnection.ontrack = async (e) => {
    const track = e.track;
    if (track.kind === "audio") {
      const remoteAudio = document.getElementById("remoteAudio");
      remoteAudio.srcObject = e.streams[0];
      try { await remoteAudio.play(); } catch {}
      return;
    }

    const remoteVideo = document.getElementById("remoteVideo");
    remoteVideo.srcObject = e.streams[0];
    try { await remoteVideo.play(); } catch {}
  };
}

function rejectIncomingCall() {
  document.getElementById("incomingCallModal").style.display = "none";
  pendingIncomingOffer = null;
  pendingIncomingFrom = null;
}

/* ====== Profile settings (quick version with prompts) ====== */
async function openSettings() {
  const me = await fetch("/api/me", { headers: headers() }).then(r => r.json());
  const p = me.profile || {};

  const displayName = prompt("Имя (display name):", p.displayName || currentUser);
  if (displayName === null) return;

  const bio = prompt("Bio (о себе):", p.bio || "");
  if (bio === null) return;

  const phone = prompt("Телефон (для поиска, не обязательно):", p.phone || "");
  if (phone === null) return;

  await fetch("/api/me", {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, bio, phone })
  });

  alert("Профиль обновлён ✅");
}

/* ====== Stories ====== */
async function loadStories() {
  const list = document.getElementById("storiesList");
  if (!list) return;

  const res = await fetch("/api/stories", { headers: headers() });
  const stories = await res.json();

  list.innerHTML = "";
  stories.slice(0, 20).forEach(s => {
    const chip = document.createElement("button");
    chip.className = "story-chip";
    chip.onclick = () => openStoryView(s);

    chip.innerHTML = `
      <div class="story-avatar">${s.mediaUrl ? `<img src="${s.mediaUrl}">` : escapeHtml((s.owner||"?")[0])}</div>
      <div class="story-name">@${escapeHtml(s.owner || "")}</div>
    `;
    list.appendChild(chip);
  });
}

function openStoryComposer() {
  document.getElementById("storyComposerModal").style.display = "flex";
}
function closeStoryComposer() {
  document.getElementById("storyComposerModal").style.display = "none";
}

async function publishStory() {
  const file = document.getElementById("storyFile").files?.[0] || null;
  const text = document.getElementById("storyText").value || "";

  const fd = new FormData();
  if (file) fd.append("story", file);
  fd.append("text", text);

  await fetch("/api/stories", { method: "POST", headers: headers(), body: fd });

  document.getElementById("storyText").value = "";
  document.getElementById("storyFile").value = "";
  closeStoryComposer();
  await loadStories();
}

function openStoryView(s) {
  document.getElementById("storyViewModal").style.display = "flex";
  document.getElementById("storyViewTitle").textContent = "@" + (s.owner || "");
  document.getElementById("storyViewText").textContent = s.text || "";

  const c = document.getElementById("storyViewContent");
  if (s.mediaType === "video") {
    c.innerHTML = `<video class="msg-video" controls playsinline src="${s.mediaUrl}"></video>`;
  } else if (s.mediaUrl) {
    c.innerHTML = `<img class="msg-image" src="${s.mediaUrl}">`;
  } else {
    c.innerHTML = `<div class="msg-text">Без медиа</div>`;
  }
}

function closeStoryView() {
  document.getElementById("storyViewModal").style.display = "none";
}

async function openCurrentProfile() {
  const me = await fetch("/api/me", { headers: headers() }).then(r => r.json());
  const p = me.profile || {};
  alert(`@${p.username}\nИмя: ${p.displayName || ""}\nBio: ${p.bio || ""}\nТел: ${p.phone || ""}`);
}

/* ====== Hook stories on init ====== */
const _oldInit = initChat;
initChat = function () {
  _oldInit();
  loadStories();
};
