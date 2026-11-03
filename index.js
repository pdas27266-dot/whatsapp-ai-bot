const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// চ্যাট মেমোরি এবং ওনার টেকওভার ট্র্যাকিং
const chatHistories = new Map();
const humanPausedChats = new Map();

const SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন স্টোরের বিক্রেতা।
কঠোরভাবে নিচের নিয়মগুলো মানবে:
১. কোনো অপ্রয়োজনীয় আনুষ্ঠানিকতা বা বড় ভাষণ দেবে না (যেমন: "আমাদের স্টোরে স্বাগতম", "আমি আপনার সেলস অ্যাসিস্ট্যান্ট" ইত্যাদি সম্পূর্ণ নিষিদ্ধ)।
২. উত্তর সবসময় খুব সংক্ষিপ্ত (১ থেকে ২ লাইন) এবং সাধারণ মানুষ যেভাবে হোয়াটসঅ্যাপে চ্যাট করে ঠিক সেভাবে দেবে।
৩. কাস্টমার যদি অর্ডার সংক্রান্ত কোনো তথ্য বা কনফার্মেশন দেয়, তবে শুধু বলবে "ধন্যবাদ, আপনার তথ্য পেয়েছি।" 
৪. কাস্টমার দাম বা পণ্য জানতে চাইলে সরাসরি পয়েন্টে উত্তর দেবে।
`;

async function generateAIReply(jid, userText) {
  let history = chatHistories.get(jid) || [];
  history.push({ role: 'user', text: userText });
  if (history.length > 6) history = history.slice(-6);
  chatHistories.set(jid, history);

  const candidateModels = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest'
  ];

  const conversationPrompt = history
    .map(h => `${h.role === 'user' ? 'Customer' : 'Seller'}: ${h.text}`)
    .join('\n');

  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: conversationPrompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.4
        }
      });

      const reply = typeof response.text === 'function' ? response.text() : response.text;
      if (reply) {
        history.push({ role: 'model', text: reply.trim() });
        chatHistories.set(jid, history);
        return reply.trim();
      }
    } catch (e) {
      // পরবর্তী মডেলে চেষ্টা করবে
    }
  }
  return null;
}

let qrCodeData = '';

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      qrCodeData = '';
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue;

      // আপনি মেসেজ পাঠালে বট ৫ মিনিট মিউট থাকবে
      if (msg.key.fromMe) {
        humanPausedChats.set(jid, Date.now() + 5 * 60 * 1000);
        continue;
      }

      // চ্যাটটি ওনারের নিয়ন্ত্রণে আছে কি না চেক
      const pauseUntil = humanPausedChats.get(jid) || 0;
      if (Date.now() < pauseUntil) {
        continue; 
      }

      const userText = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text;

      if (!userText) continue;

      try {
        const replyText = await generateAIReply(jid, userText);
        if (replyText) {
          await sock.sendMessage(jid, { text: replyText });
        }
      } catch (err) {
        console.error('Error sending message:', err.message);
      }
    }
  });
}

app.get('/', (req, res) => {
  if (qrCodeData) {
    res.send(`<div style="text-align:center;margin-top:50px;"><img src="${qrCodeData}" style="width:300px;"/></div>`);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:50px;">বট সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
