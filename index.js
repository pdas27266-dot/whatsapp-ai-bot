const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

// বস নম্বর
const BOSS_JID = '8801789631882@s.whatsapp.net';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const chatHistories = new Map();
const humanPausedChats = new Map();
const messageQueues = new Map();
const debounceTimers = new Map();
let bossCustomRules = '';

const BASE_SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন শপের অত্যন্ত বিনয়ী, আন্তরিক ও বুদ্ধিমান বিক্রেতা।
কঠোর নিয়মাবলী:
১. কোনো বড় আনুষ্ঠানিক ডায়লগ দেবে না। সাধারণ মানুষ যেভাবে হোয়াটসঅ্যাপে ১-২ লাইনে চ্যাট করে সেভাবে উত্তর দেবে।
২. কাস্টমার যদি বলে "আচ্ছা", "একটু পর মেসেজ দিচ্ছি" বা "দাঁড়ান", তখন মিষ্টি করে বলবে "আচ্ছা ঠিক আছে, কোনো সমস্যা নেই।"
৩. কাস্টমার অর্ডার কনফার্ম করতে চাইলে শুধু নাম, ঠিকানা ও ১১ ডিজিটের মোবাইল নম্বর চাইবে।
৪. কাস্টমার সব তথ্য দিলে তবেই অর্ডার গ্রহণের নিশ্চয়তা দেবে এবং উত্তরের শেষে লিখবে [ORDER_COMPLETED]।
৫. জানা না থাকলে বানিয়ে বলবে না, বলবে "আমি চেক করে জানাচ্ছি" এবং শেষে লিখবে [NEED_HELP]।
`;

async function generateAIReply(jid, userText) {
  let history = chatHistories.get(jid) || [];
  history.push({ role: 'user', text: userText });
  if (history.length > 8) history = history.slice(-8);
  chatHistories.set(jid, history);

  const fullPrompt = `${BASE_SYSTEM_INSTRUCTION}\nবসের বিশেষ নির্দেশাবলী ও পণ্যের তথ্য:\n${bossCustomRules}`;
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
  return 'একটু অপেক্ষা করুন, নেটওয়ার্ক চেক করে জানাচ্ছি।';
}

let qrCodeData = '';

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrCodeData = await QRCode.toDataURL(qr);
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('WhatsApp সফলভাবে চালু আছে!');
      qrCodeData = '';
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue;

      const userText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!userText) continue;

      // বস কমান্ড হ্যান্ডলিং (কোলন বা স্পেস দুটোই সাপোর্ট করবে)
      const isBoss = jid.includes('01789631882') || jid === BOSS_JID;
      if (isBoss && (userText.startsWith('!শিখুন') || userText.startsWith('!learn'))) {
        const newInstruction = userText.replace(/^(!শিখুন|!learn)\s*[:]?\s*/i, '').trim();
        bossCustomRules += `\n- ${newInstruction}`;
        await sock.sendMessage(jid, { text: `✅ বস, নতুন তথ্য যুক্ত করা হয়েছে:\n"${newInstruction}"` });
        continue;
      }

      if (isBoss && (userText === '!নিয়ম' || userText === '!rules')) {
        await sock.sendMessage(jid, { text: `📋 বর্তমানে সংরক্ষিত নিয়মাবলী:\n${bossCustomRules || 'এখনো কোনো তথ্য যোগ করা হয়নি।'}` });
        continue;
      }

      // ওনার মেসেজ পাঠালে ৫ মিনিট পজ
      if (msg.key.fromMe) {
        humanPausedChats.set(jid, Date.now() + 5 * 60 * 1000);
        continue;
      }

      const pauseUntil = humanPausedChats.get(jid) || 0;
      if (Date.now() < pauseUntil) continue;

      // কাস্টমারের মেসেজ বাফার করা (দ্রুত পর পর মেসেজ দিলে সব একসাথে ধরা)
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
              text: `📦 *নতুন অর্ডার অ্যালার্ট!*\nকাস্টমার নম্বর: ${jid.replace('@s.whatsapp.net', '')}\nঅর্ডার তথ্য: ${fullUserMessage}`
            });
          }

          if (replyText.includes('[NEED_HELP]')) {
            replyText = replyText.replace('[NEED_HELP]', '').trim();
            await sock.sendMessage(BOSS_JID, {
              text: `⚠️ *সাহায্য প্রয়োজন!*\nকাস্টমার জানতে চেয়েছে: "${fullUserMessage}"\nনম্বর: ${jid.replace('@s.whatsapp.net', '')}`
            });
          }

          await sock.sendMessage(jid, { text: replyText });
        } catch (err) {
          console.error('মেসেজ প্রসেসিং এরর:', err.message);
        }
      }, 3000)); // ৩ সেকেন্ড বিরতি দিয়ে একসাথে সব মেসেজের উত্তর পাঠাবে
    }
  });
}

app.get('/', (req, res) => {
  if (qrCodeData) {
    res.send(`<div style="text-align:center;margin-top:50px;"><img src="${qrCodeData}" style="width:300px;"/></div>`);
  } else {
    res.send('<h2 style="text-align:center;color:green;margin-top:50px;">বট সক্রিয় রয়েছে!</h2>');
  }
});

app.listen(port, () => {
  startBot();
});
