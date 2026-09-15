process.env.D360_API_KEY = 'TEST';
const Module = require('module');
const out = [];
const origReq = Module.prototype.require;
Module.prototype.require = function (p) {
  if (p === './wa') return {
    sendText:    async (to, b) => out.push({ k: 'text',    b }),
    sendButtons: async (to, o) => out.push({ k: 'buttons', b: o.body, ids: o.buttons.map(x => x.id) }),
    sendList:    async (to, o) => out.push({ k: 'list',    b: o.body, ids: o.rows.map(x => x.id) }),
    markRead: async () => {}, sendOtp: async () => ({}),
  };
  if (p === './leads') return { save: async (l) => { out.push({ k: 'LEAD', lead: l }); return l; } };
  return origReq.apply(this, arguments);
};

const { handle, parseIncoming } = require('./server.js');

const txt  = (t)  => ({ type: 'text', text: { body: t } });
const btn  = (id) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });
const row  = (id) => ({ type: 'interactive', interactive: { type: 'list_reply',   list_reply:   { id, title: id } } });
const loc  = (lat, lng, name, address) => ({ type: 'location', location: { latitude: lat, longitude: lng, name, address } });

async function run(name, phone, steps) {
  out.length = 0;
  for (const m of steps) await handle(phone, parseIncoming(m));
  console.log(`\n━━━ ${name} ━━━`);
  out.forEach(o => {
    if (o.k === 'LEAD') console.log(`  💾 LEAD →`, JSON.stringify(o.lead));
    else console.log(`  [${o.k}]${o.ids ? ' ' + o.ids.join('|') : ''}  ${String(o.b).split('\n')[0].slice(0, 60)}`);
  });
  return out.slice();
}

