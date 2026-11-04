const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const { getBotReply } = require('./ai');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

let currentPairingCode = '';
const userSessions = new Map();
const bossAlertCooldown = new Map();

// সার্ভার জীবিত রাখার স্বয়ংক্রিয় পিং (Render-কে স্লিপ হতে দেবে না)
setInterval(() => {
  fetch(`http://localhost:${port}/ping`).catch(() => {});
}, 4 * 60 * 1000);

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        currentPairingCode = code;
        console.log(`Pairing Code: ${currentPairingCode}`);
      } catch (err) {
        console.error('Pairing Error:', err.message);
      }
    }, 4000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('Reconnecting...');
        setTimeout(startBot, 3000);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp Bot Connected Successfully!');
      currentPairingCode = '';
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || msg.key.fromMe) continue;

      const userText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!userText) continue;

      const cleanText = userText.trim();
      const customerPhone = jid.replace(/@.+/, '');

      let history = userSessions.get(jid) || [];

      try {
        let reply = await getBotReply(history, cleanText);
        if (!reply) continue;

        // হিস্ট্রি আপডেট
        history.push({ role: 'user', parts: [{ text: cleanText }] });
        const cleanToStore = reply.replace(/\[ORDER_DONE\]|\[ASK_BOSS\]/g, '').trim();
        history.push({ role: 'model', parts: [{ text: cleanToStore }] });
        if (history.length > 8) history = history.slice(-8);
        userSessions.set(jid, history);

        // অজানা প্রোডাক্ট চাইলে বসকে অ্যালার্ট (৫ মিনিটে একবার)
        if (reply.includes('[ASK_BOSS]')) {
          reply = reply.replace('[ASK_BOSS]', '').trim();
          const now = Date.now();
          const lastTime = bossAlertCooldown.get(jid) || 0;
          if (now - lastTime > 300000) {
            bossAlertCooldown.set(jid, now);
            await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
              text: `⚠️ *কাস্টমারের প্রোডাক্ট রিকোয়ারমেন্ট!*\nনম্বর: ${customerPhone}\nমেসেজ: "${cleanText}"`
            });
          }
        }

        // অর্ডার কনফার্ম হলে অ্যালার্ট
        if (reply.includes('[ORDER_DONE]')) {
          reply = reply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *কনফার্ম অর্ডার এসেছে!*\nকাস্টমার: ${customerPhone}\nঅর্ডার মেসেজ:\n${cleanText}`
          });
        }

        await sock.sendMessage(jid, { text: reply });
      } catch (e) {
        console.error('Send Error:', e.message);
      }
    }
  });
}

app.get('/ping', (req, res) => res.send('pong'));

app.get('/', (req, res) => {
  if (currentPairingCode) {
    res.send(`
      <div style="text-align:center;margin-top:60px;font-family:sans-serif;">
        <h2>WhatsApp পেয়ারিং কোড:</h2>
        <h1 style="font-size:45px;color:#16a34a;letter-spacing:6px;background:#f3f4f6;display:inline-block;padding:10px 25px;border-radius:10px;">${currentPairingCode}</h1>
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">✅ বট সফলভাবে সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
