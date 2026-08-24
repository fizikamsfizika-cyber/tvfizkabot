// ============================================
// Tv Fizika — Telegram orqali ro'yxatdan o'tish boti
// (MongoDB + CORS + rate-limit bilan)
// ============================================

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { Telegraf, Markup } = require('telegraf');
const https = require('https');
const http = require('http');

// ---------- SOZLAMALAR ----------
const BOT_TOKEN = process.env.BOT_TOKEN;   // Render'da Environment Variable sifatida qo'shiladi
const APP_URL = process.env.APP_URL;       // masalan: https://tvfizika-bot.onrender.com
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI; // MongoDB Atlas connection string
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // masalan: https://tvfizika.uz
const APP_SITE_URL = process.env.APP_SITE_URL || null; // masalan: https://tvfizika.uz (foydalanuvchiga xabar ichida ko'rsatiladigan link)
const BOT_USERNAME = process.env.BOT_USERNAME || null; // masalan: TvFizikaBot (@ belgisiz, saytdagi tugma/QR uchun kerak)
const JWT_SECRET = process.env.JWT_SECRET || 'tvfizika_dev_secret_almashtiring'; // Render'da albatta o'zingizniki bilan almashtiring!

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

// Yengil health-check endpoint — tashqi "uptime monitor" xizmatlari (masalan UptimeRobot)
// shu manzilga muntazam so'rov yuborib, Render'ning bepul tarifida server "uxlab qolishining"
// oldini oladi. Bazaga murojaat qilmaydi, shuning uchun tez javob qaytaradi.
app.get('/', (req, res) => {
  res.status(200).send('OK — Tv Fizika bot ishlamoqda');
});

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
  viloyat: { type: String, default: null },
  tuman: { type: String, default: null },
  telegramUsername: { type: String, default: null },
  loginCode: { type: String, default: null, index: true },
  codeCreatedAt: { type: Number, default: null },
  createdAt: { type: Number, default: () => Date.now() },
  lastLoginAt: { type: Number, default: null },
  isLoggedIn: { type: Boolean, default: false },
});

const User = mongoose.model('User', userSchema);

// ---------- AVTOMATIK LOGIN TOKENLARI (sayt <-> bot) ----------
// Foydalanuvchi saytdagi "Telegram bot orqali kirish" tugmasini bosganda
// noyob token generatsiya qilinadi. Bot orqali /start?token bosilganda
// shu token foydalanuvchi bilan bog'lanadi va sayt buni kutib (polling) turadi.
const loginTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['pending', 'confirmed', 'expired'], default: 'pending' },
  chatId: { type: Number, default: null },
  userId: { type: String, default: null },
  createdAt: { type: Number, default: () => Date.now() },
});
const LoginToken = mongoose.model('LoginToken', loginTokenSchema);

function generateLoginToken() {
  return 'lt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// ---------- DARSLAR (Lessons) ----------
const lessonSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, default: '' },
  youtubeId: { type: String, default: null }, // faqat YouTube video ID (masalan: dQw4w9WgXcQ)
  order: { type: Number, required: true, index: true },
  createdAt: { type: Number, default: () => Date.now() },
});
const Lesson = mongoose.model('Lesson', lessonSchema);

