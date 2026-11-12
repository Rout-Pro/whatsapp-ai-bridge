import http from 'node:http'
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import pino from 'pino'

// ---------- config (all via env, no secrets in code) ----------
const PORT = process.env.PORT || 10000
const BOT_NUMBER = (process.env.BOT_NUMBER || '').replace(/\D/g, '') // bot's WhatsApp number, e.g. 91XXXXXXXXXX
const TESTER_NUMBER = (process.env.TESTER_NUMBER || '').replace(/\D/g, '') // required: only this number gets replies
const REPLIES_ENABLED = (process.env.REPLIES_ENABLED || 'false').toLowerCase() === 'true'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash'
const AI_DISCLAIMER = '[AI bot] '

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

let sock = null
let waState = 'starting'
let lastPairingCode = null
let lastPairingAt = 0

// ---------- Gemini ----------
async function geminiReply(userText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const body = {
    system_instruction: {
      parts: [{ text: 'You are a friendly AI assistant replying on WhatsApp. Reply in the same language/style as the user (Hinglish is fine). Keep replies short.' }]
    },
    contents: [{ role: 'user', parts: [{ text: userText }] }]
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`)
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('')?.trim()
  if (!text) throw new Error('Gemini returned no text')
  return text
}

// ---------- WhatsApp (Baileys) ----------
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) waState = 'needs-pairing'
    if (connection === 'open') {
      waState = 'connected'
      lastPairingCode = null
      logger.info('WhatsApp connected')
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      waState = 'disconnected'
      logger.warn({ code }, 'WhatsApp connection closed')
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startWhatsApp().catch(logger.error), 5000)
      } else {
        waState = 'logged-out-delete-auth-folder'
        logger.error('Logged out. Delete the auth folder and re-pair.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue
        const jid = msg.key.remoteJid
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue
        const sender = jid.split('@')[0].replace(/\D/g, '')

        // Tester whitelist: everyone else is ignored silently.
        if (!TESTER_NUMBER || sender !== TESTER_NUMBER) continue

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        if (!text.trim()) continue

        // Live replies stay OFF until explicitly enabled via env.
        if (!REPLIES_ENABLED) {
          logger.info({ sender }, 'REPLIES_ENABLED=false, not replying')
          continue
        }

        const reply = await geminiReply(text)
        await sock.sendMessage(jid, { text: AI_DISCLAIMER + reply })
      } catch (err) {
        logger.error({ err }, 'message handling failed')
      }
    }
  })
}

async function requestPairing() {
  if (!BOT_NUMBER) throw new Error('BOT_NUMBER env not set')
  if (!sock) throw new Error('WhatsApp socket not started yet')
  if (waState === 'connected') return 'already-connected'
  const code = await sock.requestPairingCode(BOT_NUMBER)
  lastPairingCode = code
  lastPairingAt = Date.now()
  return code
}

// ---------- tiny HTTP server (Render health check + pairing page) ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, whatsapp: waState, replies_enabled: REPLIES_ENABLED }))
      return
    }
    if (req.url === '/pair') {
      const code = await requestPairing()
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>WhatsApp pairing code</h2>
        <p style="font-size:40px;letter-spacing:6px"><b>${code}</b></p>
        <p>WhatsApp &gt; Linked devices &gt; Link a device &gt; "Link with phone number instead" &gt; enter this code.</p>
        <p>Code expires in about 60 seconds. Refresh this page for a new one.</p>
      </body></html>`)
      return
    }
    res.writeHead(404); res.end('not found')
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('error: ' + err.message)
  }
})

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'HTTP server listening')
  startWhatsApp().catch(logger.error)
})
