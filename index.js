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

// একজন অভিজ্ঞ মানুষের ব্রেইন ও বিস্তারিত শপ ডেটা
const STORE_PROMPT = `
তুমি RS SHOP BD অনলাইন স্টোরের অত্যন্ত অভিজ্ঞ, চটপটে ও বাস্তবমুখী সেলস এজেন্ট।
তোমার কাজ একজন রক্ত-মাংসের মানুষের মতো মিষ্টি ও সাবলীল ভাষায় কাস্টমারের সাথে কথা বলা।

আমাদের শপের প্রোডাক্ট তালিকা ও পূর্ণ বিবরণ:
১. সাকুরা মাড মাস্ক (Sakura Mud Mask):
   - দাম: ১ প্যাকেট ২৪০ টাকা (প্যাকেটে ১২ পিস থাকে)।
   - কাজ/উপকারিতা: ত্বক গভীরভাবে পরিষ্কার করে, ত্বকের বাড়তি তেল দূর করে ও ত্বক সফট রাখে।
২. শিট মাস্ক (Sheet Mask):
   - দাম: ৬০ টাকা প্রতি পিস।
   - কাজ: ত্বককে ইনস্ট্যান্ট হাইড্রেট, নরম ও ময়েশ্চারাইজড করে।
৩. রাইস ফেস ওয়াশ (Rice Face Wash):
   - দাম: ৮৫০ টাকা।
   - কাজ: ত্বক ভেতর থেকে পরিষ্কার করে, রোদে পোড়া ভাব দূর করতে সাহায্য করে এবং ত্বকে প্রাকৃতিক গ্লো আনে।
৪. ডেলিভারি নিয়মাবলী:
   - ব্রাহ্মণবাড়িয়ার ভিতরে: ৭০ টাকা।
   - ব্রাহ্মণবাড়িয়ার বাইরে: ১২০ টাকা।
   - সময়: ২ থেকে ৩ দিন। সারা বাংলাদেশে ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।

কথা বলার নিয়মাবলী:
১. কাস্টমার বাংলা, ইংরেজি বা বাংলিশ (যেমন: "rice face wash nite chay", "Eirar kaj ki", "dam koto", "sakura mask achy") যাই লিখুক, আগের কথার সাথে মিলিয়ে বুঝে নিয়ে মিষ্টি ও স্পষ্ট বাংলায় ১-২ লাইনে উত্তর দেবে।
২. কাস্টমার যদি আগের কোনো প্রোডাক্ট দেখিয়ে বলে "এটার কাজ কি" বা "ব্যবহার কি", ঠিক সেই প্রোডাক্টটির কাজ সুন্দর করে বুঝিয়ে বলবে।
৩. তালিকায় নেই এমন প্রোডাক্ট চাইলে সরাসরি কাস্টমারকে বলবে: "এই প্রোডাক্টটি বর্তমানে আমাদের স্টকে নেই, তবে আমি আমাদের ওনারকে জানিয়ে রাখছি।" এবং মেসেজের শেষে [ASK_BOSS] লিখে দেবে।
৪. কাস্টমার প্রোডাক্ট নিতে চাইলে বা অর্ডার করতে চাইলে এই ফরম্যাটটি দেবে:
নাম : 
জেলা : 
থানা : 
গ্রাম বা রোড নং : 
মোবাইল নাম্বার : 
কি প্রডাক্ট নিতে চাচ্ছেন :
৫. ফরম পূরণ করে দিলে বলবে: "ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পেয়ে যাবেন।" এবং শেষে [ORDER_DONE] লিখে দেবে।
`;

async function getGroqAIReply(jid, userText) {
  const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;

  let history = conversationHistory.get(jid) || [];
  history.push({ role: 'user', content: userText });
  if (history.length > 8) history = history.slice(-8);

  const messagesPayload = [
    { role: 'system', content: STORE_PROMPT },
    ...history
  ];

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messagesPayload,
        temperature: 0.3,
        max_tokens: 300
      })
    });

    const data = await res.json();
    if (data?.choices?.[0]?.message?.content) {
      const reply = data.choices[0].message.content.trim();
      const cleanReply = reply.replace(/\[ORDER_DONE\]|\[ASK_BOSS\]/g, '').trim();
      history.push({ role: 'assistant', content: cleanReply });
      conversationHistory.set(jid, history);
      return reply;
    }
  } catch (err) {
    console.error('Groq API Error:', err.message);
  }

  // ইমার্জেন্সি ফলব্যাক
  if (userText.toLowerCase().includes('order') || userText.includes('অর্ডার')) {
    return "অর্ডার কনফার্ম করতে নিচের তথ্যগুলো লিখে পাঠান:\n\nনাম :\nজেলা :\nথানা :\nগ্রাম বা রোড নং :\nমোবাইল নাম্বার :\nকি প্রডাক্ট নিতে চাচ্ছেন :";
  }
  return "জি, আমি RS SHOP BD থেকে বলছি। আপনি কি সাকুরা মাড মাস্ক, শিট মাস্ক নাকি রাইস ফেস ওয়াশ সম্পর্কে জানতে চান?";
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
        let reply = await getGroqAIReply(jid, cleanText);
        if (!reply) continue;

        // অজানা কোনো পণ্য চাইলে বসকে ৫ মিনিটে সর্বোচ্চ একবার সতর্কবার্তা
        if (reply.includes('[ASK_BOSS]')) {
          reply = reply.replace('[ASK_BOSS]', '').trim();
          const now = Date.now();
          const lastAlert = bossAlertCooldown.get(jid) || 0;
          if (now - lastAlert > 300000) {
            bossAlertCooldown.set(jid, now);
            await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
              text: `⚠️ *কাস্টমারের নতুন অনুসন্ধান!*\nনম্বর: ${customerNumber}\nমেসেজ: "${cleanText}"`
            });
          }
        }

        // অর্ডার হলে নোটিফিকেশন
        if (reply.includes('[ORDER_DONE]')) {
          reply = reply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *কনফার্ম অর্ডার এসেছে!*\nকাস্টমার: ${customerNumber}\nমেসেজ:\n${cleanText}`
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
