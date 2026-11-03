const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

// বস নম্বর সেট করা হয়েছে (01789631882)
const BOSS_JID = '8801789631882@s.whatsapp.net';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const chatHistories = new Map();
const humanPausedChats = new Map();
let bossCustomRules = ''; // বস চ্যাট থেকে যা যা শেখাবেন তা এখানে জমা থাকবে

const BASE_SYSTEM_INSTRUCTION = `
তুমি একটি অনলাইন শপের অভিজ্ঞ ও বাস্তবমুখী বিক্রেতা।
কঠোর নিয়মাবলী:
১. কাস্টমারকে কখনোই অপ্রয়োজনীয় বড় আনুষ্ঠানিক কথা বলবে না। সবসময় ১-২ লাইনে স্বাভাবিক মানুষের মতো মেসেজ দেবে।
২. কাস্টমার যদি বলে "দিচ্ছি", "দাঁড়ান", বা কোনো সাধারণ কথা বলে, ভুলেও বলবে না "তথ্য পেয়েছি"। শুধু বলবে "ঠিক আছে, লিখে দিন।"
৩. অর্ডার কনফার্মের জন্য কাস্টমারের কাছে ঠিক ৩টি জিনিস চেয়ে নেবে:
   - নাম
   - সম্পূর্ণ ঠিকানা
   - ১১ ডিজিটের মোবাইল নম্বর
৪. এই ৩টি তথ্য একসাথে পেলেই শুধু বলবে: "ধন্যবাদ! আপনার অর্ডারটি গ্রহণ করা হয়েছে। দ্রুত ডেলিভারি টিম যোগাযোগ করবে।" এবং উত্তরের শেষে লিখবে [ORDER_COMPLETED]।
৫. কোনো পণ্যের দাম বা তথ্য তোমার জানা না থাকলে আন্দাজে কিছু বলবে না, বলবে "আমি চেক করে জানাচ্ছি।" এবং উত্তরের শেষে লিখবে [NEED_HELP]।
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
        config: { systemInstruction: fullPrompt, temperature: 0.3 }
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

      // ==========================================
      // বস কন্ট্রোল লজিক (আপনার পার্সোনাল নম্বর 01789631882)
      // ==========================================
      if (jid === BOSS_JID) {
        if (userText.startsWith('!শিখুন') || userText.startsWith('!learn')) {
          const newInstruction = userText.replace(/!শিখুন|!learn/, '').trim();
          bossCustomRules += `\n- ${newInstruction}`;
          await sock.sendMessage(BOSS_JID, { text: `✅ বস, নতুন নিয়ম যোগ করেছি:\n"${newInstruction}"` });
          continue;
        } else if (userText === '!নিয়ম' || userText === '!rules') {
          await sock.sendMessage(BOSS_JID, { text: `📋 বর্তমানে যে নিয়মগুলো মুখস্থ আছে:\n${bossCustomRules || 'এখনো কোনো নিয়ম দেননি।'}` });
          continue;
        }
      }

      // আপনি মেসেজ পাঠালে বট ৫ মিনিট মিউট থাকবে
      if (msg.key.fromMe) {
        humanPausedChats.set(jid, Date.now() + 5 * 60 * 1000);
        continue;
      }

      const pauseUntil = humanPausedChats.get(jid) || 0;
      if (Date.now() < pauseUntil) continue;

      try {
        let replyText = await generateAIReply(jid, userText);
        if (!replyText) continue;

        // কাস্টমার সম্পূর্ণ অর্ডার কনফার্ম করলে বসকে মেসেজ পাঠানো
        if (replyText.includes('[ORDER_COMPLETED]')) {
          replyText = replyText.replace('[ORDER_COMPLETED]', '').trim();
          await sock.sendMessage(BOSS_JID, {
            text: `📦 *নতুন অর্ডার অ্যালার্ট!*\nনম্বর: ${jid.replace('@s.whatsapp.net', '')}\nকাস্টমারের শেষ মেসেজ: ${userText}`
          });
        }

        // এআই পণ্যের উত্তর না জেনে আটকে গেলে বসকে মেসেজ পাঠানো
        if (replyText.includes('[NEED_HELP]')) {
          replyText = replyText.replace('[NEED_HELP]', '').trim();
          await sock.sendMessage(BOSS_JID, {
            text: `⚠️ *সাহায্য প্রয়োজন!*\nকাস্টমার জানতে চেয়েছে: "${userText}"\nনম্বর: ${jid.replace('@s.whatsapp.net', '')}\nআপনি একটু ইনবক্সে দেখুন।`
          });
        }

        await sock.sendMessage(jid, { text: replyText });
      } catch (err) {
        console.error('Error:', err.message);
      }
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
