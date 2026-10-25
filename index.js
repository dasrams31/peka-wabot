// Peka AI community WhatsApp bot (Baileys, self-hosted).
// Auth state lives in ./auth (created on first link). Never commit that folder.
// User-facing strings are Indonesian (the community's language); everything
// else (code, comments, logs) is English.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth');
const QR_FILE = path.join(__dirname, 'qr.png');

// ---- Editable copy (user-facing, Indonesian) ----
const COPY = {
  welcome: (names) =>
    `Halo ${names}, selamat datang di Komunitas Peka AI!\n\n` +
    `Kenalan dulu, baca rules di bawah, dan jangan sungkan nanya. Ketik !menu buat lihat perintah bot.`,
  rules:
    `Rules Komunitas Peka AI:\n` +
    `1. Sopan dan saling menghargai, tanpa SARA dan tanpa ribut.\n` +
    `2. Dilarang spam, flood, dan promosi tanpa izin admin.\n` +
    `3. Dilarang share link mencurigakan, phising, atau hoaks.\n` +
    `4. Tanya seputar AI dipersilakan, jawab sebisanya, hargai yang bantu jawab.\n` +
    `5. Keputusan admin bersifat final.`,
  menu:
    `Perintah bot Peka AI:\n` +
    `!menu - daftar perintah ini\n` +
    `!rules - rules grup\n` +
    `!tools - direktori tools AI open source\n` +
    `!store - toko produk digital Peka\n` +
    `!grup - link komunitas Peka\n` +
    `!blog - blog Peka AI`,
  tools: `Katalog 86 tools AI open source, gratis, tinggal pakai:\nhttps://tools.peka.ai.id`,
  store: `Toko produk digital Peka (script, produk AI, kelas, prompt):\nhttps://store.peka.ai.id`,
  grup: `Semua link komunitas Peka (grup WA, channel, grup Telegram):\nhttps://url.peka.ai.id`,
  blog: `Blog Peka AI (berita, tutorial, dan insight AI):\nhttps://blog.peka.ai.id`,
  linkWarn:
    `Link di luar peka.ai.id tidak diizinkan di grup ini ya, pesannya aku hapus. Kalau linknya penting, izin admin dulu.`,
  floodWarn: `Santai dulu ya, jangan flood. Pesan beruntunnya dikurangi.`,
  faq: {
    store: `Mau beli? Tokonya di sini:\nhttps://store.peka.ai.id`,
    tools: `Tools AI open source gratis ada di sini:\nhttps://tools.peka.ai.id`,
    grup: `Link gabung komunitas ada di sini:\nhttps://url.peka.ai.id`,
    blog: `Artikel dan berita AI ada di sini:\nhttps://blog.peka.ai.id`,
  },
};

// FAQ triggers: question-like messages only (keyword + question mark or
// explicit "di mana"/"apa" phrasing), so normal chat is never interrupted.
const FAQ_PATTERNS = [
  { re: /(store|beli|harga).*(di\s?mana|berapa)|beli\s+di\s?mana/i, answer: COPY.faq.store },
  { re: /tools?\s+(apa|di\s?mana|apa\s+aja)/i, answer: COPY.faq.tools },
  { re: /(link\s+)?grup(\s+wa|\s+whatsapp)?\s*(di\s?mana|mana|apa)|gabung\s+(grup|komunitas)/i, answer: COPY.faq.grup },
  { re: /blog\s*(di\s?mana|apa|mana)/i, answer: COPY.faq.blog },
];

const COMMANDS = {
  '!menu': COPY.menu,
  '!help': COPY.menu,
  '!rules': COPY.rules,
  '!tools': COPY.tools,
  '!store': COPY.store,
  '!grup': COPY.grup,
  '!blog': COPY.blog,
  '!ping': 'pong',
};

// ---- Anti-spam state (in-memory, per group) ----
const floodMap = new Map(); // key: groupJid:sender -> [timestamps]
const warnedAt = new Map(); // key: groupJid:sender:kind -> timestamp
const groupAdminCache = new Map(); // groupJid -> { botIsAdmin, at }

