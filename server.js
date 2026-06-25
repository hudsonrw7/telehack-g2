import { WebSocketServer } from 'ws'
import { Client } from 'ssh2'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT || 8080
const TELEHACK_PASS = process.env.TELEHACK_PASS || ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''

// HTTP server serves input.html for the phone
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0]
  if (urlPath === '/' || urlPath === '/input') urlPath = '/index.html'

  // try dist/ first, then project root (for input.html etc.)
  const distFile = path.join(__dirname, 'dist', urlPath)
  const rootFile = path.join(__dirname, urlPath.slice(1))
  const ext = path.extname(urlPath)

  fs.readFile(distFile, (err, data) => {
    if (!err) {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(data)
      return
    }
    fs.readFile(rootFile, (err2, data2) => {
      if (err2) { res.writeHead(404); res.end('Not found'); return }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(data2)
    })
  })
})

httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`))

const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false })

const clients = new Set()
let sshStream = null

function broadcast(text) {
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(text)
  }
}

function buildWav(pcmBuffer) {
  const sampleRate = 16000
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmBuffer.length
  const header = Buffer.alloc(44)

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)           // PCM
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcmBuffer])
}

async function transcribeWithWhisper(pcmBase64) {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set')
    return null
  }

  const pcmBuffer = Buffer.from(pcmBase64, 'base64')
  const wavBuffer = buildWav(pcmBuffer)

  const blob = new Blob([wavBuffer], { type: 'audio/wav' })
  const form = new FormData()
  form.append('file', blob, 'audio.wav')
  form.append('model', 'whisper-1')

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    })
    if (!res.ok) {
      console.error('Whisper API error:', res.status, await res.text())
      return null
    }
    const json = await res.json()
    return json.text?.trim() || null
  } catch (err) {
    console.error('Whisper fetch error:', err.message)
    return null
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
        const lines = text.split(/\r?\n/)
        for (const line of lines) {
          const m = line.match(/^\*(\S+)\s+relays\*\s+(.+)$/i)
          if (m) broadcast(`\x00RELAY:${m[1]}:${m[2].trim()}`)
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
    username: 'guest',
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

  ws.on('message', async msg => {
    const text = msg.toString()
    if (text === '\x00PING') return

    if (text.startsWith('\x00PREVIEW:')) {
      for (const client of clients) {
        if (client !== ws && client.readyState === 1) client.send(text)
      }
    } else if (text.startsWith('\x00PCM_DONE:')) {
      const pcmBase64 = text.slice(10)
      broadcast('\x00TRANSCRIBING:')
      const transcript = await transcribeWithWhisper(pcmBase64)
      if (transcript) {
        console.log('Transcript:', transcript)
        broadcast(`\x00TRANSCRIPT:${transcript}`)
        if (sshStream && !sshStream.destroyed) sshStream.write(transcript + '\r')
      } else {
        broadcast('\x00TRANSCRIPT_ERROR:')
      }
    } else if (text.startsWith('\x00RAW:')) {
      const raw = text.slice(5)
      if (sshStream && !sshStream.destroyed) sshStream.write(raw)
    } else if (sshStream && !sshStream.destroyed) {
      sshStream.write(text + '\r')
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log('Client disconnected, total:', clients.size)
  })
})
