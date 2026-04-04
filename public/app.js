const token = localStorage.getItem('token');
if (!token) window.location.href = 'index.html';

const ws = new WebSocket(`ws://${location.host}/?token=${token}`);  // For local, adjust for production

let currentChat = null;
let mediaRecorder;
let audioChunks = [];
let peerConnection;
const stunServer = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM elements
const sidebar = document.querySelector('.sidebar');
const chatsList = document.querySelector('.chats-list');
const chatTitle = document.getElementById('chat-title');
const chatStatus = document.getElementById('chat-status');
const messagesDiv = document.querySelector('.messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn');
const micBtn = document.getElementById('mic-btn');
const callBtn = document.getElementById('call-btn');
const backBtn = document.querySelector('.back-btn');
const createGroupBtn = document.getElementById('create-group');
const settingsBtn = document.getElementById('settings');
const searchInput = document.getElementById('search-input');
const storiesBtn = document.getElementById('stories-btn');

// Modals
const profileModal = document.getElementById('profile-modal');
const settingsModal = document.getElementById('settings-modal');
const sessionsList = document.getElementById('sessions-list');
const createGroupModal = document.getElementById('create-group-modal');
const groupInfoModal = document.getElementById('group-info-modal');
const incomingCallModal = document.getElementById('incoming-call-modal');
const callModal = document.getElementById('call-modal');
const storiesModal = document.getElementById('stories-modal');

// Load profile
async function loadProfile() {
  const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    // Use data.user
    document.getElementById('display-name').value = data.user.displayName || '';
    document.getElementById('bio').value = data.user.bio || '';
    document.getElementById('birth-date').value = data.user.birthDate || '';
  }
// ================== AUTH ==================
const token = localStorage.getItem("token");
if (!token) location.href = "index.html";

let me = null;
let currentChat = "global";
let ws = null;

// typing timer
let typingTimer = null;
let isTypingNow = false;

// audio recorder (hold)
let mediaRecorder = null;
let chunks = [];
let holding = false;

// WebRTC audio call
let pc = null;
let localStream = null;
let remoteStream = null;
let callPeer = null;
let isMuted = false;

// incoming offer buffer
let incomingOffer = null;
let incomingFrom = null;

const rtcCfg = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// online state
const onlineSet = new Set();

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

// Load sessions
async function loadSessions() {
  const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    sessionsList.innerHTML = '';
    data.sessions.forEach(s => {
      const div = document.createElement('div');
      div.classList.add('session-item');
      div.innerHTML = `
        <span>${s.deviceName} - Last used: ${s.lastUsed}</span>
        <button class="btn danger small" onclick="terminateSession(${s.id})">Terminate</button>
      `;
      sessionsList.appendChild(div);
    });
  }
function esc(s="") {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function terminateSession(id) {
  const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if ((await res.json()).ok) {
    loadSessions();
  }
// ================== INIT ==================
async function initApp() {
  await loadMe();
  connectWS();

  openChat("global");
  await refreshChats();
  await loadStories();
  await showBirthdays();

  // call btn only in private
  document.getElementById("callBtn").style.display = "none";

  // ask notifications permission (optional)
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(()=>{});
    }
  } catch {}

  // close sidebar on mobile start
  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.add("mobile-hidden");
}

