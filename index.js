const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let currentPairingCode = '';
const conversationMemory = new Map();

// knowledge.json ফাইল থেকে ডেটা লোড করার ফাংশন
function loadKnowledgeBase() {
  try {
    const filePath = path.join(__dirname, 'knowledge.json');
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('knowledge.json পড়তে সমস্যা হয়েছে:', err.message);
  }
  return null;
}

async function getAIReply(jid, userMessage) {
  const kb = loadKnowledgeBase();
  const kbText = kb ? JSON.stringify(kb, null, 2) : 'কোনো তথ্য নেই';

  const systemInstruction = `
তুমি একটি অনলাইন শপের অত্যন্ত দক্ষ, বিনীত ও চটপটে সেলস অ্যাসিস্ট্যান্ট।
কঠোর নিয়মাবলী:
১. নিচে দেওয়া Knowledge Base-এর ওপর ভিত্তি করে উত্তর দেবে। কাস্টমার বাংলিশে লিখুক বা বাংলায়, তুমি সবসময় স্বাভাবিক, সুন্দর বাংলায় ১-২ লাইনে উত্তর দেবে।
২. পণ্যের দাম, ডেলিভারি চার্জ বা অন্য কোনো তথ্য Knowledge Base-এর বাইরে বানিয়ে বলবে না।
৩. কাস্টমার যদি এমন কোনো পণ্য চায় যা Knowledge Base-এ নেই, বলবে: "দুঃখিত, বর্তমানে এই পণ্যটি আমাদের স্টকে নেই।"
৪. কাস্টমার অর্ডার করতে চাইলে Knowledge Base-এ থাকা order_form টি দেবে।
৫. কাস্টমার সম্পূর্ণ তথ্য দিলে বলবে: "আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ধৈর্য ধরে অপেক্ষা করুন, ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পাবেন।" এবং বার্তার শেষে [ORDER_DONE] লিখবে।

=== Knowledge Base ===
${kbText}
`;

  let history = conversationMemory.get(jid) || [];
  history.push({ role: 'user', parts: [{ text: userMessage }] });
  if (history.length > 8) history = history.slice(-8);

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: history,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.2
      }
    });

    const reply = typeof response.text === 'function' ? response.text() : response.text;
    if (reply && reply.trim()) {
      const cleanReply = reply.trim();
      history.push({ role: 'model', parts: [{ text: cleanReply.replace('[ORDER_DONE]', '').trim() }] });
      conversationMemory.set(jid, history);
      return cleanReply;
    }
  } catch (err) {
    console.error('API Error:', err.message);
  }

  if (userMessage.includes('অর্ডার') || userMessage.toLowerCase().includes('order')) {
    return kb?.order_form || 'অর্ডার করতে আপনার নাম, ঠিকানা ও মোবাইল নম্বর দিন।';
  }
  return 'জি, বলুন কীভাবে সাহায্য করতে পারি? কোন প্রোডাক্টটি নিতে চাচ্ছেন?';
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
        console.error('Pairing Error:', err.message);
      }
    }, 4000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
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

      try {
        let aiReply = await getAIReply(jid, cleanText);
        if (!aiReply) continue;

        if (aiReply.includes('[ORDER_DONE]')) {
          aiReply = aiReply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *নতুন অর্ডার এসেছে!*\nকাস্টমার: ${jid.replace(/@.+/, '')}\nমেসেজ: ${cleanText}`
          });
        }

        await sock.sendMessage(jid, { text: aiReply });
      } catch (e) {
        console.error('Send error:', e.message);
      }
    }
  });
}

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
