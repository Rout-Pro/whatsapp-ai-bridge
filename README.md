# WhatsApp AI Bridge

AI auto-reply bot for a secondary WhatsApp number. Node.js + Baileys (WhatsApp Web socket) + Gemini.
Built to deploy on Render's **free** web service, no card needed.

## What it does

- Connects one WhatsApp number (the bot's secondary number) via Baileys.
- Replies **only to the tester number** (`TESTER_NUMBER`). Every other sender is silently ignored.
- Every reply is prefixed `[AI bot]`.
- Live replies are **OFF by default** (`REPLIES_ENABLED=false`) until explicitly switched on.
- Small HTTP server: `/health` for Render health checks, `/pair` to get a WhatsApp pairing code.

## Deploy on Render (phone steps)

1. Render Dashboard > **New > Web Service** > **Public Git Repository** tab.
2. Paste this repo's URL and continue.
3. Settings:
   - Name: `whatsapp-ai-bridge` (anything works)
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node src/index.js`
   - Instance Type: **Free**
4. Environment variables (Add Environment Variable):
   - `BOT_NUMBER` = the bot's WhatsApp number with country code, digits only (e.g. `91XXXXXXXXXX`)
   - `TESTER_NUMBER` = the tester's WhatsApp number with country code, digits only (required; only this number gets replies)
   - `REPLIES_ENABLED` = `false` (keep false until replies are approved)
   - `GEMINI_API_KEY` = your Gemini API key (needed only when replies are on)
   - `GEMINI_MODEL` = `gemini-3.8-flash`
5. Create Web Service. Watch the logs until it says the HTTP server is listening.

## Linking WhatsApp (pairing code)

1. Open `https://<your-service>.onrender.com/pair` in the browser.
2. A 8-letter code appears (valid ~60 seconds; refresh for a new one).
3. On the bot number's phone: WhatsApp > **Linked devices** > **Link a device** > **"Link with phone number instead"** > enter the code.
4. `/health` should then show `"whatsapp": "connected"`.

## Honest limitations on Render Free (read this)

- **Free services sleep after 15 minutes without inbound HTTP traffic** (Render docs). The WhatsApp
  socket is an *outbound* connection and does **not** keep the service awake. While asleep, the bot is
  offline and misses messages. Workaround: a free uptime pinger (e.g. UptimeRobot) hitting
  `https://<your-service>.onrender.com/health` every 5 minutes keeps it awake within Render's
  750 free instance hours/month (enough for 24x7). Render says free instances are not for production.
- **Ephemeral filesystem**: the WhatsApp session in `auth/` is lost on every redeploy, restart, or
  spin-down, so you must re-pair (steps above) after each one. Free services cannot attach a persistent disk.
- Render may restart free services at any time.
- Baileys is unofficial. WhatsApp can restrict numbers that use it. Use a secondary number only.

## No secrets in this repo

The Gemini key and all credentials live outside the repo (env vars / password manager).
`auth/` (WhatsApp session) is gitignored and must never be committed.
