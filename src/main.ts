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

type Mode = 'terminal' | 'animating' | 'userlist'
let mode: Mode = 'terminal'
let animTimer: ReturnType<typeof setTimeout> | null = null

const ANIMATION_FRAMES: [string, number][] = [
  [`> BOOTING ARPANET...\n> ROUTING PACKETS..\n> BYPASSING AUTH...\n[          ]   0%`, 350],
  [`> BOOTING ARPANET...\n> ROUTING PACKETS..\n> BYPASSING AUTH...\n[###       ]  30%`, 350],
  [`> BOOTING ARPANET...\n> ROUTING PACKETS..\n> BYPASSING AUTH...\n[######    ]  60%`, 350],
  [`> BOOTING ARPANET...\n> ROUTING PACKETS..\n> BYPASSING AUTH...\n[#########]   90%`, 350],
  [`> BOOTING ARPANET...\n> ROUTING PACKETS..\n> BYPASSING AUTH...\n[##########] 100%`, 500],
  [`!!!! BREACH !!!!!\n!!!! BREACH !!!!!\n!!!! BREACH !!!!!\n!!!! BREACH !!!!!`, 200],
  [`\n\n!!!! BREACH !!!!!`, 150],
  [`!!!! BREACH !!!!!\n!!!! BREACH !!!!!\n!!!! BREACH !!!!!\n!!!! BREACH !!!!!`, 150],
  [`\n\n!!!! BREACH !!!!!`, 150],
  [`!!!! BREACH !!!!!\n!!!! BREACH !!!!!\n!!!! BREACH !!!!!\n!!!! BREACH !!!!!`, 300],
  [`\n  ACCESS GRANTED\n  *** TELEHACK ***\n WELCOME, HACKER.`, 600],
  [`\n  ACCESS GRANTED\n  *** TELEHACK ***\n WELCOME, HACKER._`, 400],
  [`\n  ACCESS GRANTED\n  *** TELEHACK ***\n WELCOME, HACKER.`, 400],
  [`\n  ACCESS GRANTED\n  *** TELEHACK ***\n WELCOME, HACKER._`, 400],
]

const USER_LIST =
  `-- FAMOUS USERS --\n` +
  `  Forbin\n` +
  `  Bobbinz\n` +
  `  Underwood\n` +
  `  Egroj\n` +
  `  zcj\n` +
  `  Indygo`

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

function show(content: string) {
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, content }))
}

function setRelayNotification(sender: string, message: string) {
  relayNotification = `[MSG] ${sender}: ${message}`
  if (relayTimer) clearTimeout(relayTimer)
  relayTimer = setTimeout(() => {
    relayNotification = ''
    updateDisplay()
  }, 8000)
}

function updateDisplay() {
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
  show(notify + indicator + visible + current + preview)
}

function clearAnimTimer() {
  if (animTimer) { clearTimeout(animTimer); animTimer = null }
}

function playAnimation() {
  clearAnimTimer()
  mode = 'animating'
  let frame = 0

  function nextFrame() {
    if (mode !== 'animating') return
    if (frame >= ANIMATION_FRAMES.length) {
      mode = 'terminal'
      updateDisplay()
      return
    }
    const [content, delay] = ANIMATION_FRAMES[frame++]
    show(content)
    animTimer = setTimeout(nextFrame, delay)
  }

  nextFrame()
}

function showUserList() {
  clearAnimTimer()
  mode = 'userlist'
  show(USER_LIST)
  animTimer = setTimeout(() => {
    mode = 'terminal'
    updateDisplay()
  }, 8000)
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

  ws.onerror = () => { lines.push('Connection error'); if (mode === 'terminal') updateDisplay() }
  ws.onclose = () => { lines.push('Disconnected - retrying...'); if (mode === 'terminal') updateDisplay(); setTimeout(connect, 3000) }
}

connect()

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    clearAnimTimer()
    ws?.close()
    unsubscribe()
    return
  }

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    playAnimation()
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    showUserList()
    return
  }

  // scrolling only works in terminal mode
  if (mode !== 'terminal') return

  if (sysType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    scrollOffset = Math.min(scrollOffset + VISIBLE_LINES, lines.length - VISIBLE_LINES)
    updateDisplay()
    return
  }

  if (sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    scrollOffset = Math.max(scrollOffset - VISIBLE_LINES, 0)
    updateDisplay()
    return
  }
})
