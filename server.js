/**
 * ═══════════════════════════════════════════════════════════════
 *  هسه — بوت واتساب
 *  يستقبل رسائل الزبائن ويرد عليهم، ويجمع ليدز المتاجر والمندوبين.
 *
 *  التشغيل:  npm install && npm start
 *  الويبهوك: POST /webhook   ← ضبّطه بداشبورد 360dialog
 *  إرسال OTP: POST /send-otp ← يناديه سيرفر هسه
 * ═══════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const wa = require('./wa');
const leads = require('./leads');
const F = require('./flows');
const inbox = require('./inbox');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ═══════════════ إدارة الجلسات ═══════════════
   بالذاكرة — كافي لحد ~عشرة آلاف محادثة نشطة.
   لو صرت أكبر من هيك، بدّلها بـ Redis (نفس الواجهة: get/set/clear).
   ═══════════════════════════════════════════ */
const sessions = new Map();
const TTL = F.SETTINGS.sessionTimeoutMinutes * 60 * 1000;

function getSession(phone) {
  const s = sessions.get(phone);
  if (s && Date.now() - s.touchedAt < TTL) { s.touchedAt = Date.now(); return s; }
  const fresh = { step: 'NEW', data: {}, touchedAt: Date.now() };
  sessions.set(phone, fresh);
  return fresh;
}
const clearSession = (phone) => sessions.delete(phone);

// تنظيف دوري
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.touchedAt > TTL) sessions.delete(k);
}, 10 * 60 * 1000).unref();

/* ═══════════════ أدوات ═══════════════ */

function isWorkingHours() {
  const wh = F.SETTINGS.workingHours;
  if (!wh) return true;
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: wh.timezone, hour: 'numeric', hour12: false,
  }).format(new Date()));
  return hour >= wh.start && hour < wh.end;
}

const showMenu = (to) => wa.sendButtons(to, {
  body: F.MAIN_MENU.body, footer: F.MAIN_MENU.footer, buttons: F.MAIN_MENU.buttons,
});

/** يطلّع نص أو معرّف الزر/الصف من رسالة واتساب */
function parseIncoming(msg) {
  if (msg.type === 'text') return { text: (msg.text?.body || '').trim(), id: null };
  if (msg.type === 'interactive') {
    const i = msg.interactive;
    if (i.type === 'button_reply') return { text: i.button_reply.title, id: i.button_reply.id };
    if (i.type === 'list_reply')   return { text: i.list_reply.title,   id: i.list_reply.id };
  }
  if (msg.type === 'button') return { text: msg.button?.text || '', id: msg.button?.payload || null };
  return { text: '', id: null };
}

const isRestart = (t) => ['0', 'رجوع', 'القائمة', 'البداية', 'menu', 'start', 'مرحبا', 'السلام عليكم']
  .includes((t || '').toLowerCase().trim());

/* ═══════════════ منطق المحادثة ═══════════════ */