// Har xil ko'rinishdagi YouTube linklardan (youtu.be, watch?v=, shorts, embed) video ID'ni ajratib oladi.
// Agar link noto'g'ri bo'lsa yoki umuman link bo'lmasa (masalan "-" yozilsa) — null qaytaradi.
function extractYoutubeId(input) {
  if (!input) return null;
  const text = input.trim();
  if (text === '-' || text.toLowerCase() === 'yoq' || text.toLowerCase() === "yo'q") return null;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/, // to'g'ridan-to'g'ri video ID kiritilgan bo'lsa
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Admin chatId'lari — vergul bilan ajratilgan holda .env ga qo'shiladi: ADMIN_IDS=123456,789012
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

function isAdmin(chatId) {
  return ADMIN_IDS.includes(chatId);
}

// Bot API 9.4: tugmalarga rang berish uchun yordamchi funksiya
// style: "primary" (ko'k), "success" (yashil), "danger" (qizil)
function styledCallback(text, callback_data, style) {
  return { text, callback_data, style };
}
function styledUrl(text, url, style) {
  return { text, url, style };
}

// Foydalanuvchi uchun saytga avtomatik kirish tokeni (JWT) yaratadi.
// Token 1 soat amal qiladi va faqat userId'ni o'zida saqlaydi (parol/kod emas).
function generateSiteToken(user) {
  return jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
}

// "Tv Fizika'ga kirish" tugmasi uchun to'liq havola: sayt manziliga ?token=... qo'shib beradi.
// Sayt (index.html) shu tokenni o'qib, /api/verify-token orqali tekshiradi va avtomatik login qiladi.
function buildSiteLoginUrl(user) {
  const base = APP_SITE_URL || 'https://tvfizika.uz';
  const token = generateSiteToken(user);
  return `${base}/?token=${token}`;
}


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
  const payload = (ctx.startPayload || '').trim(); // masalan: lt_xxxxx (sayt orqali kelgan login token)
  const loginToken = payload.startsWith('lt_') ? payload : null;

  try {
    const existing = await User.findOne({ chatId });

    if (existing) {
      // Agar foydalanuvchi saytdagi tugma orqali (token bilan) kelgan bo'lsa —
      // avtomatik login qilamiz, hech qanday kod so'ralmaydi.
      if (loginToken) {
        const tokenDoc = await LoginToken.findOne({ token: loginToken, status: 'pending' });
        if (tokenDoc) {
          tokenDoc.status = 'confirmed';
          tokenDoc.chatId = chatId;
          tokenDoc.userId = existing.id;
          await tokenDoc.save();

          existing.isLoggedIn = true;
          existing.lastLoginAt = Date.now();
          await existing.save();

          return ctx.reply(
            `✅ Tabriklaymiz, ${existing.ism}!\n\n` +
            `Siz *Tv Fizika* saytiga muvaffaqiyatli kirdingiz.\n` +
            `Endi saytga qaytishingiz mumkin — u avtomatik yangilanadi.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [styledUrl('🎓 Tv Fizika\'ga kirish', buildSiteLoginUrl(existing), 'primary')],
                  [styledCallback('📚 Darslar', 'OPEN_LESSONS', 'primary')],
                ],
              },
            }
          );
        }
      }

      if (existing.isLoggedIn) {
        return ctx.reply(
          `Xush kelibsiz qaytganingizdan xursandmiz, ${existing.ism}! 👋\n\n` +
          `Siz allaqachon ro'yxatdan o'tgansiz va saytga kirgansiz.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [styledUrl('🎓 Tv Fizika\'ga kirish', buildSiteLoginUrl(existing), 'primary')],
                [styledCallback('📚 Darslar', 'OPEN_LESSONS', 'primary')],
                [styledCallback('👤 Profilim', 'PROFILE', 'success'), styledCallback('ℹ️ Yordam', 'HELP', 'danger')],
              ],
            },
          }
        );
      }

      return ctx.reply(
        `Xush kelibsiz qaytganingizdan xursandmiz, ${existing.ism}! 👋\n\n` +
        `Siz allaqachon ro'yxatdan o'tgansiz. Saytga kirish uchun quyidagi tugmani bosing:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [styledUrl('🎓 Tv Fizika\'ga kirish', buildSiteLoginUrl(existing), 'primary')],
              [styledCallback('🔑 6 xonali kodni olish', 'NEW_CODE', 'primary')],
              [styledCallback('👤 Profilim', 'PROFILE', 'success'), styledCallback('ℹ️ Yordam', 'HELP', 'danger')],
            ],
          },
        }
      );
    }

    sessions[chatId] = { step: 'ism', loginToken };
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

bot.on('text', async (ctx, next) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  // Agar xabar biror buyruq bo'lsa (masalan /dars_qoshish, /darslar, /start)
  // va hozircha faol admin yoki register sessiyasi bo'lmasa — uni shu yerda
  // "ushlab qolmasdan", tegishli bot.command() handleriga o'tkazib yuboramiz.
  const isCommand = text.startsWith('/');
  if (isCommand && !adminSessions[chatId] && !sessions[chatId]) {
    return next();
  }

  // Admin: dars qo'shish jarayoni
  const adminSession = adminSessions[chatId];
  if (adminSession) {
    if (adminSession.step === 'title') {
      adminSession.title = text;
      adminSession.step = 'content';
      return ctx.reply("Endi dars matnini (tavsifini) kiriting:");
    }
    if (adminSession.step === 'content') {
      adminSession.content = text;
      adminSession.step = 'video';
      return ctx.reply(
        "Endi darsning YouTube havolasini yuboring.\n\n" +
        "Masalan: https://youtu.be/dQw4w9WgXcQ\n" +
        "yoki: https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n" +
        "Agar bu darsda video bo'lmasa — \"-\" belgisini yuboring."
      );
    }
    if (adminSession.step === 'video') {
      try {
        const youtubeId = extractYoutubeId(text);
        if (text.trim() !== '-' && !youtubeId) {
          return ctx.reply(
            "❌ Bu YouTube havolasi tanilmadi. Iltimos, to'g'ri linkni yuboring yoki video yo'q bo'lsa \"-\" yozing."
          );
        }

        const count = await Lesson.countDocuments();
        const newLesson = await Lesson.create({
          title: adminSession.title,
          content: adminSession.content,
          youtubeId,
          order: count,
        });
        delete adminSessions[chatId];
        return ctx.reply(
          "✅ Dars muvaffaqiyatli qo'shildi!" +
          (youtubeId ? " 🎬 Video ham biriktirildi." : "") +
          "\n\n/darslar orqali ko'rishingiz mumkin.",
          {
            reply_markup: {
              inline_keyboard: [
                [styledCallback('❌ Shu darsni o\'chirish', `DEL_LESSON_${newLesson._id}`, 'danger')],
              ],
            },
          }
        );
      } catch (e) {
        console.error('dars_qoshish xatoligi:', e.message);
        delete adminSessions[chatId];
        return ctx.reply("Xatolik yuz berdi, dars saqlanmadi.");
      }
    }
    return;
  }

  const session = sessions[chatId];
  if (!session) {
    return ctx.reply("Boshlash uchun /start buyrug'ini yuboring.");
  }

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

  if (session.step === 'viloyat') {
    if (text.length < 2) {
      return ctx.reply("Iltimos, viloyat nomini kiriting.");
    }
    session.viloyat = text;
    session.step = 'tuman';
    return ctx.reply("Qaysi tumandasiz?");
  }

  if (session.step === 'tuman') {
    if (text.length < 2) {
      return ctx.reply("Iltimos, tuman nomini kiriting.");
    }
    session.tuman = text;
    return finishRegistration(ctx, session);
  }
});

bot.on('contact', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions[chatId];
  if (!session || session.step !== 'telefon') return;

  if (ctx.message.contact.user_id && ctx.message.contact.user_id !== ctx.from.id) {
    return ctx.reply("Iltimos, faqat o'zingizning telefon raqamingizni yuboring.");
  }

  session.telefon = ctx.message.contact.phone_number;
  session.step = 'viloyat';

  await ctx.reply("Rahmat! ✅", { ...Markup.removeKeyboard() });
  return ctx.reply("Qaysi viloyatdasiz?");
});

// Ro'yxatdan o'tishni yakunlash: foydalanuvchini bazaga yozish, token bo'lsa avtomatik login,
// bo'lmasa 6 xonali kod berish.
async function finishRegistration(ctx, session) {
  const chatId = ctx.chat.id;

  try {
    const userId = 'u_' + Date.now();
    const code = await generateUniqueCode();

    const newUser = new User({
      id: userId,
      chatId,
      ism: session.ism,
      telefon: session.telefon,
      viloyat: session.viloyat || null,
      tuman: session.tuman || null,
      telegramUsername: ctx.from.username || null,
      loginCode: code,
      codeCreatedAt: Date.now(),
      createdAt: Date.now(),
    });

    // Agar ro'yxatdan o'tish sayt orqali (token bilan) boshlangan bo'lsa —
    // ro'yxatdan o'tish tugashi bilanoq avtomatik login qilamiz, kod kerak emas.
    if (session.loginToken) {
      const tokenDoc = await LoginToken.findOne({ token: session.loginToken, status: 'pending' });
      if (tokenDoc) {
        tokenDoc.status = 'confirmed';
        tokenDoc.chatId = chatId;
        tokenDoc.userId = userId;
        await tokenDoc.save();

        newUser.isLoggedIn = true;
        newUser.lastLoginAt = Date.now();
        newUser.loginCode = null;
        await newUser.save();
        delete sessions[chatId];

        return ctx.reply(
          `✅ Ro'yxatdan o'tish yakunlandi!`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [styledUrl('🎓 Tv Fizika\'ga kirish', buildSiteLoginUrl(newUser), 'primary')],
                [styledCallback('📚 Darslar', 'OPEN_LESSONS', 'primary')],
              ],
            },
          }
        );
      }
    }

    await newUser.save();
    delete sessions[chatId];

    await ctx.reply(`✅ Ro'yxatdan o'tish yakunlandi!`, { parse_mode: 'Markdown' });

    return ctx.reply(
      `Saytga kirish uchun quyidagi kodni kiriting:\n\n` +
      `🔑 *${code}*\n\n` +
      `Kod 10 daqiqa amal qiladi. Yangi kod olish uchun istalgan vaqt /start yuboring.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [styledCallback('🔄 Yangi kod olish', 'NEW_CODE', 'primary')],
            [styledCallback('📚 Darslar', 'OPEN_LESSONS', 'primary')],
            [styledCallback('👤 Profilim', 'PROFILE', 'success'), styledCallback('ℹ️ Yordam', 'HELP', 'danger')],
          ],
        },
      }
    );
  } catch (e) {
    console.error('finishRegistration xatoligi:', e.message);
    delete sessions[chatId];
    return ctx.reply("Kechirasiz, ro'yxatdan o'tishda xatolik yuz berdi. Qaytadan /start bosing.");
  }
}

