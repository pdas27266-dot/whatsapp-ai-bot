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
const sentByBot = new Set(); // বটের নিজের পাঠানো মেসেজ চেনার মেমোরি
let bossCustomRules = '';
let currentPairingCode = '';

const SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন শপের অত্যন্ত দ্রুত, বিনয়ী ও চটপটে সেলস অ্যাসিস্ট্যান্ট।
কঠোর নিয়মাবলী:
১. সবসময় ১-২ লাইনে মিষ্টি ও স্বাভাবিক বাংলায় দ্রুত উত্তর দেবে। কোনো বাড়তি আনুষ্ঠানিক ডায়লগ দেবে না।
২. বসের দেওয়া পণ্যের তথ্য ও ডেলিভারি চার্জ সঠিকভাবে বলবে।
৩. কোনো তথ্য অজানা থাকলে বানিয়ে বলবে না, বলবে: "একটু অপেক্ষা করুন, আমি চেক করে জানাচ্ছি।" এবং উত্তরের শেষে লিখবে [HELP_NEEDED]।
৪. কাস্টমার অর্ডার করতে চাইলে ফরমটি দেবে এবং সব তথ্য পেলে বলবে: "আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ধৈর্য ধরে অপেক্ষা করুন, ২-৩ দিনের মধ্যে প্রোডাক্ট হাতে পাবেন।" এবং শেষে লিখবে [ORDER_COMPLETED]।
`;

async function generateAIReply(jid, userText) {
  let history = chatHistories.get(jid) || [];
  history.push({ role: 'user', text: userText });
  if (history.length > 6) history = history.slice(-6);
  chatHistories.set(jid, history);

  const fullPrompt = `${SYSTEM_INSTRUCTION}\nবসের শেখানো পণ্যের তথ্য ও নিয়মাবলী:\n${bossCustomRules}`;
  const conversation = history.map(h => `${h.role === 'user' ? 'Customer' : 'Seller'}: ${h.text}`).join('\n');

  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: model,
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
      console.log(`Model ${model} failed, trying next...`);
    }
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

  // সুরক্ষিত মেসেজ পাঠানোর ফাংশন (যাতে বট নিজেকে লক না করে)
  async function safeSendMessage(targetJid, textContent) {
    try {
      const sent = await sock.sendMessage(targetJid, { text: textContent });
      if (sent?.key?.id) {
        sentByBot.add(sent.key.id);
        setTimeout(() => sentByBot.delete(sent.key.id), 60000);
      }
    } catch (e) {
      console.error('Send error:', e.message);
    }
  }

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

      // বটের নিজের কোড থেকে পাঠানো মেসেজ হলে ইগনোর করবে (লক করবে না)
      if (sentByBot.has(msg.key.id)) {
        sentByBot.delete(msg.key.id);
        continue;
      }

      // আপনি নিজে ফোন থেকে হাত দিয়ে কোনো কাস্টমারকে মেসেজ দিলে তবেই ৫ মিনিট মিউট হবে
      if (msg.key.fromMe) {
        humanPausedChats.set(jid, Date.now() + 5 * 60 * 1000);
        continue;
      }

      const userText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!userText) continue;

      const cleanText = userText.trim();

      // বস কমান্ড
      if (cleanText.startsWith('!শিখুন') || cleanText.startsWith('!learn')) {
        ACTIVE_BOSS_JID = jid;
        const newRule = cleanText.replace(/^(!শিখুন|!learn)\s*[:]?\s*/i, '').trim();
        if (newRule) {
          bossCustomRules += `\n- ${newRule}`;
          await safeSendMessage(jid, `✅ বস, তথ্যটি মুখস্থ করে নিয়েছি!\nএখন টেস্ট করে দেখুন, উত্তর দিচ্ছি।`);
        }
        continue;
      }

      if (cleanText === '!নিয়ম' || cleanText === '!rules') {
        ACTIVE_BOSS_JID = jid;
        await safeSendMessage(jid, `📋 সংরক্ষিত তথ্য:\n${bossCustomRules || 'কোনো তথ্য নেই।'}`);
        continue;
      }

      // বস যখন টেস্ট করছেন তখন ৫ মিনিটের পজ প্রযোজ্য হবে না
      const isBossChat = (jid === ACTIVE_BOSS_JID || jid.includes('01789631882'));
      if (!isBossChat) {
        const pauseUntil = humanPausedChats.get(jid) || 0;
        if (Date.now() < pauseUntil) continue;
      }

      // দ্রুত মেসেজ কিউ
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

          if (replyText.includes('[HELP_NEEDED]')) {
            replyText = replyText.replace('[HELP_NEEDED]', '').trim();
            await safeSendMessage(ACTIVE_BOSS_JID, `⚠️ *বস, সাহায্য দরকার!*\nপ্রশ্ন: "${fullMessage}"\nনম্বর: ${jid.replace('@s.whatsapp.net', '')}`);
          }

          if (replyText.includes('[ORDER_COMPLETED]')) {
            replyText = replyText.replace('[ORDER_COMPLETED]', '').trim();
            await safeSendMessage(ACTIVE_BOSS_JID, `📦 *নতুন অর্ডার!*\nতথ্য: ${fullMessage}`);
          }

          await safeSendMessage(jid, replyText);
        } catch (err) {
          console.error('Processing error:', err.message);
        }
      }, 700));
    }
  });
}

app.get('/', (req, res) => {
  if (currentPairingCode) {
    res.send(`<div style="text-align:center;margin-top:60px;"><h2>Pairing Code:</h2><h1>${currentPairingCode}</h1></div>`);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:60px;">বট সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
