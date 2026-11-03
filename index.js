;const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন স্টোরের অত্যন্ত বিনয়ী, আন্তরিক এবং প্রফেশনাল কাস্টমার সেলস অ্যাসিস্ট্যান্ট।
দায়িত্ব:
১. কাস্টমারের যেকোনো প্রশ্নের সাবলীল বাংলায় সুন্দর উত্তর দেওয়া।
২. কাস্টমার অর্ডার করতে চাইলে বিনয়ের সাথে ৩টি তথ্য চেয়ে নেবে:
   - কাস্টমারের পুরো নাম
   - ডেলিভারির পূর্ণাঙ্গ ঠিকানা
   - সচল মোবাইল নম্বর (১১ ডিজিট)
৩. তথ্যগুলো পাওয়ার পর সুন্দরভাবে অর্ডার সামারি দেখিয়ে কনফার্মেশন চাইবে।
৪. উত্তর সংক্ষিপ্ত ও প্রফেশনাল রাখবে।
`;

// অটোমেটিক লেটেস্ট মডেল ট্রাই করার ফাংশন
async function generateAIReply(userText) {
  const candidateModels = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-2.5-pro'
  ];

  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: userText,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.7
        }
      });

      const reply = typeof response.text === 'function' ? response.text() : response.text;
      if (reply) return reply;
    } catch (e) {
      console.log(`মডেল ${modelName} চেষ্টা করা হচ্ছে...`);
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
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp সফলভাবে যুক্ত হয়েছে!');
      qrCodeData = '';
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) continue;

      const userText = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text;

      if (!userText) continue;

      try {
        const replyText = await generateAIReply(userText);
        if (replyText) {
          await sock.sendMessage(msg.key.remoteJid, { text: replyText });
          console.log(`সফলভাবে উত্তর পাঠানো হয়েছে: ${msg.key.remoteJid}`);
        }
      } catch (err) {
        console.error('মেসেজ পাঠাতে সমস্যা:', err.message);
      }
    }
  });
}

app.get('/', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
        <h2>WhatsApp দিয়ে QR কোডটি স্ক্যান করুন</h2>
        <img src="${qrCodeData}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:10px;" />
      </div>
    `);
  } else {
    res.send(`
      <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
        <h2 style="color:green;">বট সক্রিয় রয়েছে!</h2>
        <p>WhatsApp কানেকশন চালু আছে।</p>
      </div>
    `);
  }
});

app.listen(port, () => {
  console.log(`সার্ভার চালু হয়েছে পোর্ট: ${port}`);
  startBot();
});
