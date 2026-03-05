const express = require("express")
const sqlite3 = require("sqlite3").verbose()
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const multer = require("multer")
const cors = require("cors")
const fs = require("fs")
const path = require("path")
const { WebSocketServer } = require("ws")

const PORT = process.env.PORT || 3000
const HOST = "0.0.0.0"
const JWT_SECRET = process.env.JWT_SECRET || "secret"

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static("public"))

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads")

const db = new sqlite3.Database("database.db")

/* ================= DATABASE ================= */

db.serialize(() => {

db.run(`
CREATE TABLE IF NOT EXISTS users(
id INTEGER PRIMARY KEY,
username TEXT UNIQUE,
passwordHash TEXT,
displayName TEXT,
bio TEXT,
avatarUrl TEXT,
birthDate TEXT,
createdAt INTEGER,
lastSeen INTEGER,
blockedUntil INTEGER,
canSendText INTEGER DEFAULT 1,
canSendMedia INTEGER DEFAULT 1,
canCall INTEGER DEFAULT 1
)`)

db.run(`
CREATE TABLE IF NOT EXISTS messages(
id INTEGER PRIMARY KEY,
chatType TEXT,
groupId INTEGER,
user1 TEXT,
user2 TEXT,
sender TEXT,
receiver TEXT,
text TEXT,
mediaType TEXT,
mediaUrl TEXT,
createdAt INTEGER
)`)

db.run(`
CREATE TABLE IF NOT EXISTS stories(
id INTEGER PRIMARY KEY,
owner TEXT,
text TEXT,
mediaType TEXT,
mediaUrl TEXT,
createdAt INTEGER,
expiresAt INTEGER
)`)

db.run(`
CREATE TABLE IF NOT EXISTS sessions(
id INTEGER PRIMARY KEY,
username TEXT,
deviceId TEXT,
deviceName TEXT,
lastUsed INTEGER,
firstSeen INTEGER,
trusted INTEGER
)`)

db.run(`
CREATE TABLE IF NOT EXISTS auth_codes(
id INTEGER PRIMARY KEY,
username TEXT,
deviceId TEXT,
code TEXT,
expiresAt INTEGER,
attempts INTEGER
)`)

db.run(`
CREATE TABLE IF NOT EXISTS groups(
id INTEGER PRIMARY KEY,
name TEXT,
avatarUrl TEXT,
description TEXT,
owner TEXT,
createdAt INTEGER,
updatedAt INTEGER
)`)

db.run(`
CREATE TABLE IF NOT EXISTS group_members(
groupId INTEGER,
username TEXT,
role TEXT,
joinedAt INTEGER
)`)

})

/* ================= AUTH ================= */

function verifyAuth(req,res,next){

const token=req.headers.authorization?.split(" ")[1]
if(!token) return res.json({ok:false,error:"No token"})

try{
const data=jwt.verify(token,JWT_SECRET)
req.user=data.username
next()
}catch{
res.json({ok:false,error:"Invalid token"})
}

}

/* ================= REGISTER ================= */

app.post("/api/auth/register",(req,res)=>{

const {username,password}=req.body

if(!/^[a-z0-9_]{4,20}$/.test(username))
return res.json({ok:false,error:"Invalid username"})

bcrypt.hash(password,10,(err,hash)=>{

db.run(
"INSERT INTO users(username,passwordHash,createdAt) VALUES(?,?,?)",
[username,hash,Date.now()],
(err)=>{
if(err) return res.json({ok:false,error:"User exists"})
res.json({ok:true})
})

})

})

/* ================= LOGIN ================= */

app.post("/api/auth/login",(req,res)=>{

const {identifier,password}=req.body

db.get(
"SELECT * FROM users WHERE username=?",
[identifier],
async (err,user)=>{

if(!user) return res.json({ok:false,error:"User not found"})

const ok=await bcrypt.compare(password,user.passwordHash)
if(!ok) return res.json({ok:false,error:"Wrong password"})

const token=jwt.sign({username:user.username},JWT_SECRET)

res.json({ok:true,token})

})

})

/* ================= PROFILE ================= */

app.get("/api/me",verifyAuth,(req,res)=>{

db.get(
"SELECT username,displayName,bio,avatarUrl,birthDate FROM users WHERE username=?",
[req.user],
(err,row)=>{
res.json({ok:true,user:row})
})

})

app.put("/api/me",verifyAuth,(req,res)=>{

const {displayName,bio,birthDate,avatarUrl}=req.body

db.run(
`UPDATE users
SET displayName=?,bio=?,birthDate=?,avatarUrl=?
WHERE username=?`,
[displayName,bio,birthDate,avatarUrl,req.user],
()=>{
res.json({ok:true})
})

})

/* ================= SEARCH ================= */

app.get("/api/users/search",(req,res)=>{

const q=req.query.q || ""

db.all(
"SELECT username,avatarUrl FROM users WHERE username LIKE ? LIMIT 20",
[`%${q}%`],
(err,rows)=>{
res.json({ok:true,users:rows})
})

})

/* ================= MESSAGES ================= */

app.get("/api/messages",verifyAuth,(req,res)=>{

const chat=req.query.chat

db.all(
"SELECT * FROM messages WHERE user1=? OR user2=? ORDER BY createdAt",
[req.user,req.user],
(err,rows)=>{
res.json({ok:true,messages:rows})
})

})

/* ================= FILE UPLOAD ================= */

const upload=multer({dest:"uploads/"})

app.post("/api/upload",verifyAuth,upload.single("file"),(req,res)=>{

const file=req.file

let type="file"
if(file.mimetype.startsWith("image")) type="image"
if(file.mimetype.startsWith("video")) type="video"
if(file.mimetype.startsWith("audio")) type="audio"

res.json({
ok:true,
url:"/uploads/"+file.filename,
type
})

})

app.use("/uploads",express.static("uploads"))

/* ================= WEBSOCKET ================= */

const server = app.listen(PORT,HOST,()=>{
console.log("Server started",PORT)
})

const wss=new WebSocketServer({server})

const online=new Map()

wss.on("connection",(ws,req)=>{

ws.on("message",(raw)=>{

let data
try{data=JSON.parse(raw)}catch{return}

if(data.type==="auth"){

try{
const decoded=jwt.verify(data.token,JWT_SECRET)
ws.username=decoded.username
online.set(decoded.username,ws)
}catch{}
}

if(data.type==="text-message"){

const msg={
sender:ws.username,
receiver:data.to,
text:data.text,
createdAt:Date.now()
}

db.run(
`INSERT INTO messages(sender,receiver,text,createdAt)
VALUES(?,?,?,?)`,
[msg.sender,msg.receiver,msg.text,msg.createdAt]
)

const target=online.get(data.to)
if(target) target.send(JSON.stringify({type:"message",msg}))

}

})

ws.on("close",()=>{
if(ws.username) online.delete(ws.username)
})

})
