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

type Mode = 'terminal' | 'menu1' | 'menu2'
let mode: Mode = 'terminal'
let menuIndex = 0

const MENU1_ITEMS = ['login', 'w', 'relay', 'send', 'porthack']
const MENU2_ITEMS = ['talk to type', 'wardial', 'score /badge', 'space', 'ctrl+c']

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
  content: lines.join('\n'),
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

function updateDisplay() {
  let content: string

  if (mode === 'menu1' || mode === 'menu2') {
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
    const scrolled = scrollOffset > 0
    const indicator = scrolled ? `[+${scrollOffset}${hasNewContent ? ' NEW↓' : ''}]\n` : ''
    const current = currentLine.trim() ? `\n${currentLine.trim()}` : ''
    const preview = inputPreview ? `\n> ${inputPreview}` : ''
    const notify = relayNotification ? `${relayNotification}\n` : ''
    content = notify + indicator + visible + current + preview
  }

  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, content }))
}

function selectMenuItem() {
  const items = mode === 'menu1' ? MENU1_ITEMS : MENU2_ITEMS
  const selected = items[menuIndex]

  if (selected === 'talk to type') {
    ws?.send('\x00VOICE:')
  } else if (selected === 'space') {
    ws?.send('\x00RAW: ')
  } else if (selected === 'ctrl+c') {
    ws?.send('\x00RAW:\x03')
  } else {
    ws?.send(selected)
  }

  mode = 'terminal'
  menuIndex = 0
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
  const type = sysType ?? textType

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    ws?.close()
    unsubscribe()
    return
  }

  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (mode !== 'terminal') {
      // close whichever menu is open
      mode = 'terminal'
      menuIndex = 0
    } else {
      // open menu2 from terminal
      mode = 'menu2'
      menuIndex = 0
    }
    updateDisplay()
    return
  }

  if (type === OsEventTypeList.CLICK_EVENT) {
    if (mode === 'terminal') {
      mode = 'menu1'
      menuIndex = 0
      updateDisplay()
    } else {
      selectMenuItem()
    }
    return
  }

  if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (mode !== 'terminal') {
      menuIndex = Math.max(menuIndex - 1, 0)
    } else {
      scrollOffset = Math.min(scrollOffset + VISIBLE_LINES, lines.length - VISIBLE_LINES)
    }
    updateDisplay()
    return
  }

  if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (mode !== 'terminal') {
      const items = mode === 'menu1' ? MENU1_ITEMS : MENU2_ITEMS
      menuIndex = Math.min(menuIndex + 1, items.length - 1)
    } else {
      scrollOffset = Math.max(scrollOffset - VISIBLE_LINES, 0)
    }
    updateDisplay()
    return
  }
})
