// ============================================
// Tv Fizika — Telegram orqali ro'yxatdan o'tish boti
// (MongoDB + CORS + rate-limit bilan)
// ============================================

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');

// ---------- SOZLAMALAR ----------
const BOT_TOKEN = process.env.BOT_TOKEN;   // Render'da Environment Variable sifatida qo'shiladi
const APP_URL = process.env.APP_URL;       // masalan: https://tvfizika-bot.onrender.com
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI; // MongoDB Atlas connection string
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // masalan: https://tvfizika.uz

if (!BOT_TOKEN) {
  console.error('XATOLIK: BOT_TOKEN environment variable topilmadi!');
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error('XATOLIK: MONGODB_URI environment variable topilmadi!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// CORS — faqat kerakli domenga ruxsat berish tavsiya etiladi
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ---------- MONGODB ULANISH ----------
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB ga muvaffaqiyatli ulandi'))
  .catch((e) => {
    console.error('MongoDB ga ulanishda xatolik:', e.message);
    process.exit(1);
  });

const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  chatId: { type: Number, required: true, index: true },
  ism: { type: String, required: true },
  telefon: { type: String, required: true },
  telegramUsername: { type: String, default: null },
  loginCode: { type: String, default: null, index: true },
  codeCreatedAt: { type: Number, default: null },
  createdAt: { type: Number, default: () => Date.now() },
});

const User = mongoose.model('User', userSchema);

// 6 xonali tasodifiy login kod generatsiya qilish
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Bazada bo'sh (band qilinmagan) login kod generatsiya qiladi — to'qnashuvning oldini oladi
async function generateUniqueCode() {
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    const clash = await User.findOne({ loginCode: code });
    if (!clash) return code;
  }
  return generateCode();
}

// ---------- FOYDALANUVCHI HOLATLARI (register jarayoni) ----------
// step: 'ism' -> 'telefon' -> tugadi
// Eslatma: bu hali ham xotirada saqlanadi (server qayta ishga tushsa yo'qoladi),
// lekin bu faqat ro'yxatdan o'tish jarayonining vaqtinchalik holati, doimiy
// foydalanuvchi ma'lumotlari endi MongoDB'da saqlanadi.
const sessions = {};

// ---------- BOT LOGIKASI ----------

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;

  try {
    const existing = await User.findOne({ chatId });

    if (existing) {
      const code = await generateUniqueCode();
      existing.loginCode = code;
      existing.codeCreatedAt = Date.now();
      await existing.save();

      return ctx.reply(
        `Salom, ${existing.ism}! 👋\n\n` +
        `Saytga kirish uchun quyidagi kodni kiriting:\n\n` +
        `🔑 *${code}*\n\n` +
        `Kod 10 daqiqa amal qiladi.`,
        { parse_mode: 'Markdown' }
      );
    }

    sessions[chatId] = { step: 'ism' };
    return ctx.reply(
      "Assalomu alaykum! 👋\n\n" +
      "*Tv Fizika* saytiga xush kelibsiz.\n" +
      "Ro'yxatdan o'tish uchun to'liq ismingizni kiriting:",
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('start xatoligi:', e.message);
    return ctx.reply("Kechirasiz, texnik xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring.");
  }
});

bot.on('text', (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions[chatId];
  if (!session) {
    return ctx.reply("Boshlash uchun /start buyrug'ini yuboring.");
  }

  const text = ctx.message.text.trim();

  if (session.step === 'ism') {
    if (text.length < 3) {
      return ctx.reply("Iltimos to'liq ismingizni kiriting (kamida 3 harf).");
    }
    session.ism = text;
    session.step = 'telefon';
    return ctx.reply(
      "Rahmat! Endi telefon raqamingizni yuboring 📱",
      Markup.keyboard([
        Markup.button.contactRequest("📞 Raqamni yuborish")
      ]).resize().oneTime()
    );
  }

  if (session.step === 'telefon') {
    return ctx.reply("Iltimos pastdagi tugma orqali telefon raqamingizni yuboring.");
  }
});

bot.on('contact', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions[chatId];
  if (!session || session.step !== 'telefon') return;

  if (ctx.message.contact.user_id && ctx.message.contact.user_id !== ctx.from.id) {
    return ctx.reply("Iltimos, faqat o'zingizning telefon raqamingizni yuboring.");
  }

  const phone = ctx.message.contact.phone_number;

  try {
    const userId = 'u_' + Date.now();
    const code = await generateUniqueCode();

    const newUser = new User({
      id: userId,
      chatId,
      ism: session.ism,
      telefon: phone,
      telegramUsername: ctx.from.username || null,
      loginCode: code,
      codeCreatedAt: Date.now(),
      createdAt: Date.now(),
    });

    await newUser.save();
    delete sessions[chatId];

    return ctx.reply(
      `Ro'yxatdan muvaffaqiyatli o'tdingiz, ${session.ism}! ✅\n\n` +
      `Saytga kirish uchun quyidagi kodni kiriting:\n\n` +
      `🔑 *${code}*\n\n` +
      `Kod 10 daqiqa amal qiladi. Yangi kod olish uchun istalgan vaqt /start yuboring.`,
      { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
    );
  } catch (e) {
    console.error('contact xatoligi:', e.message);
    return ctx.reply("Kechirasiz, ro'yxatdan o'tishda xatolik yuz berdi. Qaytadan /start bosing.");
  }
});

// ---------- WEBHOOK O'RNATISH (Render uchun) ----------
const webhookPath = `/webhook/${BOT_TOKEN}`;
app.use(bot.webhookCallback(webhookPath));

// ---------- SAYT UCHUN API ----------

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 daqiqa
  max: 20,                  // har bir IP uchun 15 daqiqada maksimum 20 urinish
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring." },
});

app.post('/api/verify', verifyLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: "Kod kiritilmagan" });

  try {
    const user = await User.findOne({ loginCode: code });

    if (!user) {
      return res.status(404).json({ ok: false, error: "Kod noto'g'ri" });
    }

    const TEN_MIN = 10 * 60 * 1000;
    if (Date.now() - user.codeCreatedAt > TEN_MIN) {
      return res.status(410).json({ ok: false, error: "Kodning muddati tugagan" });
    }

    user.loginCode = null;
    await user.save();

    return res.json({
      ok: true,
      user: {
        id: user.id,
        ism: user.ism,
        telefon: user.telefon,
        telegramUsername: user.telegramUsername,
      },
    });
  } catch (e) {
    console.error('verify xatoligi:', e.message);
    return res.status(500).json({ ok: false, error: "Server xatoligi" });
  }
});

app.get('/', (req, res) => {
  res.send('Tv Fizika Telegram bot ishlayapti ✅');
});

// ---------- SERVERNI ISHGA TUSHIRISH ----------
app.listen(PORT, async () => {
  console.log(`Server ${PORT}-portda ishga tushdi`);

  if (APP_URL) {
    const fullWebhookUrl = `${APP_URL}${webhookPath}`;
    try {
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log('Webhook o\'rnatildi:', fullWebhookUrl);
    } catch (e) {
      console.error('Webhook o\'rnatishda xatolik:', e.message);
    }
  } else {
    console.warn('APP_URL berilmagan — webhook o\'rnatilmadi.');
  }
});