// ---------- INLINE TUGMALAR (callback query'lar) ----------

bot.action('NEW_CODE', async (ctx) => {
  await ctx.answerCbQuery('Yangi kod yaratilmoqda...');
  const chatId = ctx.chat.id;
  try {
    const user = await User.findOne({ chatId });
    if (!user) return ctx.reply("Siz hali ro'yxatdan o'tmagansiz. /start ni bosing.");

    const code = await generateUniqueCode();
    user.loginCode = code;
    user.codeCreatedAt = Date.now();
    await user.save();

    return ctx.reply(
      `🔑 Yangi kodingiz: *${code}*\n\nKod 10 daqiqa amal qiladi.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('NEW_CODE xatoligi:', e.message);
    return ctx.reply('Xatolik yuz berdi, birozdan so\'ng qayta urinib ko\'ring.');
  }
});

bot.action('PROFILE', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  try {
    const user = await User.findOne({ chatId });
    if (!user) return ctx.reply("Siz hali ro'yxatdan o'tmagansiz. /start ni bosing.");

    return ctx.reply(
      `👤 *Profil ma'lumotlari*\n\n` +
      `Ism: ${user.ism}\n` +
      `Telefon: ${user.telefon}\n` +
      (user.viloyat ? `Viloyat: ${user.viloyat}\n` : '') +
      (user.tuman ? `Tuman: ${user.tuman}\n` : '') +
      `Holat: ${user.isLoggedIn ? '✅ Tizimga kirgan' : '🚪 Tizimga kirmagan'}\n` +
      `Ro'yxatdan o'tgan sana: ${new Date(user.createdAt).toLocaleDateString('uz-UZ')}\n` +
      (user.lastLoginAt ? `Oxirgi kirish: ${new Date(user.lastLoginAt).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}\n` : ''),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('PROFILE xatoligi:', e.message);
    return ctx.reply('Xatolik yuz berdi.');
  }
});

bot.action('OPEN_LESSONS', async (ctx) => {
  await ctx.answerCbQuery();
  const { total, index, lesson } = await getLessonByIndex(0);
  if (!lesson) return ctx.reply("Hozircha darslar qo'shilmagan.");
  return ctx.reply(formatLessonText(lesson, index, total), {
    parse_mode: 'Markdown',
    reply_markup: lessonsKeyboard(index, total, lesson),
  });
});

bot.action('HELP', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    'ℹ️ *Yordam*\n\n' +
    '/start — ro\'yxatdan o\'tish yoki yangi kirish kodi olish\n' +
    '/darslar — darslar ro\'yxatini ko\'rish\n\n' +
    'Kodni saytdagi kirish oynasiga kiriting. Kod 10 daqiqa amal qiladi.\n' +
    'Savollar bo\'lsa: @tvfizika_support',
    { parse_mode: 'Markdown' }
  );
});

