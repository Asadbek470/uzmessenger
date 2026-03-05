const express = require("express")
const http = require("http")
const cors = require("cors")

const {PORT,HOST} = require("./config/config")

const auth = require("./auth/auth")
const messages = require("./messages/messages")
const users = require("./users/users")
const sessions = require("./sessions/sessions")
const groups = require("./groups/groups")

const {init} = require("./websocket/ws")

const app = express()

app.use(cors())
app.use(express.json())
app.use(express.static("public"))

app.post("/api/auth/register",auth.register)
app.post("/api/auth/login",auth.login)

app.post("/api/messages/send",messages.sendMessage)
app.get("/api/messages",messages.getMessages)

app.post("/api/users/block",users.blockUser)

app.get("/api/sessions",sessions.listSessions)
app.post("/api/sessions/logoutAll",sessions.logoutAll)

app.post("/api/groups/create",groups.createGroup)

const server = http.createServer(app)

init(server)

server.listen(PORT,HOST,()=>{

console.log("One Messenger running on",PORT)

})
