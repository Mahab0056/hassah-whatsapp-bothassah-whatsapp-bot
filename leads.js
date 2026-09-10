/**
 * حفظ الليدز (المتاجر والمندوبين)
 *
 * يحفظ بمكانين:
 *   1. ملف محلي leads.jsonl  — نسخة احتياطية دائمة
 *   2. LEADS_WEBHOOK_URL     — سيرفر هسه / Google Sheet / أي مكان تريده
 *
 * وإذا ضبطت TEAM_NOTIFY_NUMBERS، يوصل تنبيه واتساب لفريقك فوراً.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'leads.jsonl');
const WEBHOOK = process.env.LEADS_WEBHOOK_URL;
const NOTIFY = (process.env.TEAM_NOTIFY_NUMBERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function appendFile(lead) {
  try {
    fs.appendFileSync(FILE, JSON.stringify(lead) + '\n', 'utf8');
  } catch (e) {
    console.error('[leads] فشل الحفظ بالملف:', e.message);
  }
}

async function postWebhook(lead) {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LEADS_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.LEADS_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(lead),
    });
    if (!res.ok) console.error('[leads] الويبهوك رجّع', res.status, await res.text());
  } catch (e) {
    console.error('[leads] فشل إرسال الويبهوك:', e.message);
  }
}

async function notifyTeam(lead, wa) {
  if (!NOTIFY.length) return;
  const isStore = lead.type === 'store';
  const msg = isStore
    ? `🏪 *متجر جديد*\n\n` +
      `الاسم: ${lead.storeName}\n` +
      `النوع: ${lead.categoryLabel}\n` +
      `المنطقة: ${lead.area}\n` +
      `الرقم: +${lead.phone}\n\n` +
      `_وصل عن طريق واتساب هسه_`
    : `🛵 *مندوب جديد*\n\n` +
      `الاسم: ${lead.courierName}\n` +
      `المركبة: ${lead.vehicleLabel}\n` +
      `المنطقة: ${lead.area}\n` +
      `الرقم: +${lead.phone}\n\n` +
      `_وصل عن طريق واتساب هسه_`;

  await Promise.allSettled(NOTIFY.map((n) => wa.sendText(n, msg)));
}

async function save(lead, wa) {
  const record = { ...lead, savedAt: new Date().toISOString() };
  appendFile(record);
  await Promise.allSettled([postWebhook(record), notifyTeam(record, wa)]);
  console.log(`[leads] ✅ ${record.type} — +${record.phone}`);
  return record;
}

module.exports = { save };