// ---------- KO'P SAHIFALI NAVIGATSIYA (rangli Oldingisi/Keyingisi, MongoDB'dan) ----------

async function getLessonByIndex(index) {
  const total = await Lesson.countDocuments();
  if (total === 0) return { total: 0, index: 0, lesson: null };
  const safeIndex = Math.max(0, Math.min(index, total - 1));
  const lesson = await Lesson.findOne().sort({ order: 1 }).skip(safeIndex);
  return { total, index: safeIndex, lesson };
}

function lessonsKeyboard(index, total, lesson) {
  const rows = [];

  if (lesson && lesson.youtubeId) {
    rows.push([styledUrl('▶️ Videoni ko\'rish', `https://youtu.be/${lesson.youtubeId}`, 'danger')]);
  }

  const navRow = [];
  if (index > 0) {
    navRow.push(styledCallback('⬅️ Oldingisi', `LESSON_${index - 1}`, 'primary'));
  }
  if (index < total - 1) {
    navRow.push(styledCallback('Keyingisi ➡️', `LESSON_${index + 1}`, 'primary'));
  }
  if (navRow.length) rows.push(navRow);

  return { inline_keyboard: rows };
}

function formatLessonText(lesson, index, total) {
  return (
    `📘 *${lesson.title}*\n` +
    `_(${index + 1}/${total})_${lesson.youtubeId ? ' 🎬' : ''}\n\n` +
    (lesson.content ? lesson.content : '_Matn hali qo\'shilmagan._')
  );
}

