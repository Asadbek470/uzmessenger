let socket;
const user = localStorage.getItem('username');

// Авторизация
function login() {
    const input = document.getElementById('usernameInput');
    if (input.value.trim()) {
        localStorage.setItem('username', input.value.trim());
        window.location.href = 'chat.html';
    }
}

// Работа чата
if (window.location.pathname.includes('chat.html')) {
    if (!user) window.location.href = 'index.html';

    // Инициализация WS
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}`);

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        renderMessage(data);
    };

    // История
    fetch('/api/messages').then(r => r.json()).then(msgs => {
        msgs.forEach(renderMessage);
    });

    // Отправка
    document.getElementById('sendBtn').onclick = sendMessage;
    document.getElementById('msgInput').onkeypress = (e) => { if(e.key === 'Enter') sendMessage(); };
}

function sendMessage() {
    const input = document.getElementById('msgInput');
    if (input.value.trim() && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'chat',
            sender: user,
            text: input.value.trim()
        }));
        input.value = '';
    }
}

function renderMessage(data) {
    const box = document.getElementById('messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = `bubble ${data.sender === user ? 'sent' : 'received'}`;
    div.innerHTML = `<small style="display:block; color:#888">${data.sender}</small>${data.text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function toggleSidebar(show) {
    document.getElementById('sidebar').classList.toggle('open', show);
}
