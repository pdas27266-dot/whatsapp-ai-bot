const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

let currentPairingCode = '';
const chatHistory = new Map();
const alertCooldown = new Map();

// শপের আসল তথ্য ও একজন মানুষের মতো সেলসম্যানের প্রম্পট
const STORE_BRAIN = `
তুমি RS SHOP BD অনলাইন শপের একজন অত্যন্ত বুদ্ধিমান, অমায়িক এবং অভিজ্ঞ সেলসম্যান।
কাস্টমার যেভাবে কথা বলবে (বাংলা বা বাংলিশ), তুমি ঠিক সেভাবে মানুষের মতো সাবলীল ও মিষ্টি ভাষায় ১-২ লাইনে উত্তর দেবে। কোনো রোবটের মতো এক কথা বারবার বলবে না।

আমাদের শপের প্রোডাক্ট ও বিস্তারিত তথ্য:
১. সাকুরা মাড মাস্ক (Sakura Mud Mask):
   - দাম: ১ প্যাকেট ২৪০ টাকা (১২ পিস থাকে)।
   - কাজ: ত্বক গভীরভাবে পরিষ্কার করে, ত্বকের বাড়তি তেল দূর করে ও ত্বক সফট রাখে।
২. শিট মাস্ক (Sheet Mask):
   - দাম: প্রতি পিস ৬০ টাকা।
   - কাজ: ত্বককে ইনস্ট্যান্ট গ্লো ও হাইড্রেট করে।
৩. রাইস ফেস ওয়াশ (Rice Face Wash):
   - দাম: ৮৫০ টাকা।
   - কাজ: ত্বক ভেতর থেকে পরিষ্কার করে উজ্জ্বল করতে সাহায্য করে।
৪. ডেলিভারি তথ্য:
   - ব্রাহ্মণবাড়িয়ার ভিতরে: ৭০ টাকা।
   - ব্রাহ্মণবাড়িয়ার বাইরে: ১২০ টাকা।
   - ডেলিভারি সময় ২-৩ দিন। ক্যাশ অন ডেলিভারি সুবিধা আছে।

নিয়মাবলী:
১. কাস্টমার হাই, হ্যালো, সালাম দিলে মিষ্টি করে উত্তর দিয়ে জানতে চাইবে কীভাবে সাহায্য করতে পারো।
২. পণ্যের কাজ জানতে চাইলে বাস্তবসম্মতভাবে বুঝিয়ে বলবে।
৩. তালিকায় নেই এমন প্রোডাক্ট চাইলে বলবে: "এই প্রোডাক্টটি বর্তমানে আমাদের স্টকে নেই, তবে আমি আমাদের ওনারকে জানিয়ে রাখছি।" এবং মেসেজের শেষে [ASK_BOSS] লিখে দেবে।
৪. কাস্টমার অর্ডার করতে চাইলে এই ফর্মটি পূরণ করতে বলবে:
নাম : 
জেলা : 
থানা : 
গ্রাম বা রোড নং : 
মোবাইল নাম্বার : 
কি প্রডাক্ট নিতে চাচ্ছেন :
৫. তথ্য দিলে বলবে: "ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পাবেন।" এবং শেষে [ORDER_DONE] লিখবে।
`;

async function getSalesReply(jid, userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  let history = chatHistory.get(jid) || [];
  history.push({ role: 'user', parts: [{ text: userText }] });
  if (history.length > 8) history = history.slice(-8);

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];

  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: STORE_BRAIN }] },
          contents: history,
          generationConfig: { temperature: 0.3 }
        })
      });

      const data = await response.json();
      if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const reply = data.candidates[0].content.parts[0].text.trim();
        const cleanToStore = reply.replace(/\[ORDER_DONE\]|\[ASK_BOSS\]/g, '').trim();
        history.push({ role: 'model', parts: [{ text: cleanToStore }] });
        chatHistory.set(jid, history);
        return reply;
      }
    } catch (err) {}
  }

  // ইমার্জেন্সি ব্যাকআপ (যদি নেটওয়ার্ক সাময়িক স্লো থাকে)
  const text = userText.toLowerCase();
  if (text.includes('কাজ') || text.includes('kaj')) {
    return 'সাকুরা মাড মাস্ক ত্বক গভীরভাবে পরিষ্কার করে, বাড়তি তেল দূর করে ও ত্বক সফট রাখে।';
  }
  if (text.includes('sakura') || text.includes('সাকুরা')) {
    return 'সাকুরা মাড মাস্ক ১ প্যাকেট ২৪০ টাকা (১২ পিস থাকে)। ব্রাহ্মণবাড়িয়ার ভেতর ডেলিভারি ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (text.includes('sheet') || text.includes('শিট')) {
    return 'শিট মাস্ক প্রতি পিস ৬০ টাকা।';
  }
  if (text.includes('rice') || text.includes('রাইস')) {
    return 'রাইস ফেস ওয়াশ এর দাম ৮৫০ টাকা।';
  }
  if (text.includes('order') || text.includes('অর্ডার')) {
    return "অর্ডার করতে নিচের তথ্যগুলো লিখে পাঠান:\n\nনাম :\nজেলা :\nথানা :\nগ্রাম বা রোড নং :\nমোবাইল নাম্বার :\nকি প্রডাক্ট নিতে চাচ্ছেন :";
  }

  return 'আসসালামু আলাইকুম! RS SHOP BD-তে স্বাগতম। আপনি কোন প্রোডাক্টটি নিতে চাচ্ছেন?';
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
      const customerNumber = jid.replace(/@.+/, '');

      try {
        let reply = await getSalesReply(jid, cleanText);
        if (!reply) continue;

        // অজানা প্রোডাক্টের ক্ষেত্রে বসের কাছে নোটিফিকেশন (৫ মিনিটে একবার)
        if (reply.includes('[ASK_BOSS]')) {
          reply = reply.replace('[ASK_BOSS]', '').trim();
          const now = Date.now();
          const lastTime = alertCooldown.get(jid) || 0;
          if (now - lastTime > 300000) {
            alertCooldown.set(jid, now);
            await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
              text: `⚠️ *কাস্টমারের নতুন রিকোয়ারমেন্ট!*\nনম্বর: ${customerNumber}\nমেসেজ: "${cleanText}"`
            });
          }
        }

        // অর্ডার কমপ্লিট হলে অ্যালার্ট
        if (reply.includes('[ORDER_DONE]')) {
          reply = reply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *নতুন নিশ্চিত অর্ডার এসেছে!*\nকাস্টমার: ${customerNumber}\nঅর্ডার মেসেজ:\n${cleanText}`
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
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">✅ বট সফলভাবে সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