bot.action(/^LESSON_(\d+)$/, async (ctx) => {
  const requestedIndex = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  const { total, index, lesson } = await getLessonByIndex(requestedIndex);
  if (!lesson) return ctx.reply('Hozircha darslar mavjud emas.');
  return ctx.editMessageText(formatLessonText(lesson, index, total), {
    parse_mode: 'Markdown',
    reply_markup: lessonsKeyboard(index, total, lesson),
  });
});

bot.command('darslar', async (ctx) => {
  const { total, index, lesson } = await getLessonByIndex(0);
  if (!lesson) {
    return ctx.reply(
      "Hozircha darslar qo'shilmagan." +
      (isAdmin(ctx.chat.id) ? "\n\n/dars_qoshish buyrug'i orqali dars qo'shishingiz mumkin." : '')
    );
  }
  return ctx.reply(formatLessonText(lesson, index, total), {
    parse_mode: 'Markdown',
    reply_markup: lessonsKeyboard(index, total, lesson),
  });
});

// ---------- ADMIN: DARS QO'SHISH ----------
// step: 'title' -> 'content' -> saqlash
const adminSessions = {};

bot.command('dars_qoshish', (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return ctx.reply("Bu buyruq faqat adminlar uchun.");
  adminSessions[chatId] = { step: 'title' };
  return ctx.reply("Yangi dars sarlavhasini kiriting (masalan: '4-dars: Termodinamika'):");
});