const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MAX = 5;
const WARN_COOLDOWN_MS = 60_000;

function shouldWarn(key) {
  const now = Date.now();
  const last = warnedAt.get(key) || 0;
  if (now - last < WARN_COOLDOWN_MS) return false;
  warnedAt.set(key, now);
  return true;
}

async function botIsGroupAdmin(sock, groupJid) {
  const cached = groupAdminCache.get(groupJid);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.botIsAdmin;
  try {
    const meta = await sock.groupMetadata(groupJid);
    const me = sock.user.id.split(':')[0];
    const entry = meta.participants.find((p) => p.id.split('@')[0] === me);
    const isAdmin = entry && (entry.admin === 'admin' || entry.admin === 'superadmin');
    groupAdminCache.set(groupJid, { botIsAdmin: !!isAdmin, at: Date.now() });
    return !!isAdmin;
  } catch {
    return false;
  }
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  if (msg.key.fromMe) return;
  const text = extractText(msg).trim();
  if (!text) return;

  const isGroup = jid.endsWith('@g.us');
  const sender = msg.key.participant || msg.key.remoteJid;

  // Commands (exact first word, case-insensitive).
  const firstWord = text.split(/\s+/)[0].toLowerCase();
  if (COMMANDS[firstWord]) {
    await sock.sendMessage(jid, { text: COMMANDS[firstWord] }, { quoted: msg });
    return;
  }

  if (!isGroup) return; // FAQ + anti-spam apply to groups only.

  // FAQ auto-reply.
  for (const { re, answer } of FAQ_PATTERNS) {
    if (re.test(text)) {
      await sock.sendMessage(jid, { text: answer }, { quoted: msg });
      return;
    }
  }

  // Anti-spam: flood detection.
  const floodKey = `${jid}:${sender}`;
  const now = Date.now();
  const stamps = (floodMap.get(floodKey) || []).filter((t) => now - t < FLOOD_WINDOW_MS);
  stamps.push(now);
  floodMap.set(floodKey, stamps);
  if (stamps.length > FLOOD_MAX && shouldWarn(`${floodKey}:flood`)) {
    await sock.sendMessage(jid, { text: COPY.floodWarn }, { quoted: msg });
    return;
  }

  // Anti-spam: non-whitelisted links (deleted only when the bot is admin).
  const hasLink = /https?:\/\/\S+/i.test(text);
  const whitelisted = /https?:\/\/(www\.)?([a-z0-9-]+\.)?peka\.ai\.id(\/\S*)?/i.test(text);
  if (hasLink && !whitelisted) {
    if (await botIsGroupAdmin(sock, jid)) {
      try {
        await sock.sendMessage(jid, {
          delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender },
        });
      } catch (err) {
        console.log('delete failed:', err.message);
      }
    }
    if (shouldWarn(`${floodKey}:link`)) {
      await sock.sendMessage(jid, { text: COPY.linkWarn }, { quoted: msg });
    }
  }
}

async function handleParticipants(sock, { id, participants, action }) {
  if (action !== 'add') return;
  const names = participants.map((p) => `@${p.split('@')[0]}`).join(' ');
  try {
    await sock.sendMessage(id, {
      text: `${COPY.welcome(names)}\n\n${COPY.rules}`,
      mentions: participants,
    });
  } catch (err) {
    console.log('welcome failed:', err.message);
  }
}

async function start() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        await QRCode.toFile(QR_FILE, qr);
        console.log(`QR saved to ${QR_FILE} — scan it with the bot number's WhatsApp app.`);
      } catch (err) {
        console.log('QR write failed:', err.message);
      }
    }
    if (connection === 'open') {
      console.log(`connected as ${sock.user.id}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`connection closed (code ${code}, loggedOut=${loggedOut})`);
      if (!loggedOut) {
        console.log('reconnecting in 5s...');
        setTimeout(start, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.log('message handler error:', err.message);
      }
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    try {
      await handleParticipants(sock, update);
    } catch (err) {
      console.log('participants handler error:', err.message);
    }
  });
}

start().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
