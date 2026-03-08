const token = localStorage.getItem("token");
let currentUser = null;

async function searchUser() {
    const username = document.getElementById("searchUser").value.replace("@", "");
    if (!username) return;

    const res = await fetch(`/api/users/${username}`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    const data = await res.json();

    if (!data.ok) {
        alert("Пользователь не найден");
        return;
    }

    const user = data.user;
    currentUser = user.username;

    document.getElementById("userCard").classList.remove("hidden");
    document.getElementById("userName").innerText = user.displayName || user.username;
    document.getElementById("userUsername").innerText = "@" + user.username;
    document.getElementById("userBio").innerText = user.bio || "";
    document.getElementById("userAvatar").src = user.avatarUrl || "https://via.placeholder.com/80";
}

async function banUser() {
    if (!confirm("Забанить пользователя?")) return;
    await fetch(`/api/admin/ban/${currentUser}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
    });
    alert("Пользователь забанен");
}

async function unbanUser() {
    await fetch(`/api/admin/unban/${currentUser}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
    });
    alert("Пользователь разбанен");
}

async function muteUser() {
    await fetch(`/api/admin/mute/${currentUser}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
    });
    alert("Пользователь замучен");
}

async function unmuteUser() {
    await fetch(`/api/admin/unmute/${currentUser}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
    });
    alert("Пользователь размучен");
}

async function deleteUser() {
    if (!confirm("Удалить аккаунт навсегда?")) return;
    await fetch(`/api/admin/delete/${currentUser}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
    });
    alert("Аккаунт удалён");
}
