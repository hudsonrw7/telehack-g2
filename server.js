import { WebSocketServer } from 'ws'
import net from 'net'

const PORT = process.env.PORT || 8080
const TELEHACK_USER = process.env.TELEHACK_USER || ''
const TELEHACK_PASS = process.env.TELEHACK_PASS || ''

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false })
console.log(`Server running on port ${PORT}`)

const IAC  = 0xFF
const WILL = 0xFB
const WONT = 0xFC
const DO   = 0xFD
const DONT = 0xFE
const SB   = 0xFA
const SE   = 0xF0

function processTelnet(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    if (buf[i] !== IAC) { out.push(buf[i++]); continue }
    const cmd = buf[i + 1]
    if (cmd === SB) {
      i += 2
      while (i < buf.length - 1 && !(buf[i] === IAC && buf[i + 1] === SE)) i++
      i += 2
    } else if (cmd === WILL || cmd === DO || cmd === WONT || cmd === DONT) {
      i += 3
    } else {
      i += 2
    }
  }
  return Buffer.from(out).toString('utf8')
}

const clients = new Set()
let socket = null
let loginState = 'waiting' // 'waiting' | 'sent_user' | 'sent_pass' | 'done'
let outputBuffer = ''

function broadcast(text) {
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(text)
  }
}

function handleAutoLogin(text) {
  if (!TELEHACK_USER || !TELEHACK_PASS) return
  outputBuffer += text.toLowerCase()
  // keep buffer small
  if (outputBuffer.length > 500) outputBuffer = outputBuffer.slice(-500)

  if (loginState === 'waiting' && outputBuffer.includes('login:')) {
    console.log('Auto-login: sending username')
    socket.write(TELEHACK_USER + '\r\n')
    loginState = 'sent_user'
    outputBuffer = ''
  } else if (loginState === 'sent_user' && outputBuffer.includes('assword:')) {
    console.log('Auto-login: sending password')
    socket.write(TELEHACK_PASS + '\r\n')
    loginState = 'sent_pass'
    outputBuffer = ''
  } else if (loginState === 'sent_pass' && outputBuffer.includes('@')) {
    console.log('Auto-login: logged in as', TELEHACK_USER)
    loginState = 'done'
    outputBuffer = ''
  }
}

function connectTelehack() {
  console.log('Connecting to Telehack...')
  loginState = 'waiting'
  outputBuffer = ''
  socket = net.createConnection({ host: 'telehack.com', port: 23 })

  socket.on('connect', () => {
    console.log('Connected to Telehack')
    socket.setNoDelay(true)
  })

  socket.on('data', data => {
    const text = processTelnet(data)
    if (text.length > 0) {
      handleAutoLogin(text)
      broadcast(text)
      // Detect relay messages: lines matching "*username relays* message"
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        const m = line.match(/^\*(\S+)\s+relays\*\s+(.+)$/i)
        if (m) {
          broadcast(`\x00RELAY:${m[1]}:${m[2].trim()}`)
        }
      }
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
