/**
 * قائمة الإيقاف — من طلب ما يوصله رسائل تسويقية
 *
 * ليش مهمة: ميتا تقيس نسبة الحظر والبلاغات. إذا واحد طلب يوقف
 * ودزينالة بعدها، يحظرنا — وتقييم الجودة ينزل، وبعدها الحد اليومي
 * ينزل من 2,000 لـ250، ووقتها حتى الـOTP يتعطل والتسجيل يوقف.
 *
 * يعني هذا الملف مو "التزام قانوني" بس — هو حماية لأهم شي عدنا.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'optout.jsonl');

/** @type {Map<string,{at:number,src:string}>} */
const opted = new Map();

/* تنظيف الرقم: أرقام بس. يخلي 07XX و+9647XX و9647XX كلهن نفس المفتاح. */
function norm(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '964' + p.slice(1);      // 07XX → 9647XX
  if (p.startsWith('7') && p.length >= 9) p = '964' + p;
  return p;
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    let n = 0;
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.phone) { opted.set(norm(r.phone), { at: r.at || 0, src: r.src || '' }); n++; }
      } catch { /* سطر خربان — نتجاهله */ }
    }
    if (n) console.log(`[optout] ♻️  ${opted.size} رقم بقائمة الإيقاف`);
  } catch (e) {
    console.error('[optout] فشل التحميل:', e.message);
  }
}

function add(phone, src = 'keyword') {
  const p = norm(phone);
  if (!p || opted.has(p)) return false;
  const rec = { phone: p, at: Date.now(), src };
  opted.set(p, { at: rec.at, src });
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8'); }
  catch (e) { console.error('[optout] فشل الحفظ:', e.message); }
  console.log(`[optout] 🚫 +${p} (${src})`);
  return true;
}

const has = (phone) => opted.has(norm(phone));
const count = () => opted.size;

/* ── كلمات الإيقاف ──
   نقبل صيغ كثيرة لأن الزبون ما راح يكتبها مضبوطة. */
const STOP_WORDS = [
  'ايقاف', 'إيقاف', 'ايقاف الرسائل', 'إيقاف الرسائل', 'وقف', 'اوقف', 'أوقف',
  'الغاء', 'إلغاء', 'الغاء الاشتراك', 'إلغاء الاشتراك', 'لا تدزلي', 'لا تراسلوني',
  'stop', 'unsubscribe', 'cancel',
];

function isStop(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase()
    .replace(/[«»"'.،,!؟?]/g, '').replace(/\s+/g, ' ');
  return STOP_WORDS.includes(t);
}

const CONFIRM = 'تمام، وقّفنا الرسائل التسويقية عنك. ✅\n' +
  'تگدر تراسلنا بأي وقت إذا احتجت شي.';

load();

module.exports = { add, has, count, isStop, norm, CONFIRM };