bot.command('darslar_royxati', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return ctx.reply("Bu buyruq faqat adminlar uchun.");
  const all = await Lesson.find().sort({ order: 1 });
  if (!all.length) return ctx.reply("Darslar ro'yxati bo'sh.");

  return ctx.reply(
    "📚 Darslar ro'yxati (o'chirish uchun tugmani bosing):",
    {
      reply_markup: {
        inline_keyboard: all.map((l, i) => [
          styledCallback(
            `${i + 1}. ${l.title}${l.youtubeId ? ' 🎬' : ''} ❌`,
            `DEL_LESSON_${l._id}`,
            'danger'
          ),
        ]),
      },
    }
  );
});

// Darsni o'chirish tugmasi bosilganda — avval tasdiqlash so'raladi
bot.action(/^DEL_LESSON_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return ctx.answerCbQuery("Bu amal faqat adminlar uchun.");
  const lessonId = ctx.match[1];

  try {
    const lesson = await Lesson.findById(lessonId);
    if (!lesson) {
      await ctx.answerCbQuery("Dars topilmadi (allaqachon o'chirilgan bo'lishi mumkin).");
      return ctx.deleteMessage().catch(() => {});
    }

    await ctx.answerCbQuery();
    return ctx.editMessageText(
      `❗ "${lesson.title}" darsini rostdan ham o'chirmoqchimisiz?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              styledCallback('✅ Ha, o\'chirish', `CONFIRM_DEL_${lesson._id}`, 'danger'),
              styledCallback('↩️ Bekor qilish', 'CANCEL_DEL', 'primary'),
            ],
          ],
        },
      }
    );
  } catch (e) {
    console.error('dars o\'chirish (so\'rov) xatoligi:', e.message);
    return ctx.answerCbQuery("Xatolik yuz berdi.");
  }
});

// Tasdiqlangandan keyin darsni bazadan butunlay o'chiradi
bot.action(/^CONFIRM_DEL_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return ctx.answerCbQuery("Bu amal faqat adminlar uchun.");
  const lessonId = ctx.match[1];

  try {
    const lesson = await Lesson.findByIdAndDelete(lessonId);
    await ctx.answerCbQuery("Dars o'chirildi.");
    return ctx.editMessageText(
      lesson
        ? `🗑 "${lesson.title}" darsi o'chirildi.\n\n/darslar_royxati orqali qolgan darslarni ko'rishingiz mumkin.`
        : "Dars allaqachon o'chirilgan edi."
    );
  } catch (e) {
    console.error('dars o\'chirish xatoligi:', e.message);
    return ctx.answerCbQuery("Xatolik yuz berdi, dars o'chirilmadi.");
  }
});

bot.action('CANCEL_DEL', async (ctx) => {
  await ctx.answerCbQuery("Bekor qilindi.");
  return ctx.editMessageText("Amal bekor qilindi. /darslar_royxati orqali qayta ko'rishingiz mumkin.");
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

// ---------- AVTOMATIK LOGIN (token orqali, "Telegram bot orqali kirish" tugmasi uchun) ----------

// 1) Sayt bu endpointni chaqirib token oladi, so'ng foydalanuvchini
//    https://t.me/BOT_USERNAME?start=TOKEN manziliga yo'naltiradi (yoki QR sifatida ko'rsatadi).
app.post('/api/login-token', async (req, res) => {
  if (!BOT_USERNAME) {
    return res.status(500).json({ ok: false, error: "BOT_USERNAME sozlanmagan" });
  }
  try {
    const token = generateLoginToken();
    await LoginToken.create({ token });
    return res.json({
      ok: true,
      token,
      deepLink: `https://t.me/${BOT_USERNAME}?start=${token}`,
    });
  } catch (e) {
    console.error('login-token xatoligi:', e.message);
    return res.status(500).json({ ok: false, error: "Server xatoligi" });
  }
});

