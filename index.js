const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

let currentPairingCode = '';
const conversationHistory = new Map();
const bossAlertCooldown = new Map();

const STORE_PROMPT = `
তুমি RS SHOP BD অনলাইন স্টোরের একজন অত্যন্ত অভিজ্ঞ, অমায়িক এবং বুদ্ধিমান সেলস এজেন্ট।
কাস্টমার যেভাবে প্রশ্ন করবে (বাংলা বা বাংলিশ), তুমি মানুষের মতো মিষ্টি ভাষায় ১-২ লাইনে স্পষ্ট উত্তর দেবে।

আমাদের শপের প্রোডাক্ট তালিকা ও বিবরণ:
১. সাকুরা মাড মাস্ক (Sakura Mud Mask):
   - দাম: ১ প্যাকেট ২৪০ টাকা (১২ পিস থাকে)।
   - কাজ: ত্বক গভীরভাবে পরিষ্কার করে, বাড়তি তেল দূর করে ও ত্বক সফট রাখে।
২. শিট মাস্ক (Sheet Mask):
   - দাম: ৬০ টাকা প্রতি পিস।
   - কাজ: ত্বককে ইনস্ট্যান্ট হাইড্রেট, নরম ও ময়েশ্চারাইজড করে।
৩. রাইস ফেস ওয়াশ (Rice Face Wash):
   - দাম: ৮৫০ টাকা।
   - কাজ: ত্বক ভেতর থেকে পরিষ্কার করে প্রাকৃতিক উজ্জ্বলতা আনে।
৪. ডেলিভারি নিয়মাবলী:
   - ব্রাহ্মণবাড়িয়ার ভিতরে: ৭০ টাকা।
   - ব্রাহ্মণবাড়িয়ার বাইরে: ১২০ টাকা।
   - সময়: ২ থেকে ৩ দিন। ক্যাশ অন ডেলিভারি সুবিধা আছে।

কথা বলার নিয়ম:
১. কাস্টমার হাই/হ্যালো/সালাম দিলে সুন্দর করে উত্তর দিয়ে জানতে চাইবে কী লাগবে।
২. কাস্টমার আগের কথার প্রেক্ষিতে "এটার কাজ কি" বা দাম জানতে চাইলে ঠিক সেই প্রোডাক্টের কাজ ও দাম বুঝিয়ে বলবে।
৩. তালিকায় নেই এমন প্রোডাক্ট চাইলে বলবে: "এই প্রোডাক্টটি বর্তমানে আমাদের স্টকে নেই, তবে আমি আমাদের ওনারকে জানিয়ে রাখছি।" এবং মেসেজের শেষে [ASK_BOSS] লিখবে।
৪. কাস্টমার প্রোডাক্ট নিতে চাইলে অর্ডার ফর্ম দেবে:
নাম : 
জেলা : 
থানা : 
গ্রাম বা রোড নং : 
মোবাইল নাম্বার : 
কি প্রডাক্ট নিতে চাচ্ছেন :
৫. ফরম পূরণ করে দিলে বলবে: "ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ২-৩ দিনের মধ্যে প্রোডাক্ট পেয়ে যাবেন।" এবং শেষে [ORDER_DONE] লিখবে।
`;

async function getAIReply(jid, userText) {
  let history = conversationHistory.get(jid) || [];
  history.push({ role: 'user', content: userText });
  if (history.length > 8) history = history.slice(-8);

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  // ১. Groq দিয়ে চেষ্টা (যদি সেট করা থাকে)
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: STORE_PROMPT }, ...history],
          temperature: 0.3
        })
      });
      const data = await res.json();
      if (data?.choices?.[0]?.message?.content) {
        const reply = data.choices[0].message.content.trim();
        history.push({ role: 'assistant', content: reply.replace(/\[ORDER_DONE\]|\[ASK_BOSS\]/g, '').trim() });
        conversationHistory.set(jid, history);
        return reply;
      }
    } catch (e) {}
  }

  // ২. Gemini API দিয়ে কল (Groq না থাকলে এটি চলবে)
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: STORE_PROMPT }] },
          contents: history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
          })),
          generationConfig: { temperature: 0.3 }
        })
      });
      const data = await res.json();
      if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const reply = data.candidates[0].content.parts[0].text.trim();
        history.push({ role: 'assistant', content: reply.replace(/\[ORDER_DONE\]|\[ASK_BOSS\]/g, '').trim() });
        conversationHistory.set(jid, history);
        return reply;
      }
    } catch (e) {}
  }

  // ফলব্যাক ব্যাকআপ
  const t = userText.toLowerCase();
  if (t.includes('order') || t.includes('অর্ডার')) {
    return "অর্ডার কনফার্ম করতে নিচের তথ্যগুলো লিখে পাঠান:\n\nনাম :\nজেলা :\nথানা :\nগ্রাম বা রোড নং :\nমোবাইল নাম্বার :\nকি প্রডাক্ট নিতে চাচ্ছেন :";
  }
  return "আসসালামু আলাইকুম! RS SHOP BD-তে স্বাগতম। আপনি কোন প্রোডাক্টটি সম্পর্কে জানতে চাচ্ছেন?";
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000
  });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        currentPairingCode = code;
        console.log(`ACTIVE_PAIRING_CODE: ${currentPairingCode}`);
      } catch (err) {
        console.error('Pairing Error:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('কানেকশন ক্লোজ হয়েছে, পুনরায় চেষ্টা করা হচ্ছে...', statusCode);
      if (shouldReconnect) setTimeout(startBot, 4000);
    } else if (connection === 'open') {
      console.log('হোয়াটসঅ্যাপ সফলভাবে সংযুক্ত হয়েছে!');
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
      const customerNum = jid.replace(/@.+/, '');

      try {
        let reply = await getAIReply(jid, cleanText);
        if (!reply) continue;

        if (reply.includes('[ASK_BOSS]')) {
          reply = reply.replace('[ASK_BOSS]', '').trim();
          const now = Date.now();
          const lastTime = bossAlertCooldown.get(jid) || 0;
          if (now - lastTime > 300000) {
            bossAlertCooldown.set(jid, now);
            await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
              text: `⚠️ *কাস্টমারের নতুন অনুসন্ধান!*\nনম্বর: ${customerNum}\nমেসেজ: "${cleanText}"`
            });
          }
        }

        if (reply.includes('[ORDER_DONE]')) {
          reply = reply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *নতুন কনফার্ম অর্ডার এসেছে!*\nকাস্টমার: ${customerNum}\nঅর্ডার মেসেজ:\n${cleanText}`
          });
        }

        await sock.sendMessage(jid, { text: reply });
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
        <p style="color:#d97706;font-weight:bold;">কোডটি আসার ৩০ সেকেন্ডের মধ্যে হোয়াটসঅ্যাপে বসান (দেরি করলে কানেকশন ক্লোজ হয়ে যায়)</p>
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">✅ বট সক্রিয় এবং হোয়াটসঅ্যাপের সাথে যুক্ত আছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
