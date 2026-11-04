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

function getStoreData() {
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
  - সাকুরা মাড মাস্ক: ২৪০ টাকা (১ প্যাকেটে ১২ পিস)
  - শিট মাস্ক: ৬০ টাকা
  - রাইস ফেস ওয়াশ: ৮৫০ টাকা
  ডেলিভারি চার্জ:
  - ব্রাহ্মণবাড়িয়ার ভিতরে: ৭০ টাকা
  - ব্রাহ্মণবাড়িয়ার বাইরে: ১২০ টাকা
  `;
}

async function callGemini(jid, userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  const storeInfo = getStoreData();

  if (apiKey) {
    let history = conversationMemory.get(jid) || [];
    history.push({ role: 'user', parts: [{ text: userText }] });
    if (history.length > 8) history = history.slice(-8);

    const systemPrompt = `
তুমি একটি অনলাইন শপের অত্যন্ত বিনয়ী ও চটপটে সেলস অ্যাসিস্ট্যান্ট।
কঠোর নিয়ম:
১. কাস্টমার বাংলা বা বাংলিশে যাই বলুক, সবসময় স্বাভাবিক ও মিষ্টি বাংলায় ১-২ লাইনে স্পষ্ট উত্তর দেবে।
২. শপের পণ্য ও দাম:
${storeInfo}
৩. তালিকায় না থাকা কোনো পণ্য চাইলে বলবে: "দুঃখিত, বর্তমানে আমাদের কাছে শুধু সাকুরা মাড মাস্ক, শিট মাস্ক এবং রাইস ফেস ওয়াশ রয়েছে।"
৪. কাস্টমার অর্ডার করতে চাইলে এই ফর্মটি পূরণ করতে বলবে:
নাম : 
জেলা : 
থানা : 
গ্রাম বা রোড নং : 
মোবাইল নাম্বার : 
কি প্রডাক্ট নিতে চাচ্ছেন :
৫. তথ্য দিলে বলবে: "আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ধৈর্য ধরে অপেক্ষা করুন, ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পাবেন।" এবং শেষে [ORDER_DONE] লিখবে।
`;

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];

    for (const model of models) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
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
        }
      } catch (err) {}
    }
  }

  // ফেইল-সেফ অটোমেটিক রিপ্লাই (API ডাউন হলেও কাজ করবে)
  const lower = userText.toLowerCase();
  if (lower.includes('sakura') || lower.includes('সাকুরা') || lower.includes('mud')) {
    return 'সাকুরা মাড মাস্ক ১ প্যাকেট ২৪০ টাকা (১২ পিস থাকে)। ব্রাহ্মণবাড়িয়ার ভেতর ডেলিভারি ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (lower.includes('sheet') || lower.includes('শিট') || lower.includes('সিট')) {
    return 'শিট মাস্ক প্রতি পিস ৬০ টাকা। ব্রাহ্মণবাড়িয়ার ভেতর ডেলিভারি ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (lower.includes('rice') || lower.includes('রাইস') || lower.includes('face wash')) {
    return 'রাইস ফেস ওয়াশ এর দাম ৮৫০ টাকা। ডেলিভারি চার্জ ব্রাহ্মণবাড়িয়ায় ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (lower.includes('order') || lower.includes('অর্ডার') || lower.includes('nibo') || lower.includes('নিব')) {
    return "অর্ডার কনফার্ম করতে নিচের তথ্যগুলো লিখে পাঠান:\n\nনাম :\nজেলা :\nথানা :\nগ্রাম বা রোড নং :\nমোবাইল নাম্বার :\nকি প্রডাক্ট নিতে চাচ্ছেন :";
  }

  return 'জি, বলুন কীভাবে সাহায্য করতে পারি? আপনি সাকুরা মাড মাস্ক, শিট মাস্ক নাকি রাইস ফেস ওয়াশ নিতে চাচ্ছেন?';
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
        console.log(`NEW_PAIRING_CODE: ${currentPairingCode}`);
      } catch (err) {
        console.error('Pairing Error:', err.message);
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
        console.error('Send Error:', e.message);
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
        <p style="color:#666;">কোডটি আসার পর পরই WhatsApp-এ বসান (মেয়াদ মাত্র ২ মিনিট)</p>
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">✅ বট সফলভাবে সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
