const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

// Gemini AI ক্লায়েন্ট ইনিশিয়ালাইজেশন
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// বটের ব্যক্তিত্ব এবং নিয়মাবলী (সিস্টেম প্রম্পট)
const SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন স্টোরের অত্যন্ত বিনয়ী, দক্ষ এবং আন্তরিক কাস্টমার সাপোর্ট অ্যাসিস্ট্যান্ট।
তোমার মূল দায়িত্ব:
১. কাস্টমারের যেকোনো প্রশ্নের খাঁটি এবং সাবলীল বাংলায় উত্তর দেওয়া।
২. কাস্টমার যদি পণ্য অর্ডার করতে চায়, তবে তার কাছ থেকে মিষ্টি কথায় ৩টি তথ্য সংগ্রহ করবে:
   - কাস্টমারের পুরো নাম
   - ডেলিভারির পূর্ণাঙ্গ ঠিকানা
   - সচল মোবাইল নম্বর (১১ ডিজিট)
৩. তথ্যগুলো পাওয়ার পর অর্ডার সারাংশ দেখিয়ে কনফার্মেশন চাইবে।
৪. কোনো তথ্য অসম্পূর্ণ থাকলে তা সুন্দর করে চেয়ে নেবে।
৫. উত্তর সবসময় সংক্ষিপ্ত ও প্রফেশনাল রাখবে, অপ্রয়োজনীয় কথা বলবে না।
`;

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
      console.log('নতুন QR কোড তৈরি হয়েছে। ওয়েব পেজে রিফ্রেশ করে দেখুন।');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('কানেকশন বিচ্ছিন্ন হয়েছে। পুনরায় চেষ্টা করা হচ্ছে...', shouldReconnect);
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
      // নিজের পাঠানো মেসেজ কিংবা গ্রুপ মেসেজ এড়িয়ে চলা
      if (msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) continue;

      const userText = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text;

      if (!userText) continue;

      try {
        // Gemini AI দিয়ে রেসপন্স তৈরি
        const response = await ai.models.generateContent({
          model: 'gemini-1.5-flash',
          contents: userText,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            temperature: 0.7
          }
        });

        const replyText = response.text;

        if (replyText) {
          await sock.sendMessage(msg.key.remoteJid, { text: replyText });
        }
      } catch (err) {
        console.error('AI রেসপন্স তৈরিতে সমস্যা:', err.message);
      }
    }
  });
}

// QR কোড ব্রাউজারে প্রদর্শনের জন্য ওয়েব রুট
app.get('/', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
        <h2>আপনার WhatsApp দিয়ে নিচের QR কোডটি স্ক্যান করুন</h2>
        <img src="${qrCodeData}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:10px;" />
        <p>WhatsApp > Linked Devices > Link a Device অপশনে গিয়ে ক্যামেরা চালু করুন।</p>
      </div>
    `);
  } else {
    res.send(`
      <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
        <h2 style="color:green;">বট সক্রিয় রয়েছে!</h2>
        <p>WhatsApp কানেকশন চালু আছে অথবা QR কোড লোড হচ্ছে।</p>
      </div>
    `);
  }
});

app.listen(port, () => {
  console.log(`সার্ভার চালু হয়েছে পোর্ট: ${port}`);
  startBot();
});
