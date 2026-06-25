import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()

const VISIBLE_LINES = 6
let lines: string[] = ['Connecting to Telehack...']
let scrollOffset = 0
let inputPreview = ''
let currentLine = ''
let hasNewContent = false
let relayNotification = ''
let relayTimer: ReturnType<typeof setTimeout> | null = null

type Mode = 'terminal' | 'menu1' | 'menu2' | 'recording' | 'processing'
let mode: Mode = 'terminal'
let menuIndex = 0

const MENU1_ITEMS = ['login', 'w', 'relay', 'send', 'porthack']
const MENU2_ITEMS = ['talk to type', 'wardial', 'score /badge', 'space', 'ctrl+c']

let pcmChunks: number[] = []

const textContainer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: 'Connecting...',
  isEventCapture: 1,
})

await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [textContainer],
  })
)

function setRelayNotification(sender: string, message: string) {
  relayNotification = `[MSG] ${sender}: ${message}`
  if (relayTimer) clearTimeout(relayTimer)
  relayTimer = setTimeout(() => {
    relayNotification = ''
    updateDisplay()
  }, 8000)
}

function uint8ToBase64(u8: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i])
  return btoa(binary)
}

function updateDisplay() {
  let content: string

  if (mode === 'recording') {
    content = '◉ RECORDING\nTap to stop'
  } else if (mode === 'processing') {
    content = '◌ PROCESSING...\nPlease wait'
  } else if (mode === 'menu1' || mode === 'menu2') {
    const items = mode === 'menu1' ? MENU1_ITEMS : MENU2_ITEMS
    const label = mode === 'menu1' ? '--- COMMANDS ---' : '--- ACTIONS ---'
    const rows = items.map((item, i) =>
      (i === menuIndex ? '> ' : '  ') + item.toUpperCase()
    )
    content = label + '\n' + rows.join('\n')
  } else {
    const total = lines.length
    const end = Math.max(total - scrollOffset, 0)
    const reservedLines = (inputPreview ? 1 : 0) + (currentLine.trim() ? 1 : 0) + (relayNotification ? 1 : 0)
    const visibleCount = Math.max(VISIBLE_LINES - reservedLines, 1)
    const start = Math.max(end - visibleCount, 0)
    const visible = lines.slice(start, end).join('\n')
    const indicator = scrollOffset > 0 ? `[+${scrollOffset}${hasNewContent ? ' NEW↓' : ''}]\n` : ''
    const current = currentLine.trim() ? `\n${currentLine.trim()}` : ''
    const preview = inputPreview ? `\n> ${inputPreview}` : ''
    const notify = relayNotification ? `${relayNotification}\n` : ''
    content = notify + indicator + visible + current + preview
  }

  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, content }))
}

async function startRecording() {
  pcmChunks = []
  const ok = await bridge.audioControl(true)
  if (!ok) {
    lines.push('Mic unavailable')
    updateDisplay()
    return
  }
  mode = 'recording'
  updateDisplay()
}

async function stopRecording() {
  await bridge.audioControl(false)
  mode = 'processing'
  updateDisplay()

  if (pcmChunks.length === 0) {
    mode = 'terminal'
    updateDisplay()
    return
  }

  const pcmBase64 = uint8ToBase64(new Uint8Array(pcmChunks))
  ws?.send(`\x00PCM_DONE:${pcmBase64}`)
  pcmChunks = []
}

function selectMenuItem() {
  const items = mode === 'menu1' ? MENU1_ITEMS : MENU2_ITEMS
  const selected = items[menuIndex]
  mode = 'terminal'
  menuIndex = 0

  if (selected === 'talk to type') {
    startRecording()
    return
  } else if (selected === 'space') {
    ws?.send('\x00RAW: ')
  } else if (selected === 'ctrl+c') {
    ws?.send('\x00RAW:\x03')
  } else {
    ws?.send(selected)
  }

  updateDisplay()
}

