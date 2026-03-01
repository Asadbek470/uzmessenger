// Основная функция для отправки сообщений (Текст и Медиа)
function sendMessage(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    
    const message = {
        sender: currentUser,
        receiver: activeReceiver, // @username или 'global'
        timestamp: new Date().toISOString(),
        ...data
    };

    socket.send(JSON.stringify(message));
}

// 1. ОТПРАВКА ТЕКСТА
function sendTextMessage() {
    const input = document.getElementById('msgInput');
    if (input.value.trim()) {
        sendMessage({ type: 'text', text: input.value });
        input.value = '';
    }
}

// 2. ОТПРАВКА ФОТО И ВИДЕО (Через скрепку)
async function handleFileUpload(input) {
    const file = input.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    // Сначала загружаем файл на сервер
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    // Определяем тип контента
    let type = 'file';
    if (file.type.startsWith('image')) type = 'image';
    if (file.type.startsWith('video')) type = 'video';

    // Отправляем ссылку на файл в чат
    sendMessage({ type: type, fileUrl: data.url });
}

// 3. ЗАПИСЬ АУДИОСООБЩЕНИЯ (Голосовые)
let audioRecorder;
async function startVoice() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioRecorder = new MediaRecorder(stream);
    const audioChunks = [];

    audioRecorder.ondataavailable = e => audioChunks.push(e.data);
    audioRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/ogg' });
        const formData = new FormData();
        formData.append('file', blob);

        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        sendMessage({ type: 'audio', fileUrl: data.url });
    };
    audioRecorder.start();
}

function stopVoice() {
    if (audioRecorder) audioRecorder.stop();
}

// 4. ЗАПИСЬ КРУЖКА (Video Note)
async function toggleCircleRecord() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const preview = document.getElementById('videoPreview');
    const container = document.getElementById('videoPreviewContainer');
    
    container.style.display = 'block';
    preview.srcObject = stream;

    const recorder = new MediaRecorder(stream);
    const chunks = [];

    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/mp4' });
        const formData = new FormData();
        formData.append('file', blob);

        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        
        sendMessage({ type: 'video_note', fileUrl: data.url });
        container.style.display = 'none';
        stream.getTracks().forEach(track => track.stop());
    };

    recorder.start();
    setTimeout(() => recorder.stop(), 7000); // Кружок на 7 секунд
}

function renderMessage(msg) {
    const container = document.getElementById('messages');
    let content = '';

    if (msg.type === 'text') content = `<p>${msg.text}</p>`;
    if (msg.type === 'image') content = `<img src="${msg.fileUrl}" class="chat-img" onclick="window.open(this.src)">`;
    if (msg.type === 'video') content = `<video src="${msg.fileUrl}" controls class="chat-video"></video>`;
    if (msg.type === 'audio') content = `<audio src="${msg.fileUrl}" controls></audio>`;
    if (msg.type === 'video_note') content = `<video src="${msg.fileUrl}" autoplay loop muted class="video-note-bubble"></video>`;

    const side = msg.sender === currentUser ? 'sent' : 'received';
    container.innerHTML += `
        <div class="message-row ${side}">
            <div class="bubble">${content}</div>
        </div>
    `;
    container.scrollTop = container.scrollHeight;
}
