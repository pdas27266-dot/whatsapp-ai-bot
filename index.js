const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

// বটের নম্বর ও বসের নম্বর
const BOT_PHONE_NUMBER = '8801739241206';
const BOSS_JID = '8801789631882@s.whatsapp.net';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const chatHistories = new Map();
const humanPausedChats = new Map();
const messageQueues = new Map();
const debounceTimers = new Map();
let bossCustomRules = '';
let currentPairingCode = '';

const BASE_SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন শপের অত্যন্ত বিনয়ী, আন্তরিক ও বাস্তবমুখী বিক্রেতা।
কঠোর নিয়মাবলী:
১. কোনো বড় আনুষ্ঠানিক ডায়লগ দেবে না। সাধারণ মানুষ যেভাবে হোয়াটসঅ্যাপে ১-২ লাইনে চ্যাট করে সেভাবে উত্তর দেবে।
২. কাস্টমার যদি বলে "আচ্ছা", "একটু পর মেসেজ দিচ্ছি" বা "দাঁড়ান", তখন বলবে "আচ্ছা ঠিক আছে, কোনো সমস্যা নেই।"
৩. কাস্টমার অর্ডার কনফার্ম করতে চাইলে শুধু নাম, ঠিকানা ও ১১ ডিজিটের মোবাইল নম্বর চাইবে।
৪. কাস্টমার সব তথ্য দিলে তবেই বলবে: "ধন্যবাদ! আপনার অর্ডারটি গ্রহণ করা হয়েছে।" এবং উত্তরের শেষে লিখবে [ORDER_COMPLETED]।
৫. কোনো তথ্য জানা না থাকলে বলবে "আমি চেক করে জানাচ্ছি" এবং শেষে লিখবে [NEED_HELP]।
`;

async function generateAIReply(jid, userText) {
  let history = chatHistories.get(jid) || [];
  history.push({ role: 'user', text: userText });
  if (history.length > 8) history = history.slice(-8);
  chatHistories.set(jid, history);

  const fullPrompt = `${BASE_SYSTEM_INSTRUCTION}\nবসের বিশেষ নিয়মাবলী:\n${bossCustomRules}`;
  const conversation = history.map(h => `${h.role === 'user' ? 'Customer' : 'Seller'}: ${h.text}`).join('\n');

  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest'];

  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: conversation,
        config: { systemInstruction: fullPrompt, temperature: 0.4 }
      });
      const reply = typeof response.text === 'function' ? response.text() : response.text;
      if (reply) {
        history.push({ role: 'model', text: reply.trim() });
        chatHistories.set(jid, history);
        return reply.trim();
      }
    } catch (e) {}
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

  // পেয়ারিং কোড তৈরির রিকোয়েস্ট (যদি ডিভাইস কানেক্ট না থাকে)
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        currentPairingCode = code;
        console.log(`Pairing Code তৈরি হয়েছে: ${currentPairingCode}`);
      } catch (err) {
        console.error('Pairing code তৈরিতে সমস্যা:', err.message);
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
      console.log('WhatsApp সফলভাবে চালু হয়েছে!');
      currentPairingCode = '';
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue;

      const userText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!userText) continue;

      const isBoss = jid.includes('01789631882') || jid === BOSS_JID;
      if (isBoss && (userText.startsWith('!শিখুন') || userText.startsWith('!learn'))) {
        const newInstruction = userText.replace(/^(!শিখুন|!learn)\s*[:]?\s*/i, '').trim();
        bossCustomRules += `\n- ${newInstruction}`;
        await sock.sendMessage(jid, { text: `✅ বস, নতুন তথ্য যুক্ত করেছি:\n"${newInstruction}"` });
        continue;
      }

      if (isBoss && (userText === '!নিয়ম' || userText === '!rules')) {
        await sock.sendMessage(jid, { text: `📋 সংরক্ষিত নিয়মাবলী:\n${bossCustomRules || 'এখনো কোনো নিয়ম যোগ করা হয়নি।'}` });
        continue;
      }

      // আপনি মেসেজ পাঠালে ৫ মিনিট পজ
      if (msg.key.fromMe) {
        humanPausedChats.set(jid, Date.now() + 5 * 60 * 1000);
        continue;
      }

      const pauseUntil = humanPausedChats.get(jid) || 0;
      if (Date.now() < pauseUntil) continue;

      let queue = messageQueues.get(jid) || [];
      queue.push(userText);
      messageQueues.set(jid, queue);

      if (debounceTimers.has(jid)) {
        clearTimeout(debounceTimers.get(jid));
      }

      debounceTimers.set(jid, setTimeout(async () => {
        const fullUserMessage = (messageQueues.get(jid) || []).join(' ');
        messageQueues.delete(jid);
        debounceTimers.delete(jid);

        try {
          let replyText = await generateAIReply(jid, fullUserMessage);
          if (!replyText) return;

          if (replyText.includes('[ORDER_COMPLETED]')) {
            replyText = replyText.replace('[ORDER_COMPLETED]', '').trim();
            await sock.sendMessage(BOSS_JID, {
              text: `📦 *নতুন অর্ডার অ্যালার্ট!*\nকাস্টমার: ${jid.replace('@s.whatsapp.net', '')}\nতথ্য: ${fullUserMessage}`
            });
          }

          if (replyText.includes('[NEED_HELP]')) {
            replyText = replyText.replace('[NEED_HELP]', '').trim();
            await sock.sendMessage(BOSS_JID, {
              text: `⚠️ *সাহায্য প্রয়োজন!*\nকাস্টমার: "${fullUserMessage}"\nনম্বর: ${jid.replace('@s.whatsapp.net', '')}`
            });
          }

          await sock.sendMessage(jid, { text: replyText });
        } catch (err) {
          console.error('মেসেজ প্রসেসিং এরর:', err.message);
        }
      }, 3000));
    }
  });
}

app.get('/', (req, res) => {
  if (currentPairingCode) {
    res.send(`
      <div style="text-align:center;margin-top:60px;font-family:sans-serif;">
        <h2 style="color:#333;">আপনার WhatsApp পেয়ারিং কোড:</h2>
        <div style="display:inline-block;background:#f0fdf4;border:2px dashed #22c55e;padding:15px 30px;border-radius:12px;margin:20px 0;">
          <h1 style="font-size:42px;letter-spacing:6px;color:#16a34a;margin:0;">${currentPairingCode}</h1>
        </div>
        <p style="color:#666;font-size:16px;">WhatsApp-এর <b>"Enter code"</b> পেজে এই কোডটি লিখুন।</p>
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">বট সক্রিয় রয়েছে এবং WhatsApp যুক্ত আছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