async function handle(phone, incoming) {
  const s = getSession(phone);
  const { text, id } = incoming;
  const choice = id || text;

  // "0" أو أي كلمة رجوع → القائمة الرئيسية
  if (isRestart(text)) {
    clearSession(phone);
    getSession(phone).step = 'MENU';
    return showMenu(phone);
  }

  // ── كلمات التطبيق: نرسل الروابط بأي وقت ──
  if (text && s.step !== 'AGENT') {
    const t = text.toLowerCase().trim();
    if (F.APP_KEYWORDS.some((k) => t === k || t.startsWith(k + ' ') || t.endsWith(' ' + k))) {
      return wa.sendText(phone, F.COMMON.apps);
    }
  }

  // ── أول رسالة ──
  if (s.step === 'NEW') {
    s.step = 'MENU';
    return showMenu(phone);
  }

  switch (s.step) {

    /* ─────────── القائمة الرئيسية ─────────── */
    case 'MENU': {
      if (choice === 'MENU_STORE') {
        s.step = 'STORE_NAME';
        await wa.sendText(phone, F.STORE.intro);
        return wa.sendText(phone, F.STORE.askName);
      }
      if (choice === 'MENU_COURIER') {
        s.step = 'COURIER_NAME';
        await wa.sendText(phone, F.COURIER.intro);
        return wa.sendText(phone, F.COURIER.askName);
      }
      if (choice === 'MENU_CUSTOMER') {
        s.step = 'CUSTOMER_MENU';
        return wa.sendButtons(phone, { body: F.CUSTOMER.intro, buttons: F.CUSTOMER.buttons });
      }
      return wa.sendText(phone, F.COMMON.fallback);
    }

    /* ─────────── مسار المتجر ─────────── */
    case 'STORE_NAME': {
      if (!text || text.length < 2) return wa.sendText(phone, F.STORE.askName);
      s.data.storeName = text.slice(0, 120);
      s.step = 'STORE_CATEGORY';
      return wa.sendList(phone, {
        body: F.STORE.askCategory,
        button: F.STORE.categoryList.button,
        title: F.STORE.categoryList.title,
        rows: F.STORE.categoryList.rows,
      });
    }

    case 'STORE_CATEGORY': {
      if (!id || !F.LABELS[id]) {
        return wa.sendList(phone, {
          body: F.STORE.askCategory,
          button: F.STORE.categoryList.button,
          title: F.STORE.categoryList.title,
          rows: F.STORE.categoryList.rows,
        });
      }
      s.data.category = id;
      s.data.categoryLabel = F.LABELS[id];
      s.step = 'STORE_AREA';
      return wa.sendText(phone, F.STORE.askArea);
    }

    case 'STORE_AREA': {
      if (!text || text.length < 2) return wa.sendText(phone, F.STORE.askArea);
      s.data.area = text.slice(0, 120);
      s.step = 'STORE_PHOTO_DAY';
      return wa.sendList(phone, {
        body: F.STORE.askPhotoDay,
        button: F.STORE.photoDayList.button,
        title: F.STORE.photoDayList.title,
        rows: F.STORE.photoDayList.rows,
      });
    }

    case 'STORE_PHOTO_DAY': {
      if (!id || !F.LABELS[id]) {
        return wa.sendList(phone, {
          body: F.STORE.askPhotoDay,
          button: F.STORE.photoDayList.button,
          title: F.STORE.photoDayList.title,
          rows: F.STORE.photoDayList.rows,
        });
      }
      s.data.photoDay = id;
      s.data.photoDayLabel = F.LABELS[id];
      s.step = 'STORE_PHOTO_TIME';
      return wa.sendButtons(phone, {
        body: F.STORE.askPhotoTime, buttons: F.STORE.photoTimeButtons,
      });
    }

    case 'STORE_PHOTO_TIME': {
      if (!id || !F.LABELS[id]) {
        return wa.sendButtons(phone, {
          body: F.STORE.askPhotoTime, buttons: F.STORE.photoTimeButtons,
        });
      }
      s.data.photoTime = id;
      s.data.photoTimeLabel = F.LABELS[id];
      await leads.save({ type: 'store', phone, ...s.data }, wa);
      const done = F.STORE.done(s.data);
      clearSession(phone);
      await wa.sendText(phone, done);
      return wa.sendText(phone, F.APP_LINKS.store);
    }

    /* ─────────── مسار المندوب ─────────── */
    case 'COURIER_NAME': {
      if (!text || text.length < 2) return wa.sendText(phone, F.COURIER.askName);
      s.data.courierName = text.slice(0, 120);
      s.step = 'COURIER_BIKE';
      return wa.sendButtons(phone, {
        body: F.COURIER.askBike, buttons: F.COURIER.bikeButtons,
      });
    }

    case 'COURIER_BIKE': {
      if (!id || !F.LABELS[id]) {
        return wa.sendButtons(phone, {
          body: F.COURIER.askBike, buttons: F.COURIER.bikeButtons,
        });
      }
      s.data.vehicle = id;
      s.data.vehicleLabel = F.LABELS[id];

      // ماكو دراجة → نحفظه بقائمة انتظار وننهي بلطف
      if (id === 'BIKE_NO') {
        await leads.save({ type: 'courier', status: 'no_bike', phone, ...s.data }, wa);
        clearSession(phone);
        return wa.sendText(phone, F.COURIER.noBike);
      }

      s.step = 'COURIER_AREA';
      return wa.sendText(phone, F.COURIER.askArea);
    }

    case 'COURIER_AREA': {
      if (!text || text.length < 2) return wa.sendText(phone, F.COURIER.askArea);
      s.data.area = text.slice(0, 120);
      await leads.save({ type: 'courier', status: 'ready', phone, ...s.data }, wa);
      clearSession(phone);
      return wa.sendText(phone, F.COURIER.done(s.data));
    }

    /* ─────────── مسار الزبون ─────────── */
    case 'CUSTOMER_MENU': {
      if (choice === 'BACK_MENU') {
        clearSession(phone);
        getSession(phone).step = 'MENU';
        return showMenu(phone);
      }
      if (choice === 'CUS_ORDER') {
        s.step = 'CUSTOMER_ORDER_NO';
        return wa.sendText(phone, F.CUSTOMER.askOrderNo);
      }
      if (choice === 'CUS_FAQ') {
        s.step = 'CUSTOMER_FAQ';
        return wa.sendList(phone, {
          body: F.CUSTOMER.faqList.body,
          button: F.CUSTOMER.faqList.button,
          title: F.CUSTOMER.faqList.title,
          rows: F.CUSTOMER.faqList.rows,
        });
      }
      if (choice === 'CUS_AGENT') {
        s.step = 'AGENT';
        await wa.sendText(phone, F.CUSTOMER.agentHandoff);
        if (!isWorkingHours()) await wa.sendText(phone, F.COMMON.afterHours);
        return;
      }
      return wa.sendText(phone, F.COMMON.fallback);
    }

    case 'CUSTOMER_ORDER_NO': {
      if (!text) return wa.sendText(phone, F.CUSTOMER.askOrderNo);
      s.step = 'AGENT';
      await wa.sendText(phone, F.CUSTOMER.orderReceived(text.slice(0, 40)));
      if (!isWorkingHours()) await wa.sendText(phone, F.COMMON.afterHours);
      return;
    }

    case 'CUSTOMER_FAQ': {
      const answer = F.CUSTOMER.faqAnswers[id];
      if (!answer) {
        return wa.sendList(phone, {
          body: F.CUSTOMER.faqList.body,
          button: F.CUSTOMER.faqList.button,
          title: F.CUSTOMER.faqList.title,
          rows: F.CUSTOMER.faqList.rows,
        });
      }
      await wa.sendText(phone, answer);
      return wa.sendButtons(phone, {
        body: 'تحتاج شي ثاني؟',
        buttons: [
          { id: 'CUS_FAQ',   title: '❓ سؤال ثاني' },
          { id: 'CUS_AGENT', title: '💬 أحچي مع موظف' },
          { id: 'BACK_MENU', title: '🔙 القائمة' },
        ],
      }).then(() => { s.step = 'CUSTOMER_MENU'; });
    }

    /* ─────────── محوّل لموظف: البوت يسكت ─────────── */
    case 'AGENT':
      // الموظف يرد من الإنبوكس. البوت ما يتدخل.
      return;

    default:
      clearSession(phone);
      return showMenu(phone);
  }
}

