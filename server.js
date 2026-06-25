import { WebSocketServer } from 'ws'
import net from 'net'

const PORT = process.env.PORT || 8080
const wss = new WebSocketServer({ port: PORT })
console.log(`Server running on port ${PORT}`)

function stripTelnet(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    if (buf[i] === 0xFF) {
      const cmd = buf[i + 1]
      if (cmd === 0xFB || cmd === 0xFC || cmd === 0xFD || cmd === 0xFE) {
        i += 3
      } else if (cmd === 0xFA) {
        i += 2
        while (i < buf.length - 1 && !(buf[i] === 0xFF && buf[i + 1] === 0xF0)) i++
        i += 2
      } else {
        i += 2
      }
    } else {
      out.push(buf[i])
      i++
    }
  }
  return Buffer.from(out).toString('utf8')
}

const clients = new Set()
let socket = null

function broadcast(text) {
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(text)
  }
}

function connectTelehack() {
  console.log('Connecting to Telehack...')
  socket = net.createConnection({ host: 'telehack.com', port: 23 })

  socket.on('connect', () => {
    console.log('Connected to Telehack')
    socket.setNoDelay(true)
    broadcast('\r\n[Connected to Telehack]\r\n')
  })

  socket.on('data', data => {
    const text = stripTelnet(data)
    console.log('RAW:', JSON.stringify(data.slice(0, 40).toString('binary')))
    console.log('STRIPPED:', JSON.stringify(text.slice(0, 80)))
    if (text.length > 0) {
      broadcast(text)
    }
  })

  socket.on('error', err => {
    console.error('Telnet error:', err.message)
  })

  socket.on('close', () => {
    console.log('Telehack connection closed, reconnecting in 3s...')
    broadcast('\r\n[Disconnected from Telehack - reconnecting...]\r\n')
    setTimeout(connectTelehack, 3000)
  })
}

connectTelehack()

wss.on('connection', ws => {
  console.log('Client connected, total:', clients.size + 1)
  clients.add(ws)

  ws.on('message', msg => {
    const text = msg.toString()
    if (text.startsWith('\x00PREVIEW:')) {
      for (const client of clients) {
        if (client !== ws && client.readyState === 1) client.send(text)
      }
    } else if (socket && !socket.destroyed) {
      socket.write(text + '\r\n')
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log('Client disconnected, total:', clients.size)
  })
})
