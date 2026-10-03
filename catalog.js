/**
 * كتالوج المنتجات — يطلّع feed بصيغة ميتا
 *
 * ليش هيچي: ميتا ما تاخذ منتجات وحدة وحدة. تريد ملف واحد فيه كل
 * المنتجات، وتسحبه كل ساعة لحالها. يعني نغيّر السعر عدنا — ينتغيّر
 * بالإعلان بدون ما نلمس ميتا.
 *
 * GET  /feed.csv        ← ميتا تسحب من هنا (عام، بمفتاح بالرابط)
 * POST /products        ← Technolanes تدزّ المنتجات (INTERNAL_TOKEN)
 * GET  /products/stats  ← كم منتج وكم مرفوض وليش
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'products.jsonl');

const DEEP = process.env.DEEP_LINK_BASE || 'https://hassa-admin.technolanes.com/deep-link';
const ANDROID_PKG = process.env.ANDROID_PACKAGE || 'app.technolanes.hassah';
const IOS_APP_ID = process.env.IOS_APP_ID || '6757367057';
const CURRENCY = process.env.FEED_CURRENCY || 'IQD';

/** @type {Map<string,object>} */
const items = new Map();

/* ── التحقق ──
   نرفض المنتج هنا بدل ما ميتا ترفضه بعدين — الرفض عدها صامت
   وتضيع أسبوع وإنت تفكر ليش الإعلان ما يشتغل. */
function validate(p) {
  const bad = [];
  if (!p.id) bad.push('ماكو id');
  if (!p.title || String(p.title).trim().length < 3) bad.push('العنوان قصير أو فارغ');
  if (String(p.title || '').length > 200) bad.push('العنوان أطول من 200 حرف');
  const price = Number(p.price);
  if (!Number.isFinite(price) || price <= 0) bad.push('السعر مو رقم صحيح');
  if (!p.image_link || !/^https?:\/\//.test(p.image_link)) bad.push('رابط الصورة ناقص أو مو https');
  if (!p.merchantId && !p.link) bad.push('ماكو merchantId ولا link');
  return bad;
}

function normalize(p) {
  const id = String(p.id).trim();
  const link = p.link ||
    `${DEEP}?productId=${encodeURIComponent(id)}&merchantId=${encodeURIComponent(p.merchantId || '')}`;
  return {
    id,
    title: String(p.title).trim().slice(0, 200),
    description: String(p.description || p.title).trim().slice(0, 5000),
    availability: p.availability || (Number(p.stock) === 0 ? 'out of stock' : 'in stock'),
    condition: p.condition || 'new',
    price: `${Math.round(Number(p.price))} ${CURRENCY}`,
    sale_price: p.sale_price ? `${Math.round(Number(p.sale_price))} ${CURRENCY}` : '',
    link,
    image_link: p.image_link,
    additional_image_link: (p.additional_image_link || p.images || []).slice(0, 10).join(','),
    brand: p.brand || p.merchantName || 'هسة',
    product_type: p.category || '',
    quantity_to_sell_on_facebook: p.stock != null ? String(p.stock) : '',
    'applink.ios_url': p.ios_url || link,
    'applink.ios_app_store_id': IOS_APP_ID,
    'applink.ios_app_name': 'Hassah',
    'applink.android_url': p.android_url || link,
    'applink.android_package': ANDROID_PKG,
    'applink.android_app_name': 'Hassah',
  };
}

const COLUMNS = [
  'id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price',
  'link', 'image_link', 'additional_image_link', 'brand', 'product_type',
  'quantity_to_sell_on_facebook',
  'applink.ios_url', 'applink.ios_app_store_id', 'applink.ios_app_name',
  'applink.android_url', 'applink.android_package', 'applink.android_app_name',
];

/* CSV: أي حقل بيه فاصلة أو علامة اقتباس أو سطر جديد لازم ينحط بين "" */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv() {
  const lines = [COLUMNS.join(',')];
  for (const p of items.values()) lines.push(COLUMNS.map((c) => csvCell(p[c])).join(','));
  return lines.join('\n') + '\n';
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const p = JSON.parse(line); if (p.id) items.set(p.id, p); } catch { /* سطر خربان */ }
    }
    if (items.size) console.log(`[catalog] ♻️  ${items.size} منتج`);
  } catch (e) { console.error('[catalog] فشل التحميل:', e.message); }
}

/* نكتب الملف كامل من جديد — عدنا آلاف مو ملايين، وهيچي ما يصير تكرار */
function persist() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, [...items.values()].map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

function upsert(list) {
  const accepted = [];
  const rejected = [];
  for (const raw of list) {
    const bad = validate(raw || {});
    if (bad.length) { rejected.push({ id: raw && raw.id, reasons: bad }); continue; }
    const p = normalize(raw);
    items.set(p.id, p);
    accepted.push(p.id);
  }
  if (accepted.length) persist();
  return { accepted, rejected };
}

function mount(app) {
  /* ميتا تسحب من هنا. المفتاح بالرابط حتى ما يكون الملف مكشوف للكل. */
  app.get('/feed.csv', (req, res) => {
    const key = process.env.FEED_KEY;
    if (key && req.query.k !== key) return res.status(401).type('text/plain').send('unauthorized');
    res.type('text/csv; charset=utf-8')
       .set('Content-Disposition', 'inline; filename="hassah-feed.csv"')
       .send('﻿' + toCsv());   // BOM حتى العربي يطلع صح
  });

  app.post('/products', (req, res) => {
    const auth = req.get('authorization') || '';
    if (process.env.INTERNAL_TOKEN && auth !== `Bearer ${process.env.INTERNAL_TOKEN}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const body = req.body;
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.products) ? body.products : null);
    if (!list) return res.status(400).json({ ok: false, error: 'ننتظر مصفوفة منتجات أو {products:[...]}' });
    if (body && body.replace === true) items.clear();
    const out = upsert(list);
    console.log(`[catalog] ⬆️  قبلنا ${out.accepted.length} · رفضنا ${out.rejected.length} · المجموع ${items.size}`);
    res.json({ ok: true, total: items.size, accepted: out.accepted.length,
               rejected: out.rejected.length, rejections: out.rejected.slice(0, 20) });
  });

  app.get('/products/stats', (_, res) => {
    const byAvail = {};
    for (const p of items.values()) byAvail[p.availability] = (byAvail[p.availability] || 0) + 1;
    res.json({ ok: true, total: items.size, byAvailability: byAvail,
               feed: `/feed.csv${process.env.FEED_KEY ? '?k=***' : ''}` });
  });
}

load();

module.exports = { mount, upsert, toCsv, validate, normalize, COLUMNS, count: () => items.size };