(async () => {
  let r;
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fails++; };

  r = await run('متجر — مسار كامل مع لوكيشن', '9647801111111', [
    txt('السلام عليكم'), btn('MENU_STORE'), txt('سوبرماركت النور'),
    row('CAT_GROCERY'), btn('PH_SHOOT'), row('DAY_TMRW'), btn('TIME_PM'),
    loc(33.315, 44.366, 'سوبرماركت النور', 'الكرادة داخل'),
  ]);
  const lead = r.find(x => x.k === 'LEAD');
  ok(lead && lead.lead.type === 'store', 'انحفظ ليد متجر');
  ok(lead && lead.lead.storeName === 'سوبرماركت النور', 'اسم المتجر صحيح');
  ok(lead && lead.lead.categoryLabel === 'مواد غذائية', 'النوع صحيح');
  ok(lead && lead.lead.photoModeLabel === 'يريد تصوير', 'وضع الصور صحيح');
  ok(lead && lead.lead.mapUrl && lead.lead.mapUrl.includes('33.315'), 'اللوكيشن انحفظ');
  ok(lead && lead.lead.phone === '9647801111111', 'الرقم انحفظ');

  r = await run('متجر عنده صور — يتخطى موعد التصوير', '9647801111112', [
    txt('هلو'), btn('MENU_STORE'), txt('بوتيك الأناقة'),
    row('CAT_FASHION'), btn('PH_HAVE'),
    txt('المنصور - شارع الأميرات - مقابل مطعم السرايا'),
  ]);
  const ls = r.find(x => x.k === 'LEAD');
  ok(ls && ls.lead.photoModeLabel === 'عنده صور جاهزة', 'قبل المتجر الي عنده صور');
  ok(ls && !ls.lead.photoDayLabel, 'ما سأل عن موعد تصوير');
  ok(ls && ls.lead.locationText.includes('المنصور'), 'خزن العنوان المكتوب');

  r = await run('متجر — عنوان قصير يعيد السؤال', '9647801111113', [
    txt('هلو'), btn('MENU_STORE'), txt('محل الوفاء'),
    row('CAT_HOME'), btn('PH_HAVE'), txt('زيونة'),
  ]);
  ok(!r.some(x => x.k === 'LEAD'), 'ما قبل عنوان ناقص');
  ok(r[r.length - 1].b.includes('لوكيشن'), 'طلب الموقع مرة ثانية');

  r = await run('مندوب — مسار كامل', '9647802222222', [
    txt('هلو'), btn('MENU_COURIER'), txt('علي حسن محمد'),
    btn('BIKE_YES'), txt('زيونة'),
  ]);
  const l2 = r.find(x => x.k === 'LEAD');
  ok(l2 && l2.lead.type === 'courier', 'انحفظ ليد مندوب');
  ok(l2 && l2.lead.vehicleLabel === 'دراجة نارية', 'المركبة صحيحة');
  ok(l2 && l2.lead.status === 'ready', 'الحالة ready');

  r = await run('مندوب عنده سيارة', '9647802222223', [
    txt('هلو'), btn('MENU_COURIER'), txt('كرار عبد الله'),
    btn('CAR_YES'), txt('الكرخ'),
  ]);
  const l2c = r.find(x => x.k === 'LEAD');
  ok(l2c && l2c.lead.vehicleLabel === 'سيارة', 'قبل صاحب السيارة');
  ok(l2c && l2c.lead.status === 'ready', 'حالة صاحب السيارة ready');

  r = await run('مندوب بدون دراجة', '9647809999999', [
    txt('هلو'), btn('MENU_COURIER'), txt('حسن علي كريم'), btn('BIKE_NO'),
  ]);
  const l3 = r.find(x => x.k === 'LEAD');
  ok(l3 && l3.lead.status === 'no_bike', 'انحفظ بقائمة الانتظار');
  ok(r[r.length-1].b.includes('دراجة نارية'), 'رد برسالة الاعتذار');

  r = await run('زبون — سؤال شائع', '9647803333333', [
    txt('مرحبا'), btn('MENU_CUSTOMER'), btn('CUS_FAQ'), row('FAQ_FEE'),
  ]);
  ok(r.some(x => x.k === 'text' && x.b.includes('أجرة التوصيل')), 'جاوب على سؤال الأجور');
  ok(r.some(x => x.k === 'text' && x.b.includes('5,000')), 'ذكر سعر التوصيل 5,000');

  r = await run('كلمة "تطبيق" تسأل عن الجهاز', '9647804444441', [ txt('تطبيق') ]);
  ok(r.some(x => x.k === 'buttons' && x.ids.includes('DEV_IOS') && x.ids.includes('DEV_ANDROID')),
     'سأل آيفون لو أندرويد بدل ما يدز رابطين');

  r = await run('آيفون → رابط App Store', '9647804444451', [ txt('تطبيق'), btn('DEV_IOS') ]);
  ok(r.some(x => x.k === 'text' && x.b.includes('apps.apple.com/app/id6757367057')), 'أرسل رابط آيفون الصح');
  ok(!r.some(x => x.k === 'text' && x.b.includes('play.google.com')), 'ما أرسل رابط أندرويد');

  r = await run('أندرويد → رابط Google Play', '9647804444452', [ txt('تطبيق'), btn('DEV_ANDROID') ]);
  ok(r.some(x => x.k === 'text' && x.b.includes('id=app.technolanes.hassah')), 'أرسل رابط أندرويد الصح');
  ok(!r.some(x => x.k === 'text' && x.b.includes('قيد النشر')), 'ما گال «قيد النشر» — التطبيق منشور فعلاً');

  r = await run('المندوب يخلص → ينسأل عن جهازه', '9647804444453', [
    txt('هلو'), btn('MENU_COURIER'), txt('علي حسن'), btn('BIKE_YES'), txt('زيونة'), btn('DEV_IOS'),
  ]);
  ok(r.some(x => x.k === 'text' && x.b.includes('id6757434684')), 'أرسل تطبيق المندوب آيفون');


  r = await run('المندوب يشوف حصته', '9647804444442', [ txt('هلو'), btn('MENU_COURIER') ]);
  ok(r.some(x => x.k === 'text' && x.b.includes('2,000') && x.b.includes('3,000')), 'ذكر حصة المندوب');

  r = await run('المتجر يشوف التصوير المجاني', '9647804444443', [ txt('هلو'), btn('MENU_STORE') ]);
  ok(r.some(x => x.k === 'text' && x.b.includes('التصوير')), 'ذكر التصوير المجاني');

  r = await run('زبون — تتبع طلب', '9647804444444', [
    txt('هاي'), btn('MENU_CUSTOMER'), btn('CUS_ORDER'), txt('HSA-99231'),
  ]);
  ok(r.some(x => x.k === 'text' && x.b.includes('HSA-99231')), 'استلم رقم الطلب');

  r = await run('إدخال غلط ثم رجوع بـ 0', '9647805555555', [
    txt('اهلا'), txt('كلام ما اله معنى'), txt('0'),
  ]);
  ok(r.some(x => x.b === require('./flows').COMMON.fallback), 'رد بالرسالة الاحتياطية');
  ok(r[r.length - 1].k === 'buttons', 'الـ 0 رجّعه للقائمة');

  r = await run('اختيار غلط بالقائمة يعيد السؤال', '9647806666666', [
    txt('اهلا'), btn('MENU_STORE'), txt('متجر تجريبي'), txt('كلام بدل ما يختار'),
  ]);
  ok(r.filter(x => x.k === 'list').length === 2, 'أعاد عرض قائمة الأنواع');

  r = await run('محوّل لموظف — البوت يسكت', '9647807777777', [
    txt('اهلا'), btn('MENU_CUSTOMER'), btn('CUS_AGENT'), txt('عندي مشكلة بالطلب'),
  ]);
  const after = r.slice(r.findIndex(x => x.b && x.b.includes('تم تحويلك')) + 1);
  ok(after.filter(x => x.k !== 'LEAD').every(x => x.b && x.b.includes('برا الدوام')),
     'البوت ما تدخّل بعد التحويل');

  r = await run('زر الرجوع من الأسئلة الشائعة', '9647808888888', [
    txt('اهلا'), btn('MENU_CUSTOMER'), btn('CUS_FAQ'), row('FAQ_PAY'), btn('BACK_MENU'),
  ]);
  ok(r[r.length - 1].k === 'buttons' && r[r.length - 1].ids.includes('MENU_STORE'),
     'زر 🔙 القائمة يرجّع للقائمة الرئيسية');

  console.log(fails ? `\n❌ فشل ${fails} اختبار\n` : `\n✅ كل الاختبارات نجحت\n`);
  process.exit(fails ? 1 : 0);
})();