/* ═══════════════ الويبهوك ═══════════════ */

app.get('/webhook', (req, res) => {
  // تحقق ميتا (إذا استخدمته)
  const token = process.env.VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(200);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // رد فوري — واتساب يعيد الإرسال إذا تأخرنا

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // تجاهل تحديثات الحالة (delivered / read)
        if (!value.messages) continue;

        for (const msg of value.messages) {
          const phone = msg.from;                       // بصيغة 9647XXXXXXXXX
          wa.markRead(msg.id);

          const incoming = parseIncoming(msg);
          const label = incoming.text || incoming.id || msg.type;
          console.log(`[in] +${phone} → ${incoming.id || incoming.text || msg.type}`);
          inbox.record(phone, 'in', label, {
            step: getSession(phone).step,
            name: value.contacts?.[0]?.profile?.name,
          });

          // الموظف مسك المحادثة → البوت يسكت (إلا إذا كتب 0)
          if (inbox.isBotPaused(phone) && String(incoming.text).trim() !== '0') continue;
          if (String(incoming.text).trim() === '0') inbox.setBotPaused(phone, false);

          try {
            await handle(phone, incoming);
            inbox.setStep(phone, getSession(phone).step);
          } catch (e) {
            console.error(`[bot] خطأ مع +${phone}:`, e.message, e.details || '');
            await wa.sendText(phone, F.COMMON.error).catch(() => {});
          }
        }
      }
    }
  } catch (e) {
    console.error('[webhook] خطأ عام:', e);
  }
});