// 2) Sayt shu endpointni har 2 soniyada so'raydi (polling) — foydalanuvchi
//    botda ro'yxatdan o'tishi/tasdiqlashi bilanoq "confirmed" qaytadi.
app.get('/api/login-status/:token', async (req, res) => {
  try {
    const tokenDoc = await LoginToken.findOne({ token: req.params.token });
    if (!tokenDoc) return res.status(404).json({ ok: false, error: "Token topilmadi" });

    const FIFTEEN_MIN = 15 * 60 * 1000;
    if (tokenDoc.status === 'pending' && Date.now() - tokenDoc.createdAt > FIFTEEN_MIN) {
      tokenDoc.status = 'expired';
      await tokenDoc.save();
    }

    if (tokenDoc.status !== 'confirmed') {
      return res.json({ ok: true, status: tokenDoc.status });
    }

    const user = await User.findOne({ id: tokenDoc.userId });
    if (!user) return res.json({ ok: true, status: 'pending' });

    return res.json({
      ok: true,
      status: 'confirmed',
      user: {
        id: user.id,
        ism: user.ism,
        telefon: user.telefon,
        viloyat: user.viloyat,
        tuman: user.tuman,
        telegramUsername: user.telegramUsername,
      },
    });
  } catch (e) {
    console.error('login-status xatoligi:', e.message);
    return res.status(500).json({ ok: false, error: "Server xatoligi" });
  }
});

// Telegram xabaridagi "Tv Fizika'ga kirish" tugmasidagi ?token=... ni tekshiradi.
// Bu JWT — 1 soat amal qiladi, faqat userId'ni o'zida saqlaydi.
// Sayt (index.html) sahifa ochilganda shu endpointga so'rov yuborib, avtomatik login qiladi.
app.get('/api/verify-token', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ ok: false, error: "Token yuborilmadi" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ id: decoded.userId });

    if (!user) {
      return res.status(404).json({ ok: false, error: "Foydalanuvchi topilmadi" });
    }

    user.isLoggedIn = true;
    user.lastLoginAt = Date.now();
    await user.save();

    return res.json({
      ok: true,
      user: {
        id: user.id,
        ism: user.ism,
        telefon: user.telefon,
        viloyat: user.viloyat,
        tuman: user.tuman,
        telegramUsername: user.telegramUsername,
      },
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(410).json({ ok: false, error: "Havola muddati tugagan. Botga qaytib, qaytadan urinib ko'ring." });
    }
    return res.status(401).json({ ok: false, error: "Havola noto'g'ri yoki buzilgan" });
  }
});

// ---------- KABINETIM: DARSLAR API (sayt frontend uchun) ----------

// Barcha darslar ro'yxati (kabinet.html'dagi Darslar sahifasi shu ro'yxatni ko'rsatadi)
app.get('/api/lessons', async (req, res) => {
  try {
    const lessons = await Lesson.find().sort({ order: 1 });
    return res.json({
      ok: true,
      lessons: lessons.map((l) => ({
        id: l._id,
        title: l.title,
        order: l.order,
        hasVideo: Boolean(l.youtubeId),
      })),
    });
  } catch (e) {
    console.error('lessons ro\'yxati xatoligi:', e.message);
    return res.status(500).json({ ok: false, error: "Server xatoligi" });
  }
});