// Load chats
async function loadChats() {
  const res = await fetch('/api/chats', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    chatsList.innerHTML = '';
    data.chats.forEach(chat => {
      const div = document.createElement('div');
      div.classList.add('chat-item');
      div.innerHTML = `<span class="chat-avatar">👤</span><span>${chat.name}</span>`;
      div.onclick = () => openChat(chat);
      chatsList.appendChild(div);
    });
async function loadMe() {
  const r = await fetch("/api/me", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return logout();
  me = d.profile;
}

// ================== NAV/UI ==================
function logout() {
  localStorage.removeItem("token");
  location.href = "index.html";
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("mobile-hidden");
}

function updateHeader() {
  const title = document.getElementById("chatTitle");
  const sub = document.getElementById("chatSub");
  title.textContent = currentChat === "global" ? "Общий чат" : "@" + currentChat;
  sub.textContent = currentChat === "global" ? "общение со всеми" : (onlineSet.has(currentChat) ? "в сети" : "не в сети");

  document.getElementById("callBtn").style.display = currentChat === "global" ? "none" : "inline-flex";
}

// ================== WS ==================
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}?token=${encodeURIComponent(token)}`);

  ws.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    if (data.type === "presence") {
      onlineSet.clear();
      (data.online || []).forEach(u => onlineSet.add(u));
      updateHeader();
      renderOnlineDots();
      return;
    }

    if (data.type === "typing") {
      if (currentChat === data.from) {
        const el = document.getElementById("typingLine");
        el.classList.toggle("hidden", !data.isTyping);
      }
      return;
    }

    if (data.type === "messageDeleted") {
      const el = document.querySelector(`[data-mid="${data.id}"]`);
      if (el) el.remove();
      return;
    }

    // calls
    if (data.type === "call-offer") return onIncomingOffer(data);
    if (data.type === "call-answer") return onCallAnswer(data);
    if (data.type === "ice") return onIce(data);
    if (data.type === "call-end") return onCallEnd();
    if (data.type === "call-reject") return onCallReject(data);
    if (data.type === "call-error") return alert(data.message || "Ошибка звонка");

    if (data.type === "message") {
      const msg = data.message;
      if (shouldRender(msg)) renderMessage(msg);

      // уведомление если чат не открыт / вкладка скрыта
      if (!shouldRender(msg) || document.hidden) maybeNotify(msg);

      await refreshChats();
      return;
    }
  };
}

function maybeNotify(msg){
  try{
    if(!("Notification" in window)) return;
    if(Notification.permission !== "granted") return;

    // не уведомляем о своих сообщениях
    if(msg.sender === me.username) return;

    const title = msg.chatType === "global" ? "Общий чат" : "@" + msg.sender;
    const body = msg.mediaType !== "text" ? `[${msg.mediaType}]` : (msg.text || "");
    new Notification(title, { body });
  }catch{}
}

function typing(on){
  if (!ws || ws.readyState !== 1) return;
  if (currentChat === "global") return;

  // не спамим
  if (on && isTypingNow) return;

  isTypingNow = on;
  ws.send(JSON.stringify({ type:"typing", to: currentChat, isTyping: on }));

  if (typingTimer) clearTimeout(typingTimer);
  if (on){
    typingTimer = setTimeout(()=>{
      isTypingNow = false;
      ws.send(JSON.stringify({ type:"typing", to: currentChat, isTyping: false }));
    }, 1200);
  }
}

loadProfile();
loadChats();
function shouldRender(msg) {
  if (msg.chatType === "global") return currentChat === "global";
  const other = msg.sender === me.username ? msg.receiver : msg.sender;
  return currentChat === other;
}

// Open chat
// ================== CHAT ==================
async function openChat(chat) {
  currentChat = chat;
  chatTitle.textContent = chat.name;
  callBtn.style.display = chat.type === 'personal' ? 'block' : 'none';
  loadMessages(chat.id);
  if (window.innerWidth <= 768) {
    sidebar.classList.remove('active');
  currentChat = chat === "global" ? "global" : String(chat).replace(/^@+/, "").toLowerCase();

  // active ui
  document.querySelectorAll(".chatitem").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`.chatitem[data-chat="${currentChat}"]`);
  if (btn) btn.classList.add("active");

  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.add("mobile-hidden");

  document.getElementById("typingLine").classList.add("hidden");
  updateHeader();

  await loadMessages();
}

async function loadMessages() {
  const box = document.getElementById("messages");
  box.innerHTML = "";

  const r = await fetch(`/api/messages?chat=${encodeURIComponent(currentChat)}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  d.messages.forEach(renderMessage);
  scrollBottom();
}

function scrollBottom() {
  const box = document.getElementById("messages");
  box.scrollTop = box.scrollHeight;
}

function renderMessage(m) {
  const box = document.getElementById("messages");
  const mine = m.sender === me.username;

  let body = "";
  if (m.mediaType === "image") {
    body = `<img class="mimg" src="${m.mediaUrl}" alt="">`;
  } else if (m.mediaType === "video") {
    body = `<video class="mvid" controls playsinline src="${m.mediaUrl}"></video>`;
  } else if (m.mediaType === "audio") {
    body = `<audio class="maud" controls src="${m.mediaUrl}"></audio>`;
  } else {
    body = `<div class="mtext">${esc(m.text || "")}</div>`;
  }

  const del = mine ? `<button class="trash" onclick="deleteMsg(${m.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>` : "";

  const row = document.createElement("div");
  row.className = "mrow " + (mine ? "mine" : "other");
  row.dataset.mid = String(m.id);

  row.innerHTML = `
    <div class="bubble pop">
      <div class="btop">
        <div class="who">${esc(m.sender)}</div>
        ${del}
      </div>
      ${body}
    </div>
  `;

  box.appendChild(row);
  scrollBottom();
}

async function deleteMsg(id) {
  if (!confirm("Удалить сообщение?")) return;
  const r = await fetch(`/api/messages/${id}`, { method: "DELETE", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) alert(d.error || "Ошибка удаления");
}

function onEnter(e) {
  if (e.key === "Enter") sendText();
}

function sendText() {
  const input = document.getElementById("textInput");
  const text = input.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");

  ws.send(JSON.stringify({ type: "text-message", receiver: currentChat, text }));
  input.value = "";
  typing(false);
}

async function sendMedia(input) {
  const file = input.files[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("receiver", currentChat);
  fd.append("text", "");

  const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  if (!d.ok) alert(d.error || "Ошибка медиа");

  input.value = "";
}

async function refreshChats() {
  const r = await fetch("/api/chats", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  const wrap = document.getElementById("privateChats");
  wrap.innerHTML = "";

  d.chats.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "chatitem";
    btn.dataset.chat = c.username;
    btn.onclick = () => openChat(c.username);

    const isOn = onlineSet.has(c.username);

    btn.innerHTML = `
      <div class="avatar">${c.avatarUrl ? `<img src="${c.avatarUrl}" alt="">` : `<span>${esc((c.displayName||c.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(c.displayName || c.username)}</div>
        <div class="preview">${esc(c.preview || "")}</div>
      </div>
      <span class="dot ${isOn ? "online" : "offline"}" title="${isOn ? "Онлайн" : "Оффлайн"}"></span>
    `;
    wrap.appendChild(btn);
  });

  renderOnlineDots();
}

// Load messages
async function loadMessages(chatId) {
  const res = await fetch(`/api/messages?chat=${chatId}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    messagesDiv.innerHTML = '';
    data.messages.forEach(msg => appendMessage(msg));
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
function renderOnlineDots(){
  document.querySelectorAll("#privateChats .chatitem").forEach(btn=>{
    const u = btn.dataset.chat;
    const dot = btn.querySelector(".dot");
    if(!dot) return;
    const on = onlineSet.has(u);
    dot.classList.toggle("online", on);
    dot.classList.toggle("offline", !on);
  });
}

// ================== SEARCH ==================
async function searchUsers(val) {
  const qraw = String(val || "").trim();
  const results = document.getElementById("searchResults");

  if (!qraw.startsWith("@") || qraw.length < 2) {
    results.innerHTML = "";
    return;
  }

  const q = qraw.replace(/^@+/, "");
  const r = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  results.innerHTML = "";
  d.users.forEach(u => {
    const btn = document.createElement("button");
    btn.className = "chatitem";
    btn.onclick = () => { results.innerHTML=""; document.getElementById("searchInput").value=""; openChat(u.username); };
    btn.innerHTML = `
      <div class="avatar">${u.avatarUrl ? `<img src="${u.avatarUrl}" alt="">` : `<span>${esc((u.displayName||u.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(u.displayName || u.username)}</div>
        <div class="preview">@${esc(u.username)}</div>
      </div>
      <span class="dot ${onlineSet.has(u.username) ? "online" : "offline"}"></span>
    `;
    results.appendChild(btn);
  });
}

function appendMessage(msg) {
  const div = document.createElement('div');
  div.classList.add('message');
  if (msg.sender === localStorage.getItem('username')) div.classList.add('own');  // Assume username stored
  let content = `<div class="sender">${msg.sender}</div>`;
  if (msg.text) content += `<p>${msg.text}</p>`;
  if (msg.mediaUrl) {
    if (msg.mediaType === 'image') {
      content += `<img src="${msg.mediaUrl}" alt="image" style="max-width:100%; border-radius:8px;">`;
    } else if (msg.mediaType === 'video') {
      content += `<video src="${msg.mediaUrl}" controls style="max-width:100%; border-radius:8px;"></video>`;
    } else if (msg.mediaType === 'audio') {
      content += `<audio src="${msg.mediaUrl}" controls></audio>`;
    }
// ================== PROFILE VIEW ==================
async function openCurrentProfile() {
  if (currentChat === "global") {
    await openProfile(me.username, true);
  } else {
    await openProfile(currentChat, false);
  }
  div.innerHTML = content;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Send message
sendBtn.addEventListener('click', () => {
  const text = messageInput.value.trim();
  if (text) {
    ws.send(JSON.stringify({
      type: 'text-message',
      chatType: currentChat.type,
      receiver: currentChat.type === 'personal' ? currentChat.id : null,
      groupId: currentChat.type === 'group' ? currentChat.id.split(':')[1] : null,
      text
    }));
    messageInput.value = '';
}

async function openProfile(username, isMe) {
  const modal = document.getElementById("profileModal");
  modal.classList.remove("hidden");

  const title = document.getElementById("profileTitle");
  const avatar = document.getElementById("profileAvatar");
  const name = document.getElementById("profileName");
  const user = document.getElementById("profileUser");
  const bio = document.getElementById("profileBio");
  const birth = document.getElementById("profileBirth");
  const actions = document.getElementById("profileActions");

  title.textContent = isMe ? "Мой профиль" : "Профиль";
  actions.innerHTML = "";

  let p = null;
  if (isMe) {
    p = me;
  } else {
    const r = await fetch(`/api/users/${encodeURIComponent(username)}`, { headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) { alert("Не найден"); return closeProfile(); }
    p = d.user;
  }
});

// Typing indicator
let typingTimeout;
messageInput.addEventListener('input', () => {
  ws.send(JSON.stringify({ type: 'typing', chatId: currentChat.id, isTyping: true }));
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    ws.send(JSON.stringify({ type: 'typing', chatId: currentChat.id, isTyping: false }));
  }, 3000);
});

// Attach file
attachBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*,audio/*';
  input.onchange = async () => {
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (data.ok) {
      ws.send(JSON.stringify({
        type: 'media-message',
        chatType: currentChat.type,
        receiver: currentChat.type === 'personal' ? currentChat.id : null,
        groupId: currentChat.type === 'group' ? currentChat.id.split(':')[1] : null,
        mediaType: data.mediaType,
        mediaUrl: data.mediaUrl
      }));
    }
  };
  input.click();
});

// Voice message
micBtn.addEventListener('mousedown', async () => {
  avatar.innerHTML = p.avatarUrl ? `<img src="${p.avatarUrl}" alt="">` : `<span>${esc((p.displayName||p.username)[0].toUpperCase())}</span>`;
  name.textContent = p.displayName || p.username;
  user.textContent = "@" + p.username;
  bio.textContent = p.bio ? p.bio : "";
  birth.textContent = p.birthDate ? ("🎂 " + p.birthDate) : "";

  if (!isMe) {
    const b = document.createElement("button");
    b.className = "btn primary full";
    b.textContent = "Открыть чат";
    b.onclick = () => { closeProfile(); openChat(p.username); };
    actions.appendChild(b);
  } else {
    const b = document.createElement("button");
    b.className = "btn ghost full";
    b.textContent = "Настройки профиля";
    b.onclick = () => { closeProfile(); openSettings(); };
    actions.appendChild(b);
  }
}

function closeProfile() {
  document.getElementById("profileModal").classList.add("hidden");
}

// ================== SETTINGS ==================
function openSettings() {
  document.getElementById("settingsModal").classList.remove("hidden");
  document.getElementById("setDisplayName").value = me.displayName || "";
  document.getElementById("setBio").value = me.bio || "";
  document.getElementById("setBirthDate").value = me.birthDate || "";
  document.getElementById("setAvatarUrl").value = me.avatarUrl || "";
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

async function saveProfile() {
  const displayName = document.getElementById("setDisplayName").value.trim();
  const bio = document.getElementById("setBio").value.trim();
  const birthDate = document.getElementById("setBirthDate").value.trim();
  const avatarUrl = document.getElementById("setAvatarUrl").value.trim();

  const r2 = await fetch("/api/me", {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, bio, birthDate, avatarUrl })
  });
  const d2 = await r2.json();
  if (!d2.ok) return alert(d2.error || "Ошибка сохранения");

  me = d2.profile;
  closeSettings();
  alert("Профиль обновлён ✅");
  updateHeader();
  refreshChats();
}

// ================== VOICE (HOLD) ==================
async function startHoldVoice() {
  if (holding) return;
  holding = true;

  const btn = document.getElementById("voiceBtn");
  btn.classList.add("recording");
  btn.innerHTML = `<i class="fa-solid fa-stop"></i>`;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.start();
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  } catch (err) {
    console.error('Mic access denied');
  }
});

micBtn.addEventListener('mouseup', () => stopRecording());
micBtn.addEventListener('mouseleave', () => stopRecording());
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

async function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('file', blob, 'voice.webm');
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (data.ok) {
        ws.send(JSON.stringify({
          type: 'media-message',
          chatType: currentChat.type,
          receiver: currentChat.type === 'personal' ? currentChat.id : null,
          groupId: currentChat.type === 'group' ? currentChat.id.split(':')[1] : null,
          mediaType: 'audio',
          mediaUrl: data.mediaUrl
        }));
      try {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });

        const fd = new FormData();
        fd.append("file", file);
        fd.append("receiver", currentChat);
        fd.append("text", "");

        const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
        const d = await r.json();
        if (!d.ok) alert(d.error || "Ошибка голосового");
      } finally {
        stream.getTracks().forEach(t => t.stop());
      }
    };

    mediaRecorder.start();
  } catch {
    alert("Не удалось включить микрофон (разрешение?)");
    stopHoldVoice();
  }
}

// WebSocket handlers
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.type) {
    case 'text-message':
    case 'media-message':
      if (currentChat && (data.chatType === currentChat.type && (data.groupId === currentChat.id.split(':')[1] || data.receiver === currentChat.id || data.sender === currentChat.id))) {
        appendMessage(data);
      }
      break;
    case 'typing':
      if (data.chatId === currentChat?.id) {
        chatStatus.textContent = data.typing.length > 0 ? 'Typing...' : '';
      }
      break;
    case 'status':
      if (currentChat?.type === 'personal' && data.username === currentChat.id) {
        chatStatus.textContent = data.status === 'online' ? 'Online' : `Last seen ${data.lastSeen}`;
      }
      break;
    case 'call-offer':
      incomingCallModal.style.display = 'flex';
      document.getElementById('caller').textContent = data.from;
      document.getElementById('accept-call').onclick = () => acceptCall(data);
      document.getElementById('reject-call').onclick = () => rejectCall(data.from);
      break;
    case 'call-answer':
      peerConnection.setRemoteDescription(data.answer);
      break;
    case 'ice':
      peerConnection.addIceCandidate(data.candidate);
      break;
    case 'call-end':
      endCall();
      break;
function stopHoldVoice() {
  if (!holding) return;
  holding = false;

  const btn = document.getElementById("voiceBtn");
  btn.classList.remove("recording");
  btn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
};
}

// Call handling
callBtn.addEventListener('click', startCall);
// ================== STORIES ==================
async function loadStories() {
  const r = await fetch("/api/stories", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  const map = new Map();
  d.stories.forEach(s => { if (!map.has(s.owner)) map.set(s.owner, s); });

  const list = document.getElementById("storiesList");
  list.innerHTML = "";

  [...map.values()].slice(0, 20).forEach(s => {
    const b = document.createElement("button");
    b.className = "storychip";
    b.onclick = () => viewStory(s);
    b.innerHTML = `
      <div class="storyava">${s.avatarUrl ? `<img src="${s.avatarUrl}" alt="">` : `<span>${esc((s.displayName||s.owner)[0].toUpperCase())}</span>`}</div>
      <div class="storyname">${esc((s.displayName || s.owner).split(" ")[0])}</div>
    `;
    list.appendChild(b);
  });
}

async function startCall() {
  peerConnection = new RTCPeerConnection(stunServer);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
function openStoryComposer() {
  document.getElementById("storyModal").classList.remove("hidden");
  document.getElementById("storyFile").value = "";
  document.getElementById("storyText").value = "";
}
function closeStoryComposer() {
  document.getElementById("storyModal").classList.add("hidden");
}

  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate, to: currentChat.id }));
    }
  };
async function publishStory() {
  const file = document.getElementById("storyFile").files[0] || null;
  const text = document.getElementById("storyText").value.trim();
  if (!file && !text) return alert("Добавь файл или текст");

  peerConnection.ontrack = e => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play();
  };
  const fd = new FormData();
  if (file) fd.append("story", file);
  fd.append("text", text);

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'call-offer', offer, to: currentChat.id }));
  const r = await fetch("/api/stories", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка сторис");

  callModal.style.display = 'flex';
  document.getElementById('call-peer').textContent = currentChat.name;
  document.getElementById('end-call').onclick = () => {
    ws.send(JSON.stringify({ type: 'call-end', to: currentChat.id }));
    endCall();
  };
  closeStoryComposer();
  await loadStories();
  alert("Сторис опубликована ✅");
}

async function acceptCall(data) {
  incomingCallModal.style.display = 'none';
  peerConnection = new RTCPeerConnection(stunServer);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
function viewStory(s) {
  let msg = `Сторис @${s.owner}\n`;
  if (s.text) msg += `\n${s.text}\n`;
  alert(msg);
  if (s.mediaUrl) window.open(s.mediaUrl, "_blank");
}

  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate, to: data.from }));
    }
  };
// ================== BIRTHDAYS ==================
async function showBirthdays() {
  const banner = document.getElementById("birthdayBanner");
  const r = await fetch("/api/birthdays/today", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  const list = d.list || [];
  const today = new Date();
  const mm = String(today.getMonth()+1).padStart(2,"0");
  const dd = String(today.getDate()).padStart(2,"0");
  const mine = (me.birthDate || "").slice(5,10) === `${mm}-${dd}`;

  if (!mine && list.length === 0) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }

  peerConnection.ontrack = e => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play();
  };
  banner.classList.remove("hidden");
  const names = list.map(x => x.displayName || x.username).join(", ");
  banner.innerHTML = `
    ${mine ? `🎉 С днём рождения, ${esc(me.displayName || me.username)}!<br>` : ""}
    ${list.length ? `🎂 Сегодня день рождения у: ${esc(names)}` : ""}
  `;
}

  await peerConnection.setRemoteDescription(data.offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'call-answer', answer, to: data.from }));
// ================== AUDIO CALL (WebRTC) ==================
function openIncoming(text){
  document.getElementById("incomingCallText").textContent = text;
  document.getElementById("incomingCallModal").classList.remove("hidden");
}
function closeIncoming(){
  document.getElementById("incomingCallModal").classList.add("hidden");
}

  callModal.style.display = 'flex';
  document.getElementById('call-peer').textContent = data.from;
  document.getElementById('end-call').onclick = () => {
    ws.send(JSON.stringify({ type: 'call-end', to: data.from }));
    endCall();
  };
function openCall(title, status){
  document.getElementById("callTitle").textContent = title;
  document.getElementById("callStatus").textContent = status || "Соединение...";
  document.getElementById("callModal").classList.remove("hidden");
}
function closeCall(){
  document.getElementById("callModal").classList.add("hidden");
}

async function startAudioCall(){
  if (currentChat === "global") return alert("Звонок только в личном чате");
  if (callPeer) return alert("Звонок уже идет");
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");

  callPeer = currentChat;
  openCall(`Аудиозвонок с @${callPeer}`, "Звоним...");

  try{
    await createPeer(callPeer);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type:"call-offer", to: callPeer, offer }));
  }catch{
    alert("Не удалось начать звонок");
    cleanupCall();
  }
}

function rejectCall(from) {
  incomingCallModal.style.display = 'none';
  ws.send(JSON.stringify({ type: 'call-end', to: from }));
async function onIncomingOffer(data){
  if (callPeer) {
    ws.send(JSON.stringify({ type:"call-reject", to: data.from }));
    return;
  }

  incomingFrom = data.from;
  incomingOffer = data.offer;

  openIncoming(`@${incomingFrom} звонит тебе`);
}

function endCall() {
  callModal.style.display = 'none';
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
async function acceptIncomingCall(){
  if(!incomingFrom || !incomingOffer) return;

  closeIncoming();
  callPeer = incomingFrom;
  openCall(`Аудиозвонок с @${callPeer}`, "Подключение...");

  try{
    await createPeer(callPeer);
    await pc.setRemoteDescription(new RTCSessionDescription(incomingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type:"call-answer", to: callPeer, answer }));

    incomingFrom = null;
    incomingOffer = null;
  }catch{
    alert("Не удалось принять звонок");
    cleanupCall();
  }
}

// Other event listeners
backBtn.addEventListener('click', () => sidebar.classList.add('active'));
function declineIncomingCall(){
  if(incomingFrom){
    ws.send(JSON.stringify({ type:"call-reject", to: incomingFrom }));
  }
  incomingFrom = null;
  incomingOffer = null;
  closeIncoming();
}

createGroupBtn.addEventListener('click', () => {
  createGroupModal.style.display = 'flex';
  document.getElementById('create-group-btn').onclick = async () => {
    const name = document.getElementById('group-name').value;
    const desc = document.getElementById('group-desc').value;
    const members = document.getElementById('group-members').value.split(',').map(m => m.trim());
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, description: desc, members })
    });
    const data = await res.json();
    if (data.ok) {
      createGroupModal.style.display = 'none';
      loadChats();
async function onCallAnswer(data){
  if(!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  document.getElementById("callStatus").textContent = "Разговор начался ✅";
}

async function onIce(data){
  if(!pc || !data.candidate) return;
  try{ await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }catch{}
}

function onCallEnd(){
  alert("Звонок завершён");
  cleanupCall();
}
function onCallReject(data){
  alert(`@${data.from} отклонил звонок`);
  cleanupCall();
}

async function createPeer(peer){
  pc = new RTCPeerConnection(rtcCfg);

  remoteStream = new MediaStream();
  document.getElementById("remoteAudio").srcObject = remoteStream;

  // ВАЖНО: на телефоне getUserMedia работает только на HTTPS (Render = ok)
  localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (ev)=>{
    if(ev.candidate){
      ws.send(JSON.stringify({ type:"ice", to: peer, candidate: ev.candidate }));
    }
  };
});

settingsBtn.addEventListener('click', () => {
  loadSessions();
  settingsModal.style.display = 'flex';
  document.getElementById('save-profile').onclick = async () => {
    const formData = new FormData();
    formData.append('displayName', document.getElementById('display-name').value);
    formData.append('bio', document.getElementById('bio').value);
    formData.append('birthDate', document.getElementById('birth-date').value);
    const avatar = document.getElementById('avatar-input').files[0];
    if (avatar) formData.append('avatar', avatar);

    const res = await fetch('/api/me', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: formData

  pc.ontrack = (ev)=>{
    ev.streams[0].getTracks().forEach(t=>{
      if(!remoteStream.getTracks().some(x=>x.id===t.id)) remoteStream.addTrack(t);
    });
    if ((await res.json()).ok) {
      settingsModal.style.display = 'none';
    }
    document.getElementById("callStatus").textContent = "Разговор начался ✅";
  };
  document.getElementById('delete-account').onclick = async () => {
    if (confirm('Delete account?')) {
      const res = await fetch('/api/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if ((await res.json()).ok) {
        localStorage.removeItem('token');
        window.location.href = 'index.html';
      }
    }

  pc.onconnectionstatechange = ()=>{
    const st = pc.connectionState;
    if(st === "connected") document.getElementById("callStatus").textContent = "Разговор начался ✅";
    if(["failed","disconnected","closed"].includes(st)) cleanupCall();
  };
});

// Search users
searchInput.addEventListener('input', async () => {
  const q = searchInput.value;
  const res = await fetch(`/api/users/search?q=${q}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    // Display search results, allow starting chat
  }
});

// Stories
storiesBtn.addEventListener('click', async () => {
  const res = await fetch('/api/stories', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    storiesModal.innerHTML = '<div class="modal-content"><h2>Stories</h2></div>';
    const content = storiesModal.querySelector('.modal-content');
    data.stories.forEach(s => {
      const div = document.createElement('div');
      div.classList.add('story-item');
      div.innerHTML = `<strong>${s.owner}</strong>: ${s.text || ''}`;
      if (s.mediaUrl) {
        if (s.mediaType === 'image') div.innerHTML += `<img src="${s.mediaUrl}" alt="story">`;
        // similar for video
      }
      content.appendChild(div);
    });
    storiesModal.style.display = 'flex';
  }
});

// Add more for group info, profile view, birthdays banner, etc.
chatTitle.addEventListener('click', () => {
  if (currentChat.type === 'personal') {
    // Open profile
    loadUserProfile(currentChat.id);
  } else if (currentChat.type === 'group') {
    // Open group info
    loadGroupInfo(currentChat.id.split(':')[1]);
  }
});

async function loadUserProfile(username) {
  const res = await fetch(`/api/users/${username}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    profileModal.innerHTML = `<div class="modal-content"><h2>${data.user.displayName || data.user.username}</h2><p>${data.user.bio}</p></div>`;
    // Add avatar, birthDate, etc.
    profileModal.style.display = 'flex';
  }
}

async function loadGroupInfo(groupId) {
  const res = await fetch(`/api/groups/${groupId}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    groupInfoModal.innerHTML = `<div class="modal-content"><h2>${data.group.name}</h2><p>${data.group.description}</p></div>`;
    // List members, edit buttons if admin
    groupInfoModal.style.display = 'flex';
  }
function toggleMute(){
  if(!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById("muteBtn").textContent = isMuted ? "Включить микрофон" : "Выключить микрофон";
}

// Birthdays
async function loadBirthdays() {
  const res = await fetch('/api/birthdays/today', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok && data.birthdays.length > 0) {
    // Show banner
    const banner = document.createElement('div');
    banner.classList.add('birthday-banner');
    banner.textContent = `Today's birthdays: ${data.birthdays.map(b => b.displayName).join(', ')}`;
    document.querySelector('.app').prepend(banner);
function endCall(){
  if(callPeer && ws && ws.readyState===1){
    ws.send(JSON.stringify({ type:"call-end", to: callPeer }));
  }
  cleanupCall();
}

loadBirthdays();
function cleanupCall(){
  closeCall();
  closeIncoming();

// Logout
document.getElementById('exit-btn').addEventListener('click', () => {
  localStorage.removeItem('token');
  window.location.href = 'index.html';
});
  try{ pc && pc.close(); }catch{}
  pc = null;

// Close modals on click outside
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.style.display = 'none';
  });
});
  if(localStream) localStream.getTracks().forEach(t=>t.stop());
  localStream = null;

  if(remoteStream) remoteStream.getTracks().forEach(t=>t.stop());
  remoteStream = null;

  callPeer = null;
  incomingFrom = null;
  incomingOffer = null;
  isMuted = false;

  document.getElementById("muteBtn").textContent = "Выключить микрофон";
  document.getElementById("remoteAudio").srcObject = null;
}
