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

function esc(s="") {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
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

function shouldRender(msg) {
  if (msg.chatType === "global") return currentChat === "global";
  const other = msg.sender === me.username ? msg.receiver : msg.sender;
  return currentChat === other;
}

// ================== CHAT ==================
async function openChat(chat) {
  currentChat = chat === "global" ? "global" : String(chat).replace(/^@+/, "").toLowerCase();

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