// Bitta darsning to'liq ma'lumoti (video ID bilan) — kabinet.html shu orqali YouTube playerni ochadi
app.get('/api/lessons/:id', async (req, res) => {
  try {
    const lesson = await Lesson.findById(req.params.id);
    if (!lesson) return res.status(404).json({ ok: false, error: "Dars topilmadi" });

    return res.json({
      ok: true,
      lesson: {
        id: lesson._id,
        title: lesson.title,
        content: lesson.content,
        youtubeId: lesson.youtubeId,
        order: lesson.order,
      },
    });
  } catch (e) {
    console.error('lesson olish xatoligi:', e.message);
    return res.status(500).json({ ok: false, error: "Server xatoligi yoki noto'g'ri ID" });
  }
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
    user.lastLoginAt = Date.now();
    user.isLoggedIn = true;
    await user.save();

    // Foydalanuvchiga saytga kirgani haqida Telegram orqali xabar yuborish
    try {
      await bot.telegram.sendMessage(
        user.chatId,
        `✅ *Muvaffaqiyatli kirish!*\n\n` +
        `Siz *Tv Fizika* veb-saytiga muvaffaqiyatli kirdingiz.\n` +
        `🕒 Vaqt: ${new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}\n\n` +
        `Agar bu siz bo'lmasangiz, darhol biz bilan bog'laning.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [styledUrl('🌐 Saytga o\'tish', buildSiteLoginUrl(user), 'primary')],
              [styledCallback('👤 Profilim', 'PROFILE', 'success')],
            ],
          },
        }
      );
    } catch (notifyErr) {
      // Xabar yuborilmasa ham login jarayoni davom etadi
      console.error('Login xabarini yuborishda xatolik:', notifyErr.message);
    }

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

// Sayt tomonidan "Chiqish" bosilganda chaqiriladi — { userId: "u_..." } yuboriladi
app.post('/api/logout', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ ok: false, error: "userId kiritilmagan" });

  try {
    const user = await User.findOne({ id: userId });
    if (!user) return res.status(404).json({ ok: false, error: "Foydalanuvchi topilmadi" });

    user.isLoggedIn = false;
    await user.save();

    try {
      await bot.telegram.sendMessage(
        user.chatId,
        `🚪 Siz *Tv Fizika* saytidan tizimdan chiqdingiz.\n\n` +
        `Qayta kirish uchun saytdagi *"Kirish"* tugmasini bosing va maxsus 6 xonali kodni oling.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [styledCallback('🔑 6 xonali kodni olish', 'NEW_CODE', 'primary')],
            ],
          },
        }
      );
    } catch (notifyErr) {
      console.error('Logout xabarini yuborishda xatolik:', notifyErr.message);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('logout xatoligi:', e.message);
    return res.status(500).json({ ok: false, error: "Server xatoligi" });
  }
});

// ---------- RENDER'DA UXLAB QOLMASLIK UCHUN SELF-PING ----------
// Render'ning bepul (Free) tarifida server ~15 daqiqa faolsizlikdan keyin
// "uxlab qoladi". Buning oldini olish uchun server o'zi-o'ziga har 10 daqiqada
// bir marta HTTP so'rov yuboradi ("/" health-check endpointiga).
// Eslatma: bu faqat Render doim ishlab turgan holatda (kamida bitta so'rov kelib
// turganda) foydali; agar server allaqachon butunlay to'xtab qolgan bo'lsa
// (masalan, deploy xatosi tufayli), self-ping uni qayta ishga tushira olmaydi —
// bunday holatda tashqi monitoring xizmati (UptimeRobot va h.k.) ham kerak.
function startSelfPing() {
  if (!APP_URL) {
    console.warn('APP_URL berilmagan — self-ping ishga tushirilmadi.');
    return;
  }

  const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 daqiqa

  setInterval(() => {
    const client = APP_URL.startsWith('https') ? https : http;
    client
      .get(APP_URL, (res) => {
        console.log(`Self-ping: ${res.statusCode} (${new Date().toLocaleTimeString('uz-UZ', { timeZone: 'Asia/Tashkent' })})`);
        res.resume(); // javob tanasini iste'mol qilish (memory leak bo'lmasligi uchun)
      })
      .on('error', (e) => {
        console.error('Self-ping xatoligi:', e.message);
      });
  }, PING_INTERVAL_MS);

  console.log(`Self-ping yoqildi — har ${PING_INTERVAL_MS / 60000} daqiqada ${APP_URL} ga so'rov yuboriladi.`);
}

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

  startSelfPing();
});
