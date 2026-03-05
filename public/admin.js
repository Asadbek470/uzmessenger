async function loadUsers(){

const r=await fetch("/api/admin/users")
const data=await r.json()

data.users.forEach(u=>{

const div=document.createElement("div")
div.innerText=u.username

users.appendChild(div)

})

}

loadUsers()
