# Peka WA Bot

Community WhatsApp bot for the Peka AI community group, built on
[Baileys](https://github.com/WhiskeySockets/Baileys) (self-hosted, unofficial
WhatsApp Web API). The official WhatsApp Business API cannot join groups, so
Baileys is the only route for a group bot.

## Features

- Welcome + rules message for new group members.
- Commands: `!menu`, `!rules`, `!tools`, `!store`, `!grup`, `!blog`, `!ping`.
- FAQ auto-reply for common questions (store, tools, group link, blog).
- Basic anti-spam: flood warning, non-whitelisted link deletion (only when
  the bot is a group admin). Whitelisted domain: `*.peka.ai.id`.

## Run

```bash
npm install
node index.js
```

On first run the bot writes `qr.png` in this folder. Scan it from the bot
number's WhatsApp app (Settings -> Linked Devices -> Link a Device). Auth
state persists in `auth/`; the bot reconnects automatically after restarts.

## Service

Systemd unit: `peka-wa-bot.service` (in `~/workspace/9router-setup/scripts/`).
Enable it only after the first successful link, so a VM reset restores the
bot with its saved auth state.

## Never commit

- `auth/` — WhatsApp session credentials.
- `qr.png` — one-time pairing code.
- Any phone number or group invite link.
