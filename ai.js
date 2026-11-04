const fs = require('fs');
const path = require('path');

function getStoreContext() {
  try {
    const p = path.join(__dirname, 'knowledge.json');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (e) {}
  return '';
}

async function queryGemini(history, systemPrompt, apiKey) {
  // অগ্রাধিকার অনুযায়ী মডেলের লিস্ট
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: history,
          generationConfig: { temperature: 0.3 }
        })
      });

      const data = await res.json();
      if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text.trim();
      }
    } catch (err) {}
  }
  return null;
}

async function getBotReply(chatHistory, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  const storeData = getStoreContext();

  const systemPrompt = `
তুমি RS SHOP 360 অনলাইন শপের একজন অত্যন্ত বুদ্ধিমান, বিনয়ী ও রক্ত-মাংসের বাস্তব সেলসম্যান।
কাস্টমার যেভাবে লিখবে (বাংলা বা বাংলিশ), তুমি ঠিক সেভাবে অত্যন্ত আন্তরিক ও স্বাভাবিক মিষ্টি বাংলায় ১-২ লাইনে উত্তর দেবে।

শপের আসল ডেটাবেজ:
${storeData}

কঠোর নিয়ম:
১. কাস্টমার হাই/সালাম দিলে সুন্দর করে কুশল বিনিময় করে জানতে চাইবে কী লাগবে।
২. পণ্যের গুণাগুণ বা কাজ জানতে চাইলে বাস্তবসম্মতভাবে সহজে বুঝিয়ে বলবে।
৩. ডেটাবেজে নেই এমন কোনো প্রোডাক্ট কাস্টমার চাইলে কখনোই "স্টকে নেই" বলবে না। স্বাভাবিকভাবে বলবে:
"এই প্রোডাক্টটি বর্তমানে আমাদের লিস্টে নেই, তবে আমি আমাদের ওনারকে জানিয়ে রাখছি।" এবং মেসেজের শেষে [ASK_BOSS] লিখবে।
৪. কাস্টমার কিনতে চাইলে অর্ডার ফর্ম পূরণ করতে বলবে।
৫. অর্ডার ফরমের তথ্য দিলে বলবে: "ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে✅ ২-৩ দিনের মধ্যে প্রোডাক্ট পেয়ে যাবেন।" এবং মেসেজের শেষে [ORDER_DONE] লিখবে।
`;

  if (apiKey) {
    const formattedHistory = [...chatHistory, { role: 'user', parts: [{ text: userMessage }] }];
    const aiText = await queryGemini(formattedHistory, systemPrompt, apiKey);
    if (aiText) return aiText;
  }

  // অফলাইন ব্যাকআপ (যদি কোনো কারণে এআই এপিআই ডাউনও থাকে)
  const lower = userMessage.toLowerCase();
  if (lower.includes('কাজ') || lower.includes('kaj')) {
    return 'সাকুরা মাড মাস্ক ত্বক গভীরভাবে পরিষ্কার করে, বাড়তি তেল দূর করে ও ত্বক সফট রাখে।';
  }
  if (lower.includes('sakura') || lower.includes('সাকুরা')) {
    return 'সাকুরা মাড মাস্ক ১ প্যাকেট ২৪০ টাকা (১২ পিস থাকে)। ব্রাহ্মণবাড়িয়ার ভেতর ডেলিভারি ৭০ টাকা, বাইরে ১২০ টাকা।';
  }
  if (lower.includes('sheet') || lower.includes('শিট')) {
    return 'শিট মাস্ক প্রতি পিস ৬০ টাকা।';
  }
  if (lower.includes('rice') || lower.includes('রাইস')) {
    return 'রাইস ফেস ওয়াশ এর দাম ৮৫০ টাকা।';
  }
  if (lower.includes('order') || lower.includes('অর্ডার')) {
    return "অর্ডার কনফার্ম করতে নিচের তথ্যগুলো লিখে পাঠান:\n\nনাম :\nজেলা :\nথানা :\nগ্রাম বা রোড নং :\nমোবাইল নাম্বার :\nকি প্রডাক্ট নিতে চাচ্ছেন :";
  }

  return 'আসসালামু আলাইকুম! RS SHOP BD-তে স্বাগতম। আপনি কোন প্রোডাক্টটি সম্পর্কে জানতে চাচ্ছেন?';
}

module.exports = { getBotReply };
