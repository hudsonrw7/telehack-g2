import { WebSocketServer } from 'ws'
import net from 'net'

const PORT = process.env.PORT || 8080
const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false })
console.log(`Server running on port ${PORT}`)

// Telnet constants
const IAC  = 0xFF
const WILL = 0xFB
const WONT = 0xFC
const DO   = 0xFD
const DONT = 0xFE
const SB   = 0xFA
const SE   = 0xF0
const ECHO        = 0x01
const SGA         = 0x03 // suppress go ahead
const TERM_TYPE   = 0x18
const NAWS        = 0x1F
const NEW_ENVIRON = 0x27

function processTelnet(buf, socket) {
  const out = []
  let i = 0
  while (i < buf.length) {
    if (buf[i] !== IAC) { out.push(buf[i++]); continue }
    const cmd = buf[i + 1]
    if (cmd === SB) {
      // skip subnegotiation until IAC SE
      i += 2
      while (i < buf.length - 1 && !(buf[i] === IAC && buf[i + 1] === SE)) i++
      i += 2
    } else if (cmd === WILL) {
      const opt = buf[i + 2]
      if (opt === ECHO || opt === SGA) {
        socket.write(Buffer.from([IAC, DO, opt]))   // agree to server echo/sga
      } else {
        socket.write(Buffer.from([IAC, DONT, opt])) // refuse others
      }
      i += 3
    } else if (cmd === DO) {
      const opt = buf[i + 2]
      if (opt === NAWS) {
        // send window size: 80x24
        socket.write(Buffer.from([IAC, WILL, NAWS]))
        socket.write(Buffer.from([IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE]))
      } else if (opt === TERM_TYPE) {
        socket.write(Buffer.from([IAC, WILL, TERM_TYPE]))
        socket.write(Buffer.from([IAC, SB, TERM_TYPE, 0, ...Buffer.from('VT100'), IAC, SE]))
      } else {
        socket.write(Buffer.from([IAC, WONT, opt]))
      }
      i += 3
    } else if (cmd === WONT || cmd === DONT) {
      i += 3
    } else {
      i += 2
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
  })

  socket.on('data', data => {
    const text = processTelnet(data, socket)
    if (text.length > 0) {
      broadcast(text)
    }
  })

  socket.on('error', err => {
    console.error('Telnet error:', err.message)
  })

  socket.on('close', () => {
    console.log('Telehack connection closed, reconnecting in 3s...')
    broadcast('\r\n[Disconnected - reconnecting...]\r\n')
    setTimeout(connectTelehack, 3000)
  })
}

connectTelehack()

setInterval(() => {
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send('\x00PING')
  }
}, 1000)

wss.on('connection', ws => {
  console.log('Client connected, total:', clients.size + 1)
  clients.add(ws)

  ws.on('message', msg => {
    const text = msg.toString()
    if (text === '\x00PING') return
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
