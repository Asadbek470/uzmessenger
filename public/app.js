let socket;
let currentUser = localStorage.getItem("user");
let currentChat = "global";

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let currentCallPeer = null;

let pendingIncomingOffer = null;
let pendingIncomingFrom = null;

let isMuted = false;
let cameraOn = false;

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

if (!currentUser) window.location.href = "index.html";

function headers() { return { "x-user": currentUser }; }

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/* ---------------- INIT ---------------- */

function initChat() {
  connectWS();
  loadChatList();
  loadMessages("global");

  const input = document.getElementById("messageInput");
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") sendText();
  });

  if (window.innerWidth > 768)
    document.getElementById("sidebar")?.classList.remove("active-mobile");
}

/* ---------------- WEBSOCKET ---------------- */

function connectWS() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}?user=${currentUser}`);

  socket.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "call-offer") return onIncomingOffer(msg);
    if (msg.type === "call-answer") return onCallAnswer(msg);
    if (msg.type === "ice-candidate") return onIce(msg);
    if (msg.type === "call-end") return cleanupCall();
    if (msg.type === "messageDeleted") {
      document.querySelector(`[data-message-id="${msg.id}"]`)?.remove();
      return;
    }

    if (msg.type !== "message") return;

    const to = msg.receiver || msg.to || "global";

    if (to === "global" && currentChat === "global") renderMessage(msg);

    if (to !== "global") {
      const visible =
        (msg.sender === currentChat && to === currentUser) ||
        (msg.sender === currentUser && to === currentChat);

      if (visible) renderMessage(msg);
    }

    loadChatList();
  };
}

/* ---------------- CHAT ---------------- */

async function loadMessages(chatName) {
  const container = document.getElementById("messagesContainer");
  container.innerHTML = "";

  const res = await fetch(`/api/messages?chat=${chatName}`, { headers: headers() });
  const messages = await res.json();
  messages.forEach(renderMessage);
  scrollBottom();
}

function renderMessage(msg) {
  const container = document.getElementById("messagesContainer");
  const mine = msg.sender === currentUser;

  let content = "";

  if (msg.mediaType === "image") {
    content = `<img class="msg-image" src="${msg.mediaUrl}">`;
  } else if (msg.mediaType === "video") {
    content = `<video class="msg-video" controls playsinline src="${msg.mediaUrl}"></video>`;
  } else if (msg.mediaType === "audio") {
    content = `<audio controls src="${msg.mediaUrl}"></audio>`;
  } else {
    content = `<div>${escapeHtml(msg.text)}</div>`;
  }

  const row = document.createElement("div");
  row.className = `message-row ${mine ? "mine" : "other"}`;
  row.dataset.messageId = msg.id;

  row.innerHTML = `
    <div class="bubble">
      ${content}
      ${mine ? `<button onclick="deleteMessage(${msg.id})">🗑</button>` : ""}
    </div>
  `;

  container.appendChild(row);
  scrollBottom();
}

function scrollBottom() {
  const c = document.getElementById("messagesContainer");
  c.scrollTop = c.scrollHeight;
}

function sendText() {
  const input = document.getElementById("messageInput");
  const text = input.value.trim();
  if (!text) return;

  socket.send(JSON.stringify({
    type: "text",
    text,
    sender: currentUser,
    receiver: currentChat
  }));

  input.value = "";
}

async function deleteMessage(id) {
  await fetch(`/api/messages/${id}`, { method: "DELETE", headers: headers() });
}

/* ---------------- VOICE ---------------- */

async function toggleAudioRec() {
  if (isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: "audio/webm" });
    const file = new File([blob], "voice.webm");

    const fd = new FormData();
    fd.append("file", file);
    fd.append("receiver", currentChat);

    await fetch("/api/upload", {
      method: "POST",
      headers: headers(),
      body: fd
    });

    stream.getTracks().forEach(t => t.stop());
  };

  mediaRecorder.start();
  isRecording = true;
}

/* ---------------- CALLS ---------------- */

async function ensureLocalStream() {
  if (localStream) return localStream;

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  const localVideo = document.getElementById("localVideo");
  localVideo.muted = true;
  localVideo.playsInline = true;
  localVideo.autoplay = true;
  localVideo.srcObject = localStream;

  return localStream;
}

async function createPeer(peer) {
  currentCallPeer = peer;
  peerConnection = new RTCPeerConnection(rtcConfig);

  await ensureLocalStream();

  localStream.getTracks().forEach(t =>
    peerConnection.addTrack(t, localStream)
  );

  peerConnection.onicecandidate = e => {
    if (!e.candidate) return;
    socket.send(JSON.stringify({
      type: "ice-candidate",
      to: peer,
      from: currentUser,
      candidate: e.candidate
    }));
  };

  peerConnection.ontrack = async (e) => {
    const remoteVideo = document.getElementById("remoteVideo");
    remoteVideo.srcObject = e.streams[0];
    try { await remoteVideo.play(); } catch {}
  };
}

async function startCall() {
  await createPeer(currentChat);

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.send(JSON.stringify({
    type: "call-offer",
    to: currentChat,
    from: currentUser,
    offer
  }));

  document.getElementById("activeCallModal").style.display = "flex";
}

async function onIncomingOffer(msg) {
  pendingIncomingFrom = msg.from;
  pendingIncomingOffer = msg.offer;
  document.getElementById("incomingCallModal").style.display = "flex";
}

async function acceptIncomingCall() {
  document.getElementById("incomingCallModal").style.display = "none";

  await createPeer(pendingIncomingFrom);
  await peerConnection.setRemoteDescription(
    new RTCSessionDescription(pendingIncomingOffer)
  );

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.send(JSON.stringify({
    type: "call-answer",
    to: pendingIncomingFrom,
    from: currentUser,
    answer
  }));

  document.getElementById("activeCallModal").style.display = "flex";
}

function onCallAnswer(msg) {
  peerConnection.setRemoteDescription(
    new RTCSessionDescription(msg.answer)
  );
}

function onIce(msg) {
  peerConnection.addIceCandidate(
    new RTCIceCandidate(msg.candidate)
  );
}

async function toggleCamera() {
  if (!peerConnection) return;

  if (!cameraOn) {
    const vStream = await navigator.mediaDevices.getUserMedia({ video: true });
    const videoTrack = vStream.getVideoTracks()[0];

    const sender = peerConnection.getSenders().find(
      s => s.track?.kind === "video"
    );

    if (sender) {
      await sender.replaceTrack(videoTrack);
    } else {
      peerConnection.addTrack(videoTrack, localStream);
    }

    localStream.addTrack(videoTrack);

    const localVideo = document.getElementById("localVideo");
    localVideo.srcObject = localStream;
    await localVideo.play();

    cameraOn = true;
    return;
  }

  const sender = peerConnection.getSenders().find(
    s => s.track?.kind === "video"
  );

  if (sender) await sender.replaceTrack(null);

  localStream.getVideoTracks().forEach(t => {
    t.stop();
    localStream.removeTrack(t);
  });

  cameraOn = false;
}

function toggleMuteCall() {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
}

function endCurrentCall() {
  socket.send(JSON.stringify({
    type: "call-end",
    to: currentCallPeer,
    from: currentUser
  }));
  cleanupCall();
}

function cleanupCall() {
  peerConnection?.close();
  peerConnection = null;

  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  document.getElementById("activeCallModal").style.display = "none";

  cameraOn = false;
  isMuted = false;
}
