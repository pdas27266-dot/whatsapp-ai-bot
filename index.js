const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_PHONE_NUMBER = '8801789631882';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let currentPairingCode = '';
let customLearnedRules = `
- শিট মাস্ক (Sheet Mask) এর দাম ৬০ টাকা।
`;

// কাস্টমারের সাথে কথা মনে রাখার ক্যাশ
const conversationMemory = new Map();

const STORE_SYSTEM_PROMPT = `
তুমি একটি অনলাইন শপের অত্যন্ত বিনয়ী, চটপটে ও বাস্তবমুখী সেলস অ্যাসিস্ট্যান্ট।
কঠোর নিয়মাবলী:
১. কাস্টমার বাংলায় লিখুক বা বাংলিশে (যেমন: "sheet mask koto", "dam koto", "ji", "onno kisu chai"), তুমি সবসময় অত্যন্ত আন্তরিক ও স্বাভাবিক বাংলায় ১-২ লাইনে উত্তর দেবে। কোনো বড় আনুষ্ঠানিক স্বাগতম বক্তব্য বারবার দেবে না।
২. বর্তমান পণ্যের তালিকা ও দাম:
   - সাকুরা মাড মাস্ক (Sakura Mud Mask): ১ প্যাকেট ২৪০ টাকা (১২ পিস থাকে)।
   - শিট মাস্ক: ৬০ টাকা।
৩. ডেলিভারি চার্জ:
   - ব্রাহ্মণবাড়িয়ার ভিতরে: ৭০ টাকা।
   - ব্রাহ্মণবাড়িয়ার বাইরে: ১২০ টাকা।
৪. কাস্টমার যদি বলে "অন্য কিছু চাই" বা এমন কোনো পণ্যের কথা বলে যা আমাদের তালিকায় নেই, সরাসরি বলবে: "দুঃখিত, বর্তমানে আমাদের কাছে শুধু সাকুরা মাড মাস্ক এবং শিট মাস্ক রয়েছে। আপনি কি এগুলোর কোনোটি নিতে চান?"
৫. কাস্টমার কোনো পণ্য কনফার্ম করতে চাইলে এই ফর্মটি পূরণ করতে বলবে:
   নাম:
   জেলা:
   থানা:
   গ্রাম বা রোড নং:
   মোবাইল নাম্বার:
   প্রোডাক্টের নাম:
৬. তথ্যগুলো দিলে বলবে: "আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ধৈর্য ধরে অপেক্ষা করুন, ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পাবেন।" এবং মেসেজের শেষে [ORDER_DONE] লিখবে।
`;

async function getAIReply(jid, userMessage) {
  let history = conversationMemory.get(jid) || [];
  history.push(`Customer: ${userMessage}`);
  if (history.length > 6) history = history.slice(-6);
  conversationMemory.set(jid, history);

  const fullPrompt = `${STORE_SYSTEM_PROMPT}\nবসের অতিরিক্ত নতুন তথ্য:\n${customLearnedRules}`;
  const promptContents = `${history.join('\n')}\nSeller:`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: promptContents,
      config: {
        systemInstruction: fullPrompt,
        temperature: 0.3
      }
    });

    const reply = typeof response.text === 'function' ? response.text() : response.text;
    if (reply) {
      const cleanReply = reply.trim();
      history.push(`Seller: ${cleanReply.replace('[ORDER_DONE]', '').trim()}`);
      conversationMemory.set(jid, history);
      return cleanReply;
    }
  } catch (err) {
    console.error('Gemini API Error:', err.message);
  }
  return 'একটু অপেক্ষা করুন, নেটওয়ার্কের কারণে মেসেজটি দেখতে দেরি হয়েছে। আপনি কি কোনো অর্ডার করতে চান?';
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

      // বস কমান্ড হ্যান্ডলিং (যেকোনো ফরম্যাটেই বসকে চিনবে)
      if (cleanText.startsWith('!শিখুন') || cleanText.startsWith('!learn')) {
        const newInstruction = cleanText.replace(/^(!শিখুন|!learn)\s*[:]?\s*/i, '').trim();
        if (newInstruction) {
          customLearnedRules += `\n- ${newInstruction}`;
          await sock.sendMessage(jid, { text: `✅ বস, নতুন তথ্য যুক্ত হয়েছে:\n"${newInstruction}"` });
        }
        continue;
      }

      if (cleanText === '!নিয়ম' || cleanText === '!rules') {
        await sock.sendMessage(jid, { text: `📋 বর্তমান নিয়মাবলী:\n${customLearnedRules}` });
        continue;
      }

      // এআই রিপ্লাই পাঠানো
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
        console.error('Reply send error:', e.message);
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
