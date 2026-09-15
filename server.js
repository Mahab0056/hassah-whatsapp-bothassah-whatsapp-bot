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
const ai = require('./ai');

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
  const fresh = { step: 'NEW', data: {}, name: '', touchedAt: Date.now() };
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

const showMenu = (to, name) => wa.sendButtons(to, {
  body: typeof F.MAIN_MENU.body === 'function' ? F.MAIN_MENU.body(name) : F.MAIN_MENU.body,
  footer: F.MAIN_MENU.footer,
  buttons: F.MAIN_MENU.buttons,
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
  if (msg.type === 'location') {
    const l = msg.location || {};
    const label = [l.name, l.address].filter(Boolean).join(' — ');
    return {
      text: label || `موقع: ${l.latitude}, ${l.longitude}`,
      id: null,
      location: { lat: l.latitude, lng: l.longitude, name: l.name || '', address: l.address || '' },
    };
  }
  return { text: '', id: null };
}

const isRestart = (t) => ['0', 'رجوع', 'القائمة', 'البداية', 'menu', 'start', 'مرحبا', 'السلام عليكم']
  .includes((t || '').toLowerCase().trim());

/* ═══════════════ منطق المحادثة ═══════════════ */


/* ═══════════════ طبقة الذكاء ═══════════════
   تنادى لمن الزبون يكتب شي برّا السيناريو. إذا الذكاء مو مفعّل أو فشل،
   نرجع false والمنادي يستعمل الرد الثابت القديم — يعني ما ننكسر أبداً.
   ═══════════════════════════════════════════ */
async function aiReply(phone, situation, { onQuestionResume, resumeText } = {}) {
  if (!ai.enabled) return false;

  const t = inbox.get(phone);
  const history = (t ? t.messages : [])
    .filter((m) => !m.t && m.text)
    .slice(-10)
    .map((m) => ({ role: m.dir === 'in' ? 'user' : 'assistant', content: m.text }));

  const out = await ai.think(history, situation);
  if (!out) return false;

  /* إذا عدنا نص نرجعه بيه للخطوة، ندمجه بنفس الرسالة —
     رسالتين ورا بعض تخلي الكلام يبين آلي. */
  const merge = resumeText && out.action === 'answer';
  await wa.sendText(phone, merge ? `${out.reply}\n\n${resumeText}` : out.reply);

  const s = getSession(phone);
  switch (out.action) {
    case 'menu':
      clearSession(phone);
      getSession(phone).name = s.name;
      await showMenu(phone, s.name);
      break;
    case 'courier':
      s.step = 'COURIER_NAME'; s.data = {};
      await wa.sendText(phone, F.COURIER.intro);
      await wa.sendText(phone, F.COURIER.askName);
      break;
    case 'store':
      s.step = 'STORE_NAME'; s.data = {};
      await wa.sendText(phone, F.STORE.intro);
      await wa.sendText(phone, F.STORE.askName);
      break;
    case 'agent':
      s.step = 'AGENT';
      if (!isWorkingHours()) await wa.sendText(phone, F.COMMON.afterHours);
      break;
    default:
      // جاوب سؤاله ونرجعه لنفس الخطوة الي كان بيها
      if (!merge && onQuestionResume) await onQuestionResume();
  }
  inbox.setStep(phone, getSession(phone).step);
  return true;
}

async function handle(phone, incoming) {
  const s = getSession(phone);
  const { text, id } = incoming;
  const choice = id || text;

  // اسم الزبون من بروفايل واتساب — نستخدمه بالتحية حتى تحس بشرية
  if (incoming.name && !s.name) s.name = incoming.name;

  // "0" أو أي كلمة رجوع → القائمة الرئيسية
  if (isRestart(text)) {
    const name = s.name;
    clearSession(phone);
    const ns = getSession(phone);
    ns.step = 'MENU';
    ns.name = name;
    return showMenu(phone, name);
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
    return showMenu(phone, s.name);
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
      if (await aiReply(phone, 'بالقائمة الرئيسية. كتب كلام حر بدل ما يضغط زر.',
        { onQuestionResume: () => showMenu(phone, s.name) })) return;
      return wa.sendText(phone, F.COMMON.fallback);
    }

    /* ─────────── مسار المتجر ─────────── */
    case 'STORE_NAME': {
      if (!text || text.length < 2) return wa.sendText(phone, F.STORE.askName);
      if (ai.looksLikeQuestion(text) && await aiReply(phone,
        'بمسار تسجيل المتجر، بخطوة اسم المتجر. سأل سؤال بدل ما ينطي الاسم.',
        { resumeText: F.STORE.askName })) return;
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
        const askCategory = () => wa.sendList(phone, {
          body: F.STORE.askCategory,
          button: F.STORE.categoryList.button,
          title: F.STORE.categoryList.title,
          rows: F.STORE.categoryList.rows,
        });
        if (text && await aiReply(phone,
          'بمسار تسجيل المتجر، بخطوة اختيار نوع المتجر من القائمة. كتب كلام حر بدل ما يختار.',
          { onQuestionResume: askCategory })) return;
        return askCategory();
      }
      s.data.category = id;
      s.data.categoryLabel = F.LABELS[id];
      s.step = 'STORE_PHOTOS';
      return wa.sendButtons(phone, {
        body: F.STORE.askPhotos, buttons: F.STORE.photoButtons,
      });
    }

    case 'STORE_PHOTOS': {
      if (!id || !F.LABELS[id]) {
        const askPhotos = () => wa.sendButtons(phone, {
          body: F.STORE.askPhotos, buttons: F.STORE.photoButtons,
        });
        if (text && await aiReply(phone,
          'بمسار تسجيل المتجر، بخطوة الصور (عنده صور جاهزة لو يريد تصوير). كتب كلام حر بدل ما يضغط زر.',
          { onQuestionResume: askPhotos })) return;
        return askPhotos();
      }
      s.data.photoMode = id;
      s.data.photoModeLabel = F.LABELS[id];

      // عنده صور جاهزة وما يريد تصوير → نتخطى الموعد ونروح للموقع
      if (id === 'PH_HAVE') {
        s.step = 'STORE_LOCATION';
        return wa.sendText(phone, F.STORE.askLocation);
      }
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
        const askDay = () => wa.sendList(phone, {
          body: F.STORE.askPhotoDay,
          button: F.STORE.photoDayList.button,
          title: F.STORE.photoDayList.title,
          rows: F.STORE.photoDayList.rows,
        });
        if (text && await aiReply(phone,
          'بمسار تسجيل المتجر، بخطوة اختيار يوم التصوير من القائمة. كتب كلام حر بدل ما يختار.',
          { onQuestionResume: askDay })) return;
        return askDay();
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
        const askTime = () => wa.sendButtons(phone, {
          body: F.STORE.askPhotoTime, buttons: F.STORE.photoTimeButtons,
        });
        if (text && await aiReply(phone,
          'بمسار تسجيل المتجر، بخطوة وقت التصوير (صباحي/مسائي). كتب كلام حر بدل ما يضغط زر.',
          { onQuestionResume: askTime })) return;
        return askTime();
      }
      s.data.photoTime = id;
      s.data.photoTimeLabel = F.LABELS[id];
      s.step = 'STORE_LOCATION';
      return wa.sendText(phone, F.STORE.askLocation);
    }

    case 'STORE_LOCATION': {
      // إما لوكيشن مدزوز، أو عنوان مكتوب بتفصيل كافي
      if (incoming.location) {
        const l = incoming.location;
        s.data.lat = l.lat;
        s.data.lng = l.lng;
        s.data.mapUrl = `https://maps.google.com/?q=${l.lat},${l.lng}`;
        s.data.locationText = [l.name, l.address].filter(Boolean).join(' — ') || 'لوكيشن مدزوز 📍';
        s.data.area = s.data.locationText;
      } else if (text && text.trim().length >= 8 && !ai.looksLikeQuestion(text)) {
        s.data.locationText = text.slice(0, 300);
        s.data.area = s.data.locationText;
      } else {
        if (text && await aiReply(phone,
          'بمسار تسجيل المتجر، بآخر خطوة: عنوان المتجر أو لوكيشن. ما نطى عنوان واضح.',
          { resumeText: F.STORE.locationHint })) return;
        return wa.sendText(phone, F.STORE.locationHint);
      }
      await leads.save({ type: 'store', phone, ...s.data }, wa);
      const doneMsg = F.STORE.done(s.data);
      clearSession(phone);
      await wa.sendText(phone, doneMsg);
      return wa.sendText(phone, F.APP_LINKS.store);
    }

    /* ─────────── مسار المندوب ─────────── */
    case 'COURIER_NAME': {
      if (!text || text.length < 2) return wa.sendText(phone, F.COURIER.askName);
      if (ai.looksLikeQuestion(text) && await aiReply(phone,
        'بمسار تسجيل المندوب، بخطوة الاسم. سأل سؤال بدل ما ينطي اسمه.',
        { resumeText: F.COURIER.askName })) return;
      s.data.courierName = text.slice(0, 120);
      s.step = 'COURIER_BIKE';
      return wa.sendButtons(phone, {
        body: F.COURIER.askBike, buttons: F.COURIER.bikeButtons,
      });
    }

    case 'COURIER_BIKE': {
      if (!id || !F.LABELS[id]) {
        const askBike = () => wa.sendButtons(phone, {
          body: F.COURIER.askBike, buttons: F.COURIER.bikeButtons,
        });
        if (text && await aiReply(phone,
          'بمسار تسجيل المندوب، بخطوة: عنده دراجة/سيارة لو لا. كتب كلام حر بدل ما يضغط زر.',
          { onQuestionResume: askBike })) return;
        return askBike();
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
      if (ai.looksLikeQuestion(text) && await aiReply(phone,
        'بمسار تسجيل المندوب، بخطوة المنطقة الي يشتغل بيها. سأل سؤال بدل ما ينطي المنطقة.',
        { resumeText: F.COURIER.askArea })) return;
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
        return showMenu(phone, s.name);
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
      if (await aiReply(phone, 'بقائمة الزبون (متابعة طلب / أسئلة / موظف). كتب كلام حر بدل ما يضغط زر.',
        { onQuestionResume: () => wa.sendButtons(phone, { body: F.CUSTOMER.intro, buttons: F.CUSTOMER.buttons }) })) return;
      return wa.sendText(phone, F.COMMON.fallback);
    }

    case 'CUSTOMER_ORDER_NO': {
      if (!text) return wa.sendText(phone, F.CUSTOMER.askOrderNo);
      if (ai.looksLikeQuestion(text) && await aiReply(phone,
        'بمسار متابعة الطلب، بخطوة رقم الطلب. سأل سؤال بدل ما ينطي الرقم.',
        { resumeText: F.CUSTOMER.askOrderNo })) return;
      s.step = 'AGENT';
      await wa.sendText(phone, F.CUSTOMER.orderReceived(text.slice(0, 40)));
      if (!isWorkingHours()) await wa.sendText(phone, F.COMMON.afterHours);
      return;
    }

    case 'CUSTOMER_FAQ': {
      const answer = F.CUSTOMER.faqAnswers[id];
      if (!answer) {
        const askFaq = () => wa.sendList(phone, {
          body: F.CUSTOMER.faqList.body,
          button: F.CUSTOMER.faqList.button,
          title: F.CUSTOMER.faqList.title,
          rows: F.CUSTOMER.faqList.rows,
        });
        if (text && await aiReply(phone,
          'بقائمة الأسئلة الشائعة. كتب سؤاله بنفسه بدل ما يختار من القائمة.',
          { onQuestionResume: askFaq })) return;
        return askFaq();
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
      return showMenu(phone, s.name);
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
          /* بعض الرسايل (خصوصاً الجاية من إعلانات CTWA) ما بيها msg.from.
             ميتا بدت تدز هوية واتساب الجديدة بـ from_user_id (مثل "IQ.2824...")
             بدل الرقم. نجرب كل الاحتمالات قبل ما نستسلم — بدون هذا الزبون ينضاع. */
          const phone = msg.from
            || value.contacts?.[0]?.wa_id
            || msg.from_user_id
            || value.contacts?.[0]?.user_id
            || msg.recipient_id;
          if (!phone) {
            console.error('[webhook] ⚠️ رسالة بلا رقم —', JSON.stringify(msg).slice(0, 400));
            continue;
          }
          wa.markRead(msg.id);

          const incoming = parseIncoming(msg);
          incoming.name = value.contacts?.[0]?.profile?.name || '';
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
            // وقفة قصيرة — يشوف "يكتب..." بدل رد فوري كالروبوت
            await wa.humanPause(incoming.text);
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
