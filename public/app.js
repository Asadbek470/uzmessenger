let socket;
let currentUser = localStorage.getItem('user');

// ФУНКЦИЯ АВТОРИЗАЦИИ
async function handleAuth(type) {
    const username = document.getElementById('userInput').value;
    const password = document.getElementById('passInput').value;

    if (!username || !password) return alert("Fill fields!");

    const res = await fetch(`/api/auth/${type}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (data.success) {
        localStorage.setItem('user', username);
        window.location.href = 'chat.html'; // Переход в чат
    } else {
        alert("Error: " + data.error);
    }
}

// ЗАПИСЬ КРУЖКА (VIDEO NOTE)
async function sendCircle() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];

    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/mp4' });
        const url = await uploadFile(blob);
        socket.send(JSON.stringify({ type: 'circle', url, sender: currentUser }));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 5000); // Запись 5 сек
}

async function uploadFile(blob) {
    const formData = new FormData();
    formData.append('file', blob);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    return data.url;
}
