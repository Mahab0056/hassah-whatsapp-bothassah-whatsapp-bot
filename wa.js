/**
 * طبقة الاتصال بواتساب عبر 360dialog
 * كل الطلبات تروح لـ https://waba-v2.360dialog.io
 */

const API_BASE = process.env.D360_API_BASE || 'https://waba-v2.360dialog.io';
const API_KEY  = process.env.D360_API_KEY;

if (!API_KEY) {
  console.warn('[wa] ⚠️  D360_API_KEY مو مضبوط — الإرسال راح يفشل.');
}

// تسجيل الصادر بالإنبوكس (تحميل كسول حتى نتجنب الاستيراد الدائري)
let _inbox = null;
function logOut(to, text, by) {
  try {
    if (!_inbox) _inbox = require('./inbox');
    _inbox.record(String(to), 'out', text, { by: by || 'bot' });
  } catch { /* الإنبوكس اختياري */ }
}

async function call(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'D360-API-KEY': API_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error('[wa] فشل الإرسال', res.status, JSON.stringify(json));
    const err = new Error(`WhatsApp API ${res.status}`);
    err.details = json;
    throw err;
  }
  return json;
}

const send = (payload) => call('/messages', { messaging_product: 'whatsapp', ...payload });

/* ---------- رسالة نصية ---------- */
function sendText(to, body, preview = true) {
  logOut(to, body);
  return send({ recipient_type: 'individual', to, type: 'text',
    text: { body, preview_url: preview } });
}

/* ---------- أزرار (٣ كحد أقصى، ٢٠ حرف للزر) ---------- */
function sendButtons(to, { body, footer, header, buttons }) {
  if (!Array.isArray(buttons) || !buttons.length) {
    // حماية: إذا الأزرار ناقصة لأي سبب، نرسل النص بدل ما ننهار
    console.error('[wa] ⚠️ أزرار مفقودة — رجعنا لرسالة نصية');
    return sendText(to, body);
  }
  if (buttons.length > 3) throw new Error('واتساب يسمح بـ 3 أزرار كحد أقصى');
  logOut(to, body);
  const interactive = {
    type: 'button',
    body: { text: body },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title.slice(0, 20) },
      })),
    },
  };
  if (header) interactive.header = { type: 'text', text: header.slice(0, 60) };
  if (footer) interactive.footer = { text: footer.slice(0, 60) };
  return send({ recipient_type: 'individual', to, type: 'interactive', interactive });
}

/* ---------- قائمة (١٠ صفوف كحد أقصى) ---------- */
function sendList(to, { body, footer, header, button, title, rows }) {
  if (!Array.isArray(rows) || !rows.length) {
    console.error('[wa] ⚠️ صفوف مفقودة — رجعنا لرسالة نصية');
    return sendText(to, body);
  }
  if (rows.length > 10) throw new Error('واتساب يسمح بـ 10 صفوف كحد أقصى');
  logOut(to, body);
  const interactive = {
    type: 'list',
    body: { text: body },
    action: {
      button: button.slice(0, 20),
      sections: [{
        title: title.slice(0, 24),
        rows: rows.map((r) => ({
          id: r.id,
          title: r.title.slice(0, 24),
          ...(r.description ? { description: r.description.slice(0, 72) } : {}),
        })),
      }],
    },
  };
  if (header) interactive.header = { type: 'text', text: header.slice(0, 60) };
  if (footer) interactive.footer = { text: footer.slice(0, 60) };
  return send({ recipient_type: 'individual', to, type: 'interactive', interactive });
}

/* ---------- علامة "مقروء" ---------- */
function markRead(messageId) {
  return call('/messages', { messaging_product: 'whatsapp', status: 'read', message_id: messageId })
    .catch(() => {}); // مو مهم إذا فشلت
}

/* ================================================================
   إرسال رمز التحقق (OTP)
   يستخدم تمبلت hassah_otp — يناديه سيرفر هسه، مو البوت
   ================================================================ */
function sendOtp(to, code, templateName = process.env.OTP_TEMPLATE || 'hassah_otp', lang = 'ar') {
  return send({
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        { type: 'body',   parameters: [{ type: 'text', text: String(code) }] },
        { type: 'button', sub_type: 'url', index: '0',
          parameters: [{ type: 'text', text: String(code) }] },
      ],
    },
  });
}

/* ================================================================
   إرسال أي تمبلت معتمد — للإشعارات (تأكيد طلب، بالطريق، تم التسليم...)
   params: مصفوفة نصوص تنعبى بمكان {{1}} {{2}} ... بترتيبها
   ================================================================ */
function sendTemplate(to, templateName, params = [], lang = 'ar') {
  const components = [];
  if (params.length) {
    components.push({
      type: 'body',
      parameters: params.map((p) => ({ type: 'text', text: String(p) })),
    });
  }
  logOut(to, `[تمبلت: ${templateName}] ${params.join(' · ')}`, 'system');
  return send({
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: templateName, language: { code: lang }, components },
  });
}

module.exports = { sendText, sendButtons, sendList, markRead, sendOtp, sendTemplate };