/* ═══════════════ إرسال OTP ═══════════════
   سيرفر هسه ينادي هذا بدل ما يتعامل مع واتساب مباشرة.
   POST /send-otp  { "phone": "9647801234567", "code": "483920" }
   Header: Authorization: Bearer <INTERNAL_TOKEN>
   ═════════════════════════════════════════ */
app.post('/send-otp', async (req, res) => {
  const auth = req.get('authorization') || '';
  if (process.env.INTERNAL_TOKEN && auth !== `Bearer ${process.env.INTERNAL_TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { phone, code } = req.body || {};
  if (!phone || !code) return res.status(400).json({ ok: false, error: 'phone و code مطلوبين' });

  const to = String(phone).replace(/\D/g, '');
  if (!/^964\d{9,10}$/.test(to)) {
    return res.status(400).json({ ok: false, error: 'الرقم لازم يكون بصيغة 9647XXXXXXXXX' });
  }

  try {
    const r = await wa.sendOtp(to, code);
    console.log(`[otp] ✅ +${to}`);
    res.json({ ok: true, messageId: r?.messages?.[0]?.id });
  } catch (e) {
    console.error(`[otp] ❌ +${to}`, e.details || e.message);
    res.status(502).json({ ok: false, error: 'فشل الإرسال', details: e.details });
  }
});

/* ═══════════════ إرسال إشعار بتمبلت ═══════════════
   لأي رسالة معتمدة: تأكيد طلب، بالطريق، تم التسليم، ترحيب...
   POST /send-template
   { "phone":"9647801234567", "template":"hassah_order_confirmed", "params":["1042","5,000"] }
   Header: Authorization: Bearer <INTERNAL_TOKEN>
   ═════════════════════════════════════════════════ */
app.post('/send-template', async (req, res) => {
  const auth = req.get('authorization') || '';
  if (process.env.INTERNAL_TOKEN && auth !== `Bearer ${process.env.INTERNAL_TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { phone, template, params = [], lang = 'ar' } = req.body || {};
  if (!phone || !template) {
    return res.status(400).json({ ok: false, error: 'phone و template مطلوبين' });
  }

  const to = String(phone).replace(/\D/g, '');
  if (!/^964\d{9,10}$/.test(to)) {
    return res.status(400).json({ ok: false, error: 'الرقم لازم يكون بصيغة 9647XXXXXXXXX' });
  }

  try {
    const r = await wa.sendTemplate(to, template, params, lang);
    console.log(`[tpl] ✅ ${template} → +${to}`);
    res.json({ ok: true, messageId: r?.messages?.[0]?.id });
  } catch (e) {
    console.error(`[tpl] ❌ ${template} → +${to}`, e.details || e.message);
    res.status(502).json({ ok: false, error: 'فشل الإرسال', details: e.details });
  }
});

/* ═══════════════ الإنبوكس ═══════════════ */
inbox.mount(app, wa);

/* ═══════════════ صحة السيرفر ═══════════════ */
app.get('/health', (_, res) =>
  res.json({ ok: true, sessions: sessions.size, workingHours: isWorkingHours() }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🟢 بوت ${F.BRAND} شغّال على المنفذ ${PORT}`);
    console.log(`   الويبهوك:  POST /webhook`);
    console.log(`   إرسال OTP: POST /send-otp`);
    console.log(`   إشعارات:   POST /send-template`);
    console.log(`   الإنبوكس:  GET  /inbox?key=...\n`);
  });
}

module.exports = { app, handle, getSession, clearSession, parseIncoming, isWorkingHours };
