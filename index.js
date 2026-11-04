const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_JID = '8801789631882@s.whatsapp.net';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let bossCustomRules = '';
let currentPairingCode = '';

const SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন শপের অত্যন্ত দ্রুত ও চটপটে সেলস অ্যাসিস্ট্যান্ট।
কাজের নিয়ম:
১. কাস্টমারের যেকোনো প্রশ্নের দ্রুত ও স্বাভাবিক ভাষায় উত্তর দেবে। বাংলিশ বা ইংরেজি মেসেজ দিলেও তা বুঝে বাংলায় উত্তর দেবে।
২. তোমার জানা তথ্য এবং বসের দেওয়া তথ্যের বাইরে কোনো মনগড়া তথ্য দেবে না।
৩. কাস্টমার অর্ডার করতে চাইলে তার নাম, ঠিকানা ও মোবাইল নম্বর চেয়ে নেবে।
৪. বস কোনো তথ্য শেখাতে চাইলে মেসেজের শুরুতে '!শিখুন' লিখবে, তখন সেই তথ্যটি মনে রাখবে।
`;

async function generateAIReply(userText) {
  const fullPrompt = `${SYSTEM_INSTRUCTION}\nবসের শেখানো তথ্য:\n${bossCustomRules}`;
  
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userText,
      config: { systemInstruction: fullPrompt, temperature: 0.5 }
    });
    return typeof response.text === 'function' ? response.text() : response.text;
  } catch (e) {
    return null;
  }
}

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
        console.error('Pairing Code Error:', err.message);
      }
    }, 5000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('WhatsApp Connected!');
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

      // বস কমান্ড চেক
      if (jid.includes('01789631882') || jid === BOSS_JID) {
        if (cleanText.startsWith('!শিখুন') || cleanText.startsWith('!learn')) {
          const newRule = cleanText.replace(/^(!শিখুন|!learn)\s*[:]?\s*/i, '').trim();
          if (newRule) {
            bossCustomRules += `\n- ${newRule}`;
            await sock.sendMessage(jid, { text: `✅ বস, নতুন তথ্যটি মুখস্থ করে নিয়েছি!` });
          }
          continue;
        }
      }

      const replyText = await generateAIReply(cleanText);
      if (replyText) {
        await sock.sendMessage(jid, { text: replyText });
      }
    }
  });
}

app.get('/', (req, res) => {
  if (currentPairingCode) {
    res.send(`<div style="text-align:center;margin-top:60px;"><h2>WhatsApp Pairing Code:</h2><h1 style="font-size:45px;color:#16a34a;">${currentPairingCode}</h1></div>`);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">বট সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
