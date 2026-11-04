const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

let currentPairingCode = '';
const chatHistory = new Map();
const alertCooldown = new Map();

const STORE_BRAIN = `
তুমি RS SHOP BD অনলাইন স্টোরের একজন অত্যন্ত স্মার্ট, বাস্তবমুখী ও অভিজ্ঞ সেলসম্যান।
তোমার ব্যবহার হবে রক্ত-মাংসের মানুষের মতো মিষ্টি, সাবলীল এবং আন্তরিক।

আমাদের শপের পণ্য ও বিস্তারিত তথ্য:
১. সাকুরা মাড মাস্ক (Sakura Mud Mask):
   - দাম: ২৪০ টাকা (১ প্যাকেটে ১২ পিস থাকে)।
   - কাজ/উপকারিতা: ত্বক গভীরভাবে পরিষ্কার করে, ত্বকের অতিরিক্ত তেল দূর করে, ত্বক উজ্জ্বল ও মসৃণ করে।
২. শিট মাস্ক (Sheet Mask):
   - দাম: ৬০ টাকা প্রতি পিস।
   - কাজ: ত্বককে দ্রুত হাইড্রেট ও সফট করে।
৩. রাইস ফেস ওয়াশ (Rice Face Wash):
   - দাম: ৮৫০ টাকা।
   - কাজ: ত্বক ভেতর থেকে পরিষ্কার করে ও গ্লো বাড়াতে সাহায্য করে।
৪. ডেলিভারি তথ্য:
   - ব্রাহ্মণবাড়িয়ার ভিতরে: ৭০ টাকা।
   - ব্রাহ্মণবাড়িয়ার বাইরে: ১২০ টাকা।
   - সময়: ২ থেকে ৩ দিন। ক্যাশ অন ডেলিভারি সুবিধা আছে।

সেলস নিয়মাবলী:
১. কাস্টমার যেভাবে কথা বলবে (বাংলা, রোমান বাংলা বা বাংলিশ), তুমি ঠিক সেভাবে মানুষের মতো ১-২ লাইনে মিষ্টি ভাষায় উত্তর দেবে।
২. কাস্টমার যদি হাই/হ্যালো/সালাম দেয়, আন্তরিকভাবে কুশল বিনিময় করবে এবং কীভাবে সাহায্য করতে পারো জানতে চাইবে।
৩. কোনো পণ্যের কাজ জানতে চাইলে উপরে দেওয়া তথ্য অনুযায়ী সংক্ষেপে বুঝিয়ে বলবে।
৪. তালিকায় নেই এমন কোনো পণ্য চাইলে (যেমন লিপস্টিক, ক্রিম বা অন্য কিছু) মিষ্টি করে বলবে: "এই প্রোডাক্টটি বর্তমানে আমাদের স্টকে নেই, তবে আমি আমাদের ওনারকে জানিয়ে রাখছি।" এবং মেসেজের শেষে গোপনে [ASK_BOSS] লিখবে।
৫. কাস্টমার কিনতে চাইলে অর্ডার ফর্ম দেবে:
নাম : 
জেলা : 
থানা : 
গ্রাম বা রোড নং : 
মোবাইল নাম্বার : 
কি প্রডাক্ট নিতে চাচ্ছেন :
৬. অর্ডার ফর্ম দিলে বলবে: "ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পেয়ে যাবেন।" এবং শেষে [ORDER_DONE] লিখবে।
`;

async function getSalesReply(jid, userText) {
  let history = chatHistory.get(jid) || [];
  
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: STORE_BRAIN,
      generationConfig: { temperature: 0.4 }
    });

    const chat = model.startChat({
      history: history
    });

    const result = await chat.sendMessage(userText);
    const reply = result.response.text().trim();

    // হিস্ট্রি আপডেট
    history.push({ role: 'user', parts: [{ text: userText }] });
    history.push({ role: 'model', parts: [{ text: reply.replace(/\[ORDER_DONE\]|\[ASK_BOSS\]/g, '').trim() }] });
    if (history.length > 8) history = history.slice(-8);
    chatHistory.set(jid, history);

    return reply;
  } catch (error) {
    console.error('Gemini API Error:', error.message);
  }

  // কোনো কারণে এআই সংযোগে সমস্যা হলে সঠিক প্রাথমিক উত্তর
  const text = userText.toLowerCase();
  if (text.includes('কাজ') || text.includes('kaj')) {
    return 'সাকুরা মাড মাস্ক ত্বক গভীরভাবে পরিষ্কার করে, বাড়তি তেল দূর করে এবং ত্বক উজ্জ্বল ও সফট রাখে।';
  }
  if (text.includes('sakura') || text.includes('সাকুরা')) {
    return 'সাকুরা মাড মাস্ক ১ প্যাকেট ২৪০ টাকা (১২ পিস)। ডেলিভারি ব্রাহ্মণবাড়িয়ায় ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (text.includes('অর্ডার') || text.includes('order')) {
    return "অর্ডার করতে নিচের তথ্যগুলো লিখে পাঠান:\n\nনাম :\nজেলা :\nথানা :\nগ্রাম বা রোড নং :\nমোবাইল নাম্বার :\nকি প্রডাক্ট নিতে চাচ্ছেন :";
  }
  return 'আসসালামু আলাইকুম! RS SHOP BD-তে স্বাগতম। আপনি কোন প্রোডাক্টটি সম্পর্কে জানতে চাচ্ছেন?';
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
              text: `⚠️ *কাস্টমারের রিকোয়ারমেন্ট!*\nনম্বর: ${customerNumber}\nমেসেজ: "${cleanText}"`
            });
          }
        }

        // অর্ডার কমপ্লিট হলে বসের কাছে অ্যালার্ট
        if (reply.includes('[ORDER_DONE]')) {
          reply = reply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *কনফার্ম অর্ডার!*\nকাস্টমার: ${customerNumber}\nমেসেজ:\n${cleanText}`
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
