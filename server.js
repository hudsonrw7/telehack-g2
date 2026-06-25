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

// One shared telnet connection, broadcast to all WebSocket clients
const clients = new Set()

const socket = net.createConnection({ host: 'telehack.com', port: 23 })

socket.on('connect', () => {
  console.log('Connected to Telehack')
})

socket.on('data', data => {
  const text = stripTelnet(data)
  if (text.length > 0) {
    console.log('Telehack:', JSON.stringify(text))
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(text)
    }
  }
})

socket.on('error', err => {
  console.error('Telnet error:', err.message)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send('TELNET ERROR: ' + err.message)
  }
})

wss.on('connection', ws => {
  console.log('Client connected, total:', clients.size + 1)
  clients.add(ws)

  ws.on('message', msg => {
    const text = msg.toString()
    if (text.startsWith('\x00PREVIEW:')) {
      // relay preview to all other clients (glasses), don't send to telehack
      for (const client of clients) {
        if (client !== ws && client.readyState === 1) client.send(text)
      }
    } else {
      socket.write(text + '\r\n')
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log('Client disconnected, total:', clients.size)
  })
})
