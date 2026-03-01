let currentUser = localStorage.getItem('username');
let activeReceiver = 'global';
let socket;

// 1. АВТОРИЗАЦИЯ И ПОДКЛЮЧЕНИЕ
function initApp() {
    if (!currentUser) {
        window.location.href = 'index.html'; // Если нет юзера, на вход
        return;
    }
    
    // Подключаемся к WebSocket
    socket = new WebSocket(`ws://${window.location.host}`);

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        renderMessage(msg);
    };
}

// 2. ОТПРАВКА ОБЫЧНЫХ СООБЩЕНИЙ (ТЕКСТ)
function sendText() {
    const input = document.getElementById('messageInput');
    if (input.value.trim()) {
        const msgData = {
            type: 'text',
            text: input.value,
            sender: currentUser,
            receiver: activeReceiver,
            timestamp: new Date().toISOString()
        };
        socket.send(JSON.stringify(msgData));
        input.value = '';
    }
}

// 3. ОТПРАВКА ФОТО И ВИДЕО (Через скрепку)
async function uploadMedia(input) {
    const file = input.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    // Загружаем файл на сервер (нужен роут /api/upload в server.js)
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    let type = file.type.startsWith('image') ? 'image' : 'video';
    
    socket.send(JSON.stringify({
        type: type,
        fileUrl: data.url,
        sender: currentUser,
        receiver: activeReceiver
    }));
}

// 4. ГОЛОСОВЫЕ СООБЩЕНИЯ (АУДИО)
let audioRecorder;
let audioChunks = [];

async function startAudioRec() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioRecorder = new MediaRecorder(stream);
    audioChunks = [];
    
    audioRecorder.ondataavailable = e => audioChunks.push(e.data);
    audioRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/ogg' });
        await uploadRecordedFile(blob, 'audio');
    };
    audioRecorder.start();
}

function stopAudioRec() {
    if (audioRecorder) audioRecorder.stop();
}

// 5. ВИДЕО-КРУЖКИ (Video Notes)
let isRecordingCircle = false;
async function toggleCircleRec() {
    const preview = document.getElementById('circlePreview');
    const videoElement = document.getElementById('recordVideo');
    
    if (!isRecordingCircle) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        videoElement.srcObject = stream;
        preview.style.display = 'block';
        
        const recorder = new MediaRecorder(stream);
        let chunks = [];
        
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'video/mp4' });
            await uploadRecordedFile(blob, 'video_note');
            stream.getTracks().forEach(t => t.stop());
            preview.style.display = 'none';
        };
        
        recorder.start();
        isRecordingCircle = recorder;
    } else {
        isRecordingCircle.stop();
        isRecordingCircle = false;
    }
}

// Вспомогательная функция загрузки записанных данных
async function uploadRecordedFile(blob, type) {
    const formData = new FormData();
    formData.append('file', blob, 'record.dat');
    
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    
    socket.send(JSON.stringify({
        type: type,
        fileUrl: data.url,
        sender: currentUser,
        receiver: activeReceiver
    }));
}

// 6. ОТРИСОВКА СООБЩЕНИЙ В ЧАТЕ
function renderMessage(msg) {
    const container = document.getElementById('messagesContainer');
    const side = msg.sender === currentUser ? 'sent' : 'received';
    let content = '';

    switch(msg.type) {
        case 'text': content = `<p>${msg.text}</p>`; break;
        case 'image': content = `<img src="${msg.fileUrl}" class="msg-media">`; break;
        case 'video': content = `<video src="${msg.fileUrl}" controls class="msg-media"></video>`; break;
        case 'audio': content = `<audio src="${msg.fileUrl}" controls></audio>`; break;
        case 'video_note': content = `<video src="${msg.fileUrl}" autoplay loop muted class="circle-msg"></video>`; break;
    }

    const html = `
        <div class="message-row ${side}">
            <div class="bubble">${content}</div>
        </div>
    `;
    container.insertAdjacentHTML('beforeend', html);
    container.scrollTop = container.scrollHeight;
}

initApp();
