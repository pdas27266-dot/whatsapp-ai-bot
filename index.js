const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

// ফোন নম্বরসমূহ
const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_JID = '8801789631882@s.whatsapp.net';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let currentPairingCode = '';
let customLearnedRules = '';

// শপের স্থায়ী তথ্য ও নির্দেশাবলী
const STORE_RULES = `
তুমি একটি অনলাইন শপের অত্যন্ত দক্ষ, বিনয়ী ও দ্রুতগতির সেলস এজেন্ট।

আমাদের শপের স্থায়ী পণ্যের তথ্য ও নিয়ম:
১. প্রোডাক্ট: সাকুরা মাড মাস্ক (Sakura Mud Mask)।
২. দাম: ১ প্যাকেট ২৪০ টাকা (প্রতি প্যাকেটে ১২ পিস থাকে)।
৩. ডেলিভারি চার্জ: ব্রাহ্মণবাড়িয়ার ভেতরে ৭০ টাকা, ব্রাহ্মণবাড়িয়ার বাইরে ১২০ টাকা।
৪. কাস্টমার যদি বাংলিশে লেখে (যেমন: "price koto", "dam koto", "sakura mask nibo") অথবা বাংলায় লেখে, সবসময় সুন্দর ও প্রফেশনাল বাংলায় উত্তর দেবে। কথা বেশি বড় করবে না, ১-২ লাইনে ক্লিয়ার উত্তর দেবে।
৫. কাস্টমার যদি অর্ডার করতে চায়, তাকে এই ফর্মটি পূরণ করে দিতে বলবে:
   নাম : 
   জেলা : 
   থানা : 
   গ্রাম বা রোড নং : 
   মোবাইল নাম্বার : 
   কি প্রডাক্ট নিতে চাচ্ছেন : 
৬. কাস্টমার এই তথ্যগুলো লিখে দিলে বলবে: "আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ধৈর্য ধরে অপেক্ষা করুন, ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পাবেন।" এবং মেসেজের একেবারে শেষে লিখবে [ORDER_COMPLETED]।
৭. এই পণ্যের বাইরে অন্য কোনো পণ্যের তথ্য কাস্টমার জানতে চাইলে বানিয়ে বলবে না, বলবে: "একটু অপেক্ষা করুন, আমি চেক করে জানাচ্ছি।" এবং মেসেজের শেষে লিখবে [NEED_BOSS_HELP]।
`;

// AI রিপ্লাই তৈরি
async function getAIReply(userMessage) {
  const fullPrompt = `${STORE_RULES}\nবসের অতিরিক্ত নিয়ম:\n${customLearnedRules}`;
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userMessage,
      config: {
        systemInstruction: fullPrompt,
        temperature: 0.3
      }
    });
    const reply = typeof response.text === 'function' ? response.text() : response.text;
    return reply ? reply.trim() : null;
  } catch (error) {
    console.error('Gemini API Error:', error.message);
    return null;
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  // পেয়ারিং কোড তৈরি (যদি লগইন করা না থাকে)
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

      // গ্রুপ মেসেজ এবং বটের নিজের মেসেজ ইগনোর করা
      if (!jid || jid.endsWith('@g.us') || msg.key.fromMe) continue;

      const userText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!userText) continue;

      const cleanText = userText.trim();

      // বস কমান্ড হ্যান্ডলিং (আপনার 01789631882 নম্বর থেকে)
      const isBoss = jid.includes('01789631882') || jid === BOSS_JID;
      if (isBoss && (cleanText.startsWith('!শিখুন') || cleanText.startsWith('!learn'))) {
        const newInstruction = cleanText.replace(/^(!শিখুন|!learn)\s*[:]?\s*/i, '').trim();
        if (newInstruction) {
          customLearnedRules += `\n- ${newInstruction}`;
          await sock.sendMessage(jid, { text: `✅ বস, নতুন নিয়ম যোগ করেছি:\n"${newInstruction}"` });
        }
        continue;
      }

      if (isBoss && (cleanText === '!নিয়ম' || cleanText === '!rules')) {
        await sock.sendMessage(jid, { text: `📋 বর্তমান সংরক্ষিত নিয়মাবলী:\n${customLearnedRules || 'এখনো নতুন কোনো নিয়ম দেননি।'}` });
        continue;
      }

      // সাধারণ কাস্টমার ও মেসেজ প্রসেসিং
      try {
        let aiReply = await getAIReply(cleanText);
        if (!aiReply) continue;

        // অর্ডার কমপ্লিট অ্যালার্ট বসকে পাঠানো
        if (aiReply.includes('[ORDER_COMPLETED]')) {
          aiReply = aiReply.replace('[ORDER_COMPLETED]', '').trim();
          await sock.sendMessage(BOSS_JID, {
            text: `📦 *নতুন অর্ডার অ্যালার্ট!*\nকাস্টমার: ${jid.replace('@s.whatsapp.net', '')}\nঅর্ডার মেসেজ: ${cleanText}`
          });
        }

        // না জানা তথ্যের অ্যালার্ট বসকে পাঠানো
        if (aiReply.includes('[NEED_BOSS_HELP]')) {
          aiReply = aiReply.replace('[NEED_BOSS_HELP]', '').trim();
          await sock.sendMessage(BOSS_JID, {
            text: `⚠️ *সাহায্য প্রয়োজন!*\nকাস্টমার জানতে চেয়েছে: "${cleanText}"\nনম্বর: ${jid.replace('@s.whatsapp.net', '')}`
          });
        }

        // কাস্টমারকে উত্তর পাঠানো
        await sock.sendMessage(jid, { text: aiReply });
      } catch (err) {
        console.error('Message reply error:', err.message);
      }
    }
  });
}

// ওয়েব সার্ভার পেজ (পেয়ারিং কোড দেখানোর জন্য)
app.get('/', (req, res) => {
  if (currentPairingCode) {
    res.send(`
      <div style="text-align:center;margin-top:60px;font-family:sans-serif;">
        <h2>WhatsApp পেয়ারিং কোড:</h2>
        <h1 style="font-size:45px;color:#16a34a;letter-spacing:6px;background:#f3f4f6;display:inline-block;padding:10px 25px;border-radius:10px;">${currentPairingCode}</h1>
        <p style="color:#555;margin-top:15px;">WhatsApp-এ Link with phone number দিয়ে কোডটি বসান।</p>
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;font-family:sans-serif;">✅ বট সফলভাবে সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
