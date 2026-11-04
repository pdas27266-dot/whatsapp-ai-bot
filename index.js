const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

let currentPairingCode = '';
const conversationHistory = new Map();
const lastAlertTime = new Map();

// শপের আসল তথ্য ও নির্দেশিকা
const STORE_INSTRUCTION = `
তুমি RS SHOP BD-এর একজন বাস্তবমুখী, বিনয়ী ও চটপটে সেলস অ্যাসিস্ট্যান্ট।
কাস্টমার যেভাবে কথা বলবে (বাংলা বা বাংলিশ), তুমি অত্যন্ত স্বাভাবিক ও মিষ্টি বাংলায় ১-২ লাইনে উত্তর দেবে। কোনো রোবটের মতো একই কথা বারবার বলবে না।

শপের প্রোডাক্ট ও মূল্য তালিকা:
- সাকুরা মাড মাস্ক (Sakura Mud Mask): ১ প্যাকেট ২৪০ টাকা (১২ পিস থাকে)।
- শিট মাস্ক (Sheet Mask): প্রতি পিস ৬০ টাকা।
- রাইস ফেস ওয়াশ: ৮৫০ টাকা।
- ডেলিভারি চার্জ: ব্রাহ্মণবাড়িয়ার ভিতরে ৭০ টাকা, ব্রাহ্মণবাড়িয়ার বাইরে ১২০ টাকা। সময় ২-৩ দিন।

কঠোর নিয়মাবলী:
১. কাস্টমার যদি এমন কোনো প্রোডাক্ট চায় যা আমাদের তালিকায় নেই (যেমন: লিপস্টিক, ক্রিম, সানস্ক্রিন বা অন্য কিছু):
   - কখনোই বলবে না "স্টকে নেই" বা "আমাদের কাছে নেই"।
   - কাস্টমারকে স্বাভাবিকভাবে বলবে: "জি, একটু অপেক্ষা করুন, আমি চেক করে আপনাকে বিস্তারিত জানাচ্ছি।"
   - এবং এই মেসেজের শেষে অবশ্যই [ASK_BOSS] লিখে দেবে।
২. কাস্টমার সালাম বা হাই দিলে স্বাভাবিকভাবে সালামের উত্তর দেবে।
৩. কাস্টমার কোনো প্রোডাক্ট অর্ডার করতে চাইলে এই ফর্মটি পূরণ করতে বলবে:
নাম : 
জেলা : 
থানা : 
গ্রাম বা রোড নং : 
মোবাইল নাম্বার : 
কি প্রডাক্ট নিতে চাচ্ছেন :
৪. অর্ডার ফর্ম পূরণ করে দিলে বলবে: "ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ধৈর্য ধরে অপেক্ষা করুন, ২-৩ দিনের মধ্যে প্রোডাক্ট পেয়ে যাবেন।" এবং শেষে [ORDER_DONE] লিখে দেবে।
`;

// গুগল অফিশিয়াল ডিরেক্ট REST API কল
async function askAI(jid, userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY পাওয়া যায়নি!");
    return null;
  }

  let history = conversationHistory.get(jid) || [];
  history.push({ role: 'user', parts: [{ text: userText }] });
  if (history.length > 8) history = history.slice(-8);

  // v1beta এর পরিবর্তে একদম স্টেবল v1 এপিআই ও মডেল
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: STORE_INSTRUCTION }] },
        contents: history,
        generationConfig: { temperature: 0.3 }
      })
    });

    const data = await res.json();

    if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      const reply = data.candidates[0].content.parts[0].text.trim();
      const cleanToSave = reply.replace(/\[ORDER_DONE\]|\[ASK_BOSS\]/g, '').trim();
      history.push({ role: 'model', parts: [{ text: cleanToSave }] });
      conversationHistory.set(jid, history);
      return reply;
    } else {
      console.error('API Error Response:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('Fetch Error:', err.message);
  }

  // যদি কোনো কারণে এআই অফলাইন থাকে, প্রাসঙ্গিক উত্তর দেওয়া
  const low = userText.toLowerCase();
  if (low.includes('sakura') || low.includes('সাকুরা')) {
    return 'সাকুরা মাড মাস্ক ১ প্যাকেট ২৪০ টাকা (১২ পিস)। ডেলিভারি ব্রাহ্মণবাড়িয়ায় ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (low.includes('sheet') || low.includes('শিট')) {
    return 'শিট মাস্ক ৬০ টাকা প্রতি পিস। ডেলিভারি ব্রাহ্মণবাড়িয়ায় ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (low.includes('order') || low.includes('অর্ডার')) {
    return "অর্ডার করতে নিচের তথ্যগুলো লিখে পাঠান:\n\nনাম :\nজেলা :\nথানা :\nগ্রাম বা রোড নং :\nমোবাইল নাম্বার :\nকি প্রডাক্ট নিতে চাচ্ছেন :";
  }

  return 'জি, একটু অপেক্ষা করুন, আমি চেক করে আপনাকে বিস্তারিত জানাচ্ছি। [ASK_BOSS]';
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
        let aiReply = await askAI(jid, cleanText);
        if (!aiReply) continue;

        // অজানা কোনো প্রোডাক্ট চাইলে বসকে অ্যালার্ট (একই কাস্টমারের জন্য ৫ মিনিটে সর্বোচ্চ ১ বার)
        if (aiReply.includes('[ASK_BOSS]')) {
          aiReply = aiReply.replace('[ASK_BOSS]', '').trim();
          const now = Date.now();
          const lastAlert = lastAlertTime.get(jid) || 0;

          if (now - lastAlert > 300000) {
            lastAlertTime.set(jid, now);
            await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
              text: `⚠️ *কাস্টমারের অন্য প্রোডাক্টের অনুসন্ধান!*\nকাস্টমার নম্বর: ${customerNumber}\nমেসেজ: "${cleanText}"\n(কাস্টমারকে বলা হয়েছে আপনি চেক করে জানাবেন)`
            });
          }
        }

        // অর্ডার কনফার্ম অ্যালার্ট
        if (aiReply.includes('[ORDER_DONE]')) {
          aiReply = aiReply.replace('[ORDER_DONE]', '').trim();
          await sock.sendMessage(`${BOSS_PHONE_NUMBER}@s.whatsapp.net`, {
            text: `📦 *নতুন নিশ্চিত অর্ডার এসেছে!*\nকাস্টমার: ${customerNumber}\nঅর্ডার মেসেজ:\n${cleanText}`
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
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">✅ বট সফলভাবে সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
