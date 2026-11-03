const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

const BOT_PHONE_NUMBER = '8801739241206';
let ACTIVE_BOSS_JID = '8801789631882@s.whatsapp.net';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const chatHistories = new Map();
const humanPausedChats = new Map();
const debounceTimers = new Map();
const messageQueues = new Map();
let bossCustomRules = '';
let currentPairingCode = '';

const SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন শপের অত্যন্ত দ্রুত, বিনয়ী ও চটপটে সেলস অ্যাসিস্ট্যান্ট।
কঠোর নিয়ম:
১. সবসময় ১-২ লাইনে মিষ্টি ও স্বাভাবিক বাংলায় দ্রুত উত্তর দেবে। কোনো আনুষ্ঠানিক ডায়লগ দেবে না।
২. তোমার জানা তথ্য এবং বসের দেওয়া তথ্যের বাইরে কোনো মনগড়া বা আন্দাজে কথা বলবে না।
৩. কাস্টমার যদি এমন কোনো পণ্যের দাম বা তথ্য জানতে চায় যা বসের নিয়মে নেই, তবে সরাসরি বলবে: "একটু অপেক্ষা করুন, আমি চেক করে জানাচ্ছি।" এবং উত্তরের শেষে অবশ্যই [HELP_NEEDED] লিখবে।
৪. কাস্টমার অর্ডার করতে চাইলে শুধু নাম, ঠিকানা ও ১১ ডিজিটের নম্বর চেয়ে নেবে। সব তথ্য পাওয়ার পর বলবে: "ধন্যবাদ! আপনার অর্ডারটি গ্রহণ করা হয়েছে।" এবং শেষে [ORDER_COMPLETED] লিখবে।
`;

async function generateAIReply(jid, userText) {
  let history = chatHistories.get(jid) || [];
  history.push({ role: 'user', text: userText });
  if (history.length > 6) history = history.slice(-6);
  chatHistories.set(jid, history);

  const fullPrompt = `${SYSTEM_INSTRUCTION}\nবসের শেখানো পণ্যের তথ্য ও নিয়মাবলী:\n${bossCustomRules}`;
  const conversation = history.map(h => `${h.role === 'user' ? 'Customer' : 'Seller'}: ${h.text}`).join('\n');

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: conversation,
      config: { systemInstruction: fullPrompt, temperature: 0.3 }
    });
    const reply = typeof response.text === 'function' ? response.text() : response.text;
    if (reply) {
      history.push({ role: 'model', text: reply.trim() });
      chatHistories.set(jid, history);
      return reply.trim();
    }
  } catch (e) {
    try {
      const fallback = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: conversation,
        config: { systemInstruction: fullPrompt, temperature: 0.3 }
      });
      const fallbackText = typeof fallback.text === 'function' ? fallback.text() : fallback.text;
      if (fallbackText) return fallbackText.trim();
    } catch (err) {}
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
        console.error('Pairing Code Error:', err.message);
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
      console.log('WhatsApp Connected!');
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

      const cleanText = userText.trim();

      // ==========================================
      // ১. তাৎক্ষণিক বস ট্রেনিং (কোনো বিলম্ব ছাড়া ১ সেকেন্ডে শিখবে)
      // ==========================================
      if (cleanText.startsWith('!শিখুন') || cleanText.startsWith('!learn')) {
        ACTIVE_BOSS_JID = jid; // আপনার আইডি অটো সেভ করে নেবে
        const newRule = cleanText.replace(/^(!শিখুন|!learn)\s*[:]?\s*/i, '').trim();
        if (newRule) {
          bossCustomRules += `\n- ${newRule}`;
          await sock.sendMessage(jid, { 
            text: `✅ বস, তথ্যটি সাথে সাথে মুখস্থ করে নিয়েছি!\n📌 "${newRule}"\nএখন থেকে কাস্টমার জানতে চাইলে ৩ সেকেন্ডে উত্তর দেব।` 
          });
        }
        continue;
      }

      if (cleanText === '!নিয়ম' || cleanText === '!rules') {
        ACTIVE_BOSS_JID = jid;
        await sock.sendMessage(jid, { 
          text: `📋 বর্তমানে মুখস্থ থাকা তথ্যাবলী:\n${bossCustomRules || 'এখনো কোনো তথ্য যোগ করা হয়নি।'}` 
        });
        continue;
      }

      // আপনি মেসেজ পাঠালে ৫ মিনিট মিউট
      if (msg.key.fromMe) {
        humanPausedChats.set(jid, Date.now() + 5 * 60 * 1000);
        continue;
      }

      const pauseUntil = humanPausedChats.get(jid) || 0;
      if (Date.now() < pauseUntil) continue;

      // ==========================================
      // ২. মাত্র ৮০০ms বাফার (৩-৫ সেকেন্ডে রিপ্লাই সম্পন্ন হবে)
      // ==========================================
      let queue = messageQueues.get(jid) || [];
      queue.push(userText);
      messageQueues.set(jid, queue);

      if (debounceTimers.has(jid)) {
        clearTimeout(debounceTimers.get(jid));
      }

      debounceTimers.set(jid, setTimeout(async () => {
        const fullMessage = (messageQueues.get(jid) || []).join(' ');
        messageQueues.delete(jid);
        debounceTimers.delete(jid);

        try {
          let replyText = await generateAIReply(jid, fullMessage);
          if (!replyText) return;

          // না বুঝলে বসকে অ্যালার্ট
          if (replyText.includes('[HELP_NEEDED]')) {
            replyText = replyText.replace('[HELP_NEEDED]', '').trim();
            await sock.sendMessage(ACTIVE_BOSS_JID, {
              text: `⚠️ *বস, কাস্টমারের সাহায্য প্রয়োজন!*\n💬 প্রশ্ন: "${fullMessage}"\n👉 আমি বলেছি চেক করে জানাচ্ছি, আপনি একটু ইনবক্সে দেখুন।`
            });
          }

          // অর্ডার অ্যালার্ট
          if (replyText.includes('[ORDER_COMPLETED]')) {
            replyText = replyText.replace('[ORDER_COMPLETED]', '').trim();
            await sock.sendMessage(ACTIVE_BOSS_JID, {
              text: `📦 *নতুন অর্ডার এসেছে!*\n💬 তথ্য: ${fullMessage}`
            });
          }

          await sock.sendMessage(jid, { text: replyText });
        } catch (err) {
          console.error('Error:', err.message);
        }
      }, 800));
    }
  });
}

app.get('/', (req, res) => {
  if (currentPairingCode) {
    res.send(`
      <div style="text-align:center;margin-top:60px;font-family:sans-serif;">
        <h2>WhatsApp পেয়ারিং কোড:</h2>
        <h1 style="font-size:45px;color:#16a34a;letter-spacing:6px;">${currentPairingCode}</h1>
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">বট সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
