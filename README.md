# Tv Fizika — Telegram Login Bot

## Qanday ishlaydi
1. Foydalanuvchi botga `/start` yuboradi
2. Ism va telefon raqamini kiritadi (kontakt tugmasi orqali)
3. Bot 6 xonali **login kod** yuboradi
4. Sayt shu kodni `/api/verify` ga POST qilib, foydalanuvchi ma'lumotini oladi

Ma'lumotlar endi **MongoDB**da saqlanadi (avvalgi `users.json` fayl o'rniga) — bu server qayta ishga tushganda ma'lumotlar yo'qolmasligini ta'minlaydi.

## Yangi qo'shilganlar
- ✅ **MongoDB** — foydalanuvchilar doimiy bazada saqlanadi
- ✅ **CORS** — faqat ruxsat berilgan domendan so'rovlarga ochiq
- ✅ **Rate-limit** — `/api/verify` endpointi brute-force hujumlardan himoyalangan (15 daqiqada IP boshiga 20 urinish)
- ✅ **Kontakt tekshiruvi** — foydalanuvchi faqat o'zining telefon raqamini yuborishi mumkin

## 1-qadam: MongoDB Atlas sozlash (bepul)

1. [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas) da bepul akkaunt oching
2. **Build a Database → M0 Free** klasterini yarating
3. **Database Access** bo'limida foydalanuvchi (login/parol) yarating
4. **Network Access** bo'limida `0.0.0.0/0` qo'shing (barcha IP'lardan ulanishga ruxsat — Render dinamik IP ishlatgani uchun)
5. **Connect → Drivers** dan connection string (URI) ni nusxalang, masalan:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/tvfizika?retryWrites=true&w=majority
   ```
   `<username>` va `<password>` ni o'zingiznikiga almashtiring.

## 2-qadam: Render'ga yuklash qadamlari

1. **BotFather**dan token oling: @BotFather → `/newbot`
2. Bu papkani (index.js, package.json) GitHub repo'ga yuklang
3. [render.com](https://render.com) da **New → Web Service** tanlang, repo'ni ulang
4. Sozlamalar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. **Environment Variables** qo'shing:
   - `BOT_TOKEN` — BotFather bergan token
   - `APP_URL` — Render sizga beradigan URL (masalan `https://tvfizika-bot.onrender.com`), deploy qilingandan keyin qo'shib qayta deploy qiling
   - `MONGODB_URI` — 1-qadamda olgan MongoDB connection string
   - `ALLOWED_ORIGIN` — saytingiz manzili (masalan `https://tvfizika.uz`); ko'rsatilmasa hamma domenlarga ochiq bo'ladi
6. Deploy tugagach botga `/start` yozib sinab ko'ring

## Sayt tomonidan chaqirish (frontend misoli)

```js
async function loginWithCode(code) {
  const res = await fetch('https://tvfizika-bot.onrender.com/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const data = await res.json();
  if (data.ok) {
    // data.user = { id, ism, telefon, telegramUsername }
    // localStorage'ga saqlab, "kirdi" holatiga o'tkazish mumkin
  } else {
    alert(data.error);
  }
}
```

## Eslatma
- Bot bepul Render tarifida "uxlab qolishi" mumkin (15 daqiqa harakatsizlikdan keyin) — birinchi so'rov sekinroq javob beradi.
- MongoDB Atlas'ning bepul M0 tarifi kichik-o'rta loyihalar uchun yetarli (512MB).
