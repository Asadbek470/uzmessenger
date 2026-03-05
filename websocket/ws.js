const WebSocket = require("ws")

const online = new Map()

function init(server){

const wss = new WebSocket.Server({server})

function sendTo(username,data){

const ws = online.get(username)

if(ws) ws.send(JSON.stringify(data))

}

wss.on("connection",ws=>{

let user=null

ws.on("message",raw=>{

const data = JSON.parse(raw)

if(data.type==="auth"){
user=data.username
online.set(user,ws)
}

if(data.type==="typing"){
sendTo(data.to,data)
}

})

ws.on("close",()=>{

if(user) online.delete(user)

})

})

return {sendTo}

}

module.exports={init}
