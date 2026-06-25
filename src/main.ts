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
let scrollOffset = 0 // 0 = bottom (newest), positive = scrolled up
let inputPreview = ''
let currentLine = ''

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

let hasNewContent = false

function updateDisplay() {
  const total = lines.length
  const end = Math.max(total - scrollOffset, 0)
  const reservedLines = (inputPreview ? 1 : 0) + (currentLine.trim() ? 1 : 0)
  const visibleCount = Math.max(VISIBLE_LINES - reservedLines, 1)
  const start = Math.max(end - visibleCount, 0)
  const visible = lines.slice(start, end).join('\n')
  const scrolled = scrollOffset > 0
  const indicator = scrolled ? `[+${scrollOffset}${hasNewContent ? ' NEW↓' : ''}]\n` : ''
  const current = currentLine.trim() ? `\n${currentLine.trim()}` : ''
  const preview = inputPreview ? `\n> ${inputPreview}` : ''
  bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 1,
    content: indicator + visible + current + preview,
  }))
}

function processOutput(raw: string) {
  const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '\r' && cleaned[i + 1] === '\n') {
      // \r\n = commit line
      const trimmed = currentLine.replace(/  +/g, ' ').trim()
      if (trimmed) lines.push(trimmed)
      currentLine = ''
      i++ // skip \n
    } else if (ch === '\r') {
      // bare \r = overwrite current line (animation frame)
      currentLine = ''
    } else if (ch === '\n') {
      // commit line
      const trimmed = currentLine.replace(/  +/g, ' ').trim()
      if (trimmed) lines.push(trimmed)
      currentLine = ''
    } else {
      currentLine += ch
    }
  }

  if (lines.length > 500) lines = lines.slice(-500)

  // auto-scroll back to bottom when prompt appears (command finished)
  const lastLine = lines[lines.length - 1] ?? ''
  if (lastLine.trim() === '@' || lastLine.trim().endsWith('@')) {
    scrollOffset = 0
    hasNewContent = false
  } else if (scrollOffset > 0) {
    hasNewContent = true
  }

  if (scrollOffset === 0) {
    hasNewContent = false
    updateDisplay()
  } else {
    updateDisplay() // still update to show NEW↓ indicator
  }
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
      updateDisplay()
    } else {
      processOutput(text)
    }
  }

  ws.onerror = () => {
    lines.push('Connection error - retrying...')
    updateDisplay()
  }

  ws.onclose = () => {
    lines.push('Disconnected - reconnecting in 3s...')
    updateDisplay()
    setTimeout(connect, 3000)
  }
}

connect()

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    ws?.close()
    bridge.shutDownPageContainer(1)
    return
  }

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

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    scrollOffset = Math.min(scrollOffset + VISIBLE_LINES, lines.length - VISIBLE_LINES)
    updateDisplay()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    ws?.close()
    unsubscribe()
  }
})
