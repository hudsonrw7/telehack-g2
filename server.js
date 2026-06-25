import { WebSocketServer } from 'ws'
import { Client } from 'ssh2'

const PORT = process.env.PORT || 8080
const TELEHACK_USER = process.env.TELEHACK_USER || 'guest'
const TELEHACK_PASS = process.env.TELEHACK_PASS || ''

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false })
console.log(`Server running on port ${PORT}`)

const clients = new Set()
let sshStream = null

function broadcast(text) {
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(text)
  }
}

function connectTelehack() {
  console.log('Connecting to Telehack via SSH...')
  const conn = new Client()

  conn.on('ready', () => {
    console.log('SSH connected, opening shell...')
    conn.shell({ term: 'vt100', cols: 80, rows: 24 }, (err, stream) => {
      if (err) {
        console.error('Shell error:', err.message)
        conn.end()
        return
      }

      sshStream = stream

      stream.on('data', data => {
        const text = data.toString('utf8')
        broadcast(text)
        // Detect relay messages: lines matching "*username relays* message"
        const lines = text.split(/\r?\n/)
        for (const line of lines) {
          const m = line.match(/^\*(\S+)\s+relays\*\s+(.+)$/i)
          if (m) {
            broadcast(`\x00RELAY:${m[1]}:${m[2].trim()}`)
          }
        }
      })

      stream.on('close', () => {
        console.log('SSH stream closed')
        sshStream = null
        conn.end()
      })
    })
  })

  conn.on('error', err => {
    console.error('SSH error:', err.message)
    sshStream = null
  })

  conn.on('close', () => {
    console.log('SSH connection closed, reconnecting in 3s...')
    sshStream = null
    broadcast('\r\n[Disconnected - reconnecting...]\r\n')
    setTimeout(connectTelehack, 3000)
  })

  conn.connect({
    host: 'telehack.com',
    port: 2222,
    username: TELEHACK_USER,
    password: TELEHACK_PASS,
    readyTimeout: 10000,
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
    } else if (sshStream && !sshStream.destroyed) {
      sshStream.write(text + '\r\n')
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log('Client disconnected, total:', clients.size)
  })
})