function processOutput(raw: string) {
  const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '\r' && cleaned[i + 1] === '\n') {
      const trimmed = currentLine.replace(/  +/g, ' ').trim()
      if (trimmed) lines.push(trimmed)
      currentLine = ''
      i++
    } else if (ch === '\r') {
      currentLine = ''
    } else if (ch === '\n') {
      const trimmed = currentLine.replace(/  +/g, ' ').trim()
      if (trimmed) lines.push(trimmed)
      currentLine = ''
    } else {
      currentLine += ch
    }
  }

  if (lines.length > 500) lines = lines.slice(-500)

  const lastLine = lines[lines.length - 1] ?? ''
  if (lastLine.trim() === '@' || lastLine.trim().endsWith('@')) {
    scrollOffset = 0
    hasNewContent = false
  } else if (scrollOffset > 0) {
    hasNewContent = true
  }

  if (scrollOffset === 0) hasNewContent = false
  if (mode === 'terminal') updateDisplay()
}

let ws: WebSocket

function connect() {
  ws = new WebSocket('wss://telehack-g2-production.up.railway.app')

  ws.onopen = () => {
    lines.push('Connected to Telehack.')
    updateDisplay()
    setInterval(() => { if (ws.readyState === 1) ws.send('\x00PING') }, 1000)
  }

  ws.onmessage = (event) => {
    const text: string = event.data
    if (text === '\x00PING') return
    if (text.startsWith('\x00PREVIEW:')) {
      inputPreview = text.slice(9)
      if (mode === 'terminal') updateDisplay()
    } else if (text.startsWith('\x00RELAY:')) {
      const rest = text.slice(7)
      const colon = rest.indexOf(':')
      setRelayNotification(rest.slice(0, colon), rest.slice(colon + 1))
      updateDisplay()
    } else if (text === '\x00TRANSCRIBING:') {
      mode = 'processing'
      updateDisplay()
    } else if (text.startsWith('\x00TRANSCRIPT:')) {
      const transcript = text.slice(12)
      lines.push(`> ${transcript}`)
      mode = 'terminal'
      scrollOffset = 0
      updateDisplay()
    } else if (text === '\x00TRANSCRIPT_ERROR:') {
      lines.push('[Voice: error]')
      mode = 'terminal'
      updateDisplay()
    } else {
      processOutput(text)
    }
  }

  ws.onerror = () => {
    lines.push('Connection error - retrying...')
    if (mode === 'terminal') updateDisplay()
  }

  ws.onclose = () => {
    lines.push('Disconnected - reconnecting in 3s...')
    if (mode === 'terminal') updateDisplay()
    setTimeout(connect, 3000)
  }
}

connect()

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    ws?.close()
    unsubscribe()
    return
  }

  if (mode === 'recording' && event.audioEvent?.audioPcm) {
    pcmChunks.push(...event.audioEvent.audioPcm)
    return
  }

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (mode === 'menu1' || mode === 'menu2') {
      mode = 'terminal'
      menuIndex = 0
    } else if (mode === 'terminal') {
      mode = 'menu2'
      menuIndex = 0
    }
    updateDisplay()
    return
  }

  if (sysType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (mode === 'menu1' || mode === 'menu2') {
      menuIndex = Math.max(menuIndex - 1, 0)
    } else if (mode === 'terminal') {
      scrollOffset = Math.min(scrollOffset + VISIBLE_LINES, lines.length - VISIBLE_LINES)
    }
    updateDisplay()
    return
  }

  if (sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (mode === 'menu1' || mode === 'menu2') {
      const items = mode === 'menu1' ? MENU1_ITEMS : MENU2_ITEMS
      menuIndex = Math.min(menuIndex + 1, items.length - 1)
    } else if (mode === 'terminal') {
      scrollOffset = Math.max(scrollOffset - VISIBLE_LINES, 0)
    }
    updateDisplay()
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (mode === 'recording') {
      stopRecording()
    } else if (mode === 'terminal') {
      mode = 'menu1'
      menuIndex = 0
      updateDisplay()
    } else if (mode === 'menu1' || mode === 'menu2') {
      selectMenuItem()
    }
    return
  }
})
