# 🚗 Vehicle Alert Bot — Full Setup Guide
## Email → WhatsApp Alert Forwarding System

---

## What This Does

Every time your vehicle tracking system sends an alert email, this bot:
1. Detects the email in real-time (IMAP IDLE — no polling delay)
2. Parses vehicle plate, coordinates, alert type, timestamp
3. Builds a formatted WhatsApp message with severity, a Google Maps link, and all details
4. Sends it to your specified WhatsApp group

---

## Prerequisites — Install These First

### 1. Node.js 18 or higher
Download from: https://nodejs.org → Click "LTS" → Run the installer

Verify after install (open Command Prompt / Terminal):
```
node --version    # should show v18.x.x or higher
npm --version
```

### 2. Git (optional but recommended)
Download from: https://git-scm.com/downloads

### 3. Windows: Install Visual C++ Build Tools (needed by whatsapp-web.js)
Download from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
- Run the installer
- Select: "Desktop development with C++"
- Click Install (about 3 GB download)

Alternatively, run in an elevated Command Prompt:
```
npm install --global --production windows-build-tools
```

---

## Step 1 — Get the Project Files

Copy the `vehicle-alert-bot` folder onto the laptop, then open a terminal inside it:
```
cd vehicle-alert-bot
npm install
```
This downloads all dependencies including Chromium (~170 MB, needed by whatsapp-web.js).
It may take 3–5 minutes on first run.

---

## Step 2 — Set Up Your Email

### Gmail (Recommended)

**A. Enable IMAP in Gmail:**
1. Open Gmail → ⚙️ Settings → See all settings
2. Tab: "Forwarding and POP/IMAP"
3. Under IMAP access → Enable IMAP → Save

**B. Create an App Password (required if 2-Step Verification is ON — it should be):**
1. Go to: https://myaccount.google.com/security
2. Under "How you sign in to Google" → click "2-Step Verification" → scroll to bottom
3. Click "App passwords"
4. Name it: `Vehicle Alert Bot` → click Create
5. Copy the 16-character password shown (e.g. `abcd efgh ijkl mnop`)
6. Use THIS as your `EMAIL_PASSWORD` — not your Gmail login password

### Outlook / Hotmail
1. Go to: https://account.microsoft.com/security
2. Advanced security → App passwords → Create new app password
3. Use that password as `EMAIL_PASSWORD`
4. IMAP settings are auto-set; no changes needed

### Yahoo Mail
1. Go to: https://login.yahoo.com → Account Security
2. Generate an App Password for "Mail"
3. Use that as `EMAIL_PASSWORD`

---

## Step 3 — Configure the Bot

Copy the example env file and fill it in:
```
cp .env.example .env
```

Open `.env` in Notepad or VS Code and set:

```env
EMAIL_PROVIDER=gmail
EMAIL_USER=you@gmail.com
EMAIL_PASSWORD=abcd efgh ijkl mnop
ALERT_SENDER=alerts@yourtrackingsystem.com
WHATSAPP_GROUP_NAME=Fleet Alerts 🚗
```

**Finding ALERT_SENDER:** Forward one of your tracking system's alert emails to yourself,
open it, and look at the "From" address. Copy it exactly.

**Finding WHATSAPP_GROUP_NAME:** It must exactly match the group name in WhatsApp
(including spaces, capitals, and emojis).

---

## Step 4 — First Run & WhatsApp Authentication

```
npm start
```

On first run, a large QR code will appear in the terminal.

1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the QR code

The session is then saved locally in `.wwebjs_auth/` — you won't need to scan again
unless you explicitly log out or delete that folder.

---

## Step 5 — Run as a Background Service (so it survives laptop restarts)

Install PM2 (process manager):
```
npm install -g pm2
pm2 start index.js --name vehicle-alert-bot
pm2 save
pm2 startup
```
Follow the instruction PM2 prints for `pm2 startup` — it will auto-start the bot on boot.

Useful PM2 commands:
```
pm2 logs vehicle-alert-bot     # live logs
pm2 status                     # check if it's running
pm2 restart vehicle-alert-bot  # restart
pm2 stop vehicle-alert-bot     # stop
```

---

## Customising Alert Types

Edit `data/alertTypes.json` to add, rename, or remove alert types.
Each entry has:
- `keywords`: text to look for in the email subject/body (case-insensitive)
- `severity`: LOW | MEDIUM | HIGH | CRITICAL
- `emoji` and `label`: shown in the WhatsApp message

---

## Customising the WhatsApp Message Format

Edit the `_buildMessage()` method in `services/messageFormatter.js`.
The template uses plain strings — `\n` is a new line, `*text*` is bold in WhatsApp.

---

## Filtering (Current)

In `.env`:
- `IGNORED_ALERTS` — comma-separated list of alert types to never forward
  Example: `IGNORED_ALERTS=Ignition On,Ignition Off`
- `MIN_SEVERITY` — skip alerts below this level
  Example: `MIN_SEVERITY=HIGH` — only sends HIGH and CRITICAL alerts

---

## Project Structure

```
vehicle-alert-bot/
├── index.js                    ← Entry point
├── .env                        ← Your config (never commit this)
├── .env.example                ← Config template
├── package.json
├── config/
│   └── settings.js             ← All config loaded here
├── data/
│   └── alertTypes.json         ← Alert type definitions
├── services/
│   ├── emailMonitor.js         ← IMAP email watcher
│   ├── alertParser.js          ← Email → structured data
│   ├── messageFormatter.js     ← Data → WhatsApp message
│   └── whatsappBot.js          ← WhatsApp client
└── utils/
    └── logger.js               ← Timestamped logging
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Error: Invalid credentials` | Check App Password in `.env` — not your normal password |
| Group not found | Check `WHATSAPP_GROUP_NAME` matches exactly (copy-paste from phone) |
| QR code not scanning | Delete `.wwebjs_auth/` folder and restart |
| `ECONNREFUSED` IMAP error | Check `EMAIL_PROVIDER` and that IMAP is enabled |
| Fields show N/A | The email format may differ — see "Adapting to Your Email Format" below |
| Chromium error on Windows | Run `npm install` again; ensure Build Tools are installed |

---

## Adapting to Your Email Format

If vehicle fields show as N/A, the regex patterns need tuning.
1. Copy a real alert email's raw text
2. Open `services/alertParser.js`
3. Look at `FIELD_PATTERNS` at the top
4. Add a regex pattern that matches your email's format for that field
5. Test with `node -e "require('./services/alertParser').test()"`

---

## Payments & Costs

| Component | Cost |
|---|---|
| Gmail / Outlook IMAP | Free |
| whatsapp-web.js | Free (unofficial WhatsApp Web client) |
| Node.js | Free |
| Google Maps links | Free (just a URL — no API key needed) |
| **Total** | **$0** |

---

## Security Notes

- Never share your `.env` file or the `.wwebjs_auth/` folder
- The App Password gives access to your email — store it securely
- This uses WhatsApp Web (not the official Business API) — suitable for personal/small business use
