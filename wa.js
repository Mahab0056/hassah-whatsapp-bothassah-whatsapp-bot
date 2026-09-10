/**
 * طبقة الاتصال بواتساب عبر 360dialog
 * كل الطلبات تروح لـ https://waba-v2.360dialog.io
 */

const API_BASE = process.env.D360_API_BASE || 'https://waba-v2.360dialog.io';
const API_KEY  = process.env.D360_API_KEY;

if (!API_KEY) {
  console.warn('[wa] ⚠️  D360_API_KEY مو مضبوط — الإرسال راح يفشل.');
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
function sendText(to, body, preview = false) {
  return send({ recipient_type: 'individual', to, type: 'text',
    text: { body, preview_url: preview } });
}

/* ---------- أزرار (٣ كحد أقصى، ٢٠ حرف للزر) ---------- */
function sendButtons(to, { body, footer, header, buttons }) {
  if (buttons.length > 3) throw new Error('واتساب يسمح بـ 3 أزرار كحد أقصى');
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
  if (rows.length > 10) throw new Error('واتساب يسمح بـ 10 صفوف كحد أقصى');
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

module.exports = { sendText, sendButtons, sendList, markRead, sendOtp };
