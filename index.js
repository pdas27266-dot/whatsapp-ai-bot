const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

let currentPairingCode = '';
const conversationMemory = new Map();

// knowledge.json থেকে সঠিক তথ্য পড়ার ফাংশন
function getStoreDetails() {
  try {
    const filePath = path.join(__dirname, 'knowledge.json');
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (e) {
    console.error('File read error:', e.message);
  }
  return `
  প্রোডাক্ট:
  - সাকুরা মাড মাস্ক (Sakura Mud Mask): ২৪০ টাকা (১ প্যাকেটে ১২ পিস)
  - শিট মাস্ক (Sheet Mask): ৬০ টাকা
  - রাইস ফেস ওয়াশ: ৮৫০ টাকা
  ডেলিভারি চার্জ:
  - ব্রাহ্মণবাড়িয়া ভেতরে: ৭০ টাকা
  - ব্রাহ্মণবাড়িয়ার বাইরে: ১২০ টাকা
  `;
}

// সরাসরি ও নির্ভুল Google Gemini API কল (কোনো প্যাকেজ ঝামেলা ছাড়া)
async function callGemini(jid, userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  let history = conversationMemory.get(jid) || [];
  history.push({ role: 'user', parts: [{ text: userText }] });
  if (history.length > 8) history = history.slice(-8);

  const storeInfo = getStoreDetails();

  const systemPrompt = `
তুমি একটি অনলাইন শপের অত্যন্ত বিনয়ী, চটপটে সেলস অ্যাসিস্ট্যান্ট।
কঠোর নিয়ম:
১. কাস্টমার বাংলা বা বাংলিশে (যেমন: "suns cream nite cay", "dam koto", "order korbo") যাই লিখুক, বুঝে নিয়ে সুন্দর প্রফেশনাল বাংলায় ১-২ লাইনে উত্তর দেবে।
২. শপের সংরক্ষিত তথ্যের বাইরে কোনো মনগড়া উত্তর দেবে না:
${storeInfo}
৩. কাস্টমার এমন কিছু চাইলে যা তালিকায় নেই (যেমন: সানস্ক্রিম/অন্য কিছু), বলবে: "দুঃখিত, বর্তমানে এই প্রোডাক্টটি আমাদের স্টকে নেই। আমাদের কাছে সাকুরা মাড মাস্ক, শিট মাস্ক ও রাইস ফেস ওয়াশ এভেইলেবল আছে।"
৪. অর্ডার করতে চাইলে বলবে:
"অর্ডার কনফার্ম করতে নিচের তথ্যগুলো লিখে দিন:
নাম : 
জেলা : 
থানা : 
গ্রাম বা রোড নং : 
মোবাইল নাম্বার : 
কি প্রডাক্ট নিতে চাচ্ছেন :"
৫. সব তথ্য পেয়ে অর্ডার কনফার্ম হলে বলবে: "আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ধৈর্য ধরে অপেক্ষা করুন, ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পাবেন।" এবং শেষে [ORDER_DONE] লিখবে।
`;

  try {
    // সরাসরি অফিসিয়াল রেস্ট এপিআই কল (ফেইল করার কোনো চান্স নেই)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history,
        generationConfig: { temperature: 0.3 }
      })
    });

    const data = await response.json();
    if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      const reply = data.candidates[0].content.parts[0].text.trim();
      history.push({ role: 'model', parts: [{ text: reply.replace('[ORDER_DONE]', '').trim() }] });
      conversationMemory.set(jid, history);
      return reply;
    } else {
      console.error('API Response Error:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
  return null;
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
        let aiReply = await callGemini(jid, cleanText);
        if (!aiReply) continue;

        if (aiReply.includes('[ORDER_DONE]')) {
          aiReply = aiReply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *নতুন অর্ডার এসেছে!*\nকাস্টমার: ${jid.replace(/@.+/, '')}\nমেসেজ: ${cleanText}`
          });
        }

        await sock.sendMessage(jid, { text: aiReply });
      } catch (e) {
        console.error('Message Send Error:', e.message);
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
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">✅ বট সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
