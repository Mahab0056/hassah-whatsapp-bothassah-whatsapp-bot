/**
 * عقد المتاجر — نفس ملف العقد الأصلي حرفياً.
 * نولّد طبقة شفافة بيها الاسمين بس، ونلزقها فوق الصفحة الأصلية.
 * التصميم والكتابة والشعار ما تنلمس إطلاقاً.
 */

const fs   = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'assets', 'hassa-contract.pdf');
const FONT     = path.join(__dirname, 'assets', 'NotoNaskhArabic-Regular.ttf');
const STAMP    = path.join(__dirname, 'assets', 'stamp.png');
const SIGN     = path.join(__dirname, 'assets', 'signature.png');

const PAGE_W = 612, PAGE_H = 792;

/* مواقع الفراغين مستخرجة من الملف الأصلي نفسه */
const FIELDS = {
  store: { x: 317,   w: 111.3, baselineTop: 175.2 }, // المتجر الإلكتروني ______
  owner: { x: 182,   w: 105.8, baselineTop: 175.2 }, // يمثله: ______
  // سطر التاريخ فوق: يوم [يوم] / [شهر] / [سنة]  — القراءة من اليمين لليسار
  day:   { x: 482.9, w: 21.8,  baselineTop: 125.9 },
  month: { x: 451.0, w: 21.9,  baselineTop: 125.9 },
  year:  { x: 397.2, w: 43.5,  baselineTop: 125.9 },
};
const SIZE = 10;

/* توقيع المدير التنفيذي — فوق سطر «توقيع الطرف الأول» */
const SIGNATURE = {
  width: 108,        // عرضه بالنقاط، والارتفاع يتحسب من نسبة الصورة
  cx: 488,           // مركزه أفقياً
  cyTop: 673,        // مركزه عمودياً من أعلى الصفحة
  rotate: -2,
  opacity: 0.92,
};

/* ختم الشركة — فوق مكان توقيع الطرف الأول */
const SEAL = {
  size: 84,          // قطر الختم بالنقاط (≈3 سم)
  cx: 382,           // مركزه أفقياً
  cyTop: 688,        // مركزه عمودياً، مقاساً من أعلى الصفحة
  rotate: -6,        // ميلان بسيط حتى يبيّن طبيعي
  opacity: 0.88,     // حبر مو صلّب — النص تحته يبقى مقروء
};

/** تاريخ اليوم بتوقيت بغداد */
function today() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Baghdad', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
  return { day: g('day'), month: g('month'), year: g('year') };
}

/** سطر واحد، بلا محارف تحكّم، بطول معقول */
function clean(s, max = 60) {
  return String(s || '')
    .replace(/[\u0000-\u001F\u007F​-‏‪-‮]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** يبني طبقة PDF شفافة بيها الاسمين */
function buildOverlay(store, owner, { sealed = true } = {}) {
  return new Promise((resolve, reject) => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('ar', FONT);
    doc.fillColor('black');

    const put = (text, f) => {
      // ملاحظة: إحداثيات PDFKit من أعلى الصفحة، مو من أسفلها
      let size = SIZE;
      let t = text;
      doc.font('ar').fontSize(size);
      const wide = () => doc.widthOfString(t, { features: ['rtla'] }) > f.w;
      while (size > 6 && wide()) { size -= 0.25; doc.fontSize(size); }
      // لو ضل أطول من الفراغ حتى بأصغر خط، نقصّه بدل ما يطلع فوق النص الثاني
      while (t.length > 8 && wide()) t = t.slice(0, -1);
      if (t !== text) t = t.trim() + '…';
      doc.text(t, f.x, f.baselineTop - doc.currentLineHeight() * 0.80, {
        width: f.w, align: 'center', features: ['rtla'], lineBreak: false,
      });
    };

    put(store, FIELDS.store);
    put(owner, FIELDS.owner);

    if (sealed) {
      // النسخة النهائية تحمل تاريخ إرسالها
      const d = today();
      put(d.day,   FIELDS.day);
      put(d.month, FIELDS.month);
      put(d.year,  FIELDS.year);
    } else {
      // المسودة: علامة مائية مائلة حتى ما تنخلط بالنسخة النهائية
      const txt = 'مسودة عقد';
      const cx = PAGE_W / 2, cy = PAGE_H / 2;
      doc.save();
      doc.font('ar').fontSize(84).fillColor('#c0392b').opacity(0.20);
      doc.rotate(-32, { origin: [cx, cy] });
      doc.text(txt, 0, cy - doc.currentLineHeight() / 2, {
        width: PAGE_W, align: 'center', features: ['rtla'], lineBreak: false,
      });
      doc.restore();
      doc.opacity(1).fillColor('black');
    }

    doc.end();
  });
}

/**
 * يرجّع ملف العقد الأصلي وفوقه اسم المتجر واسم ممثّله.
 * @param {{store:string, owner:string, seal?:boolean}} data
 * @returns {Promise<Buffer>}
 */
async function fillContract({ store, owner, seal = true }) {
  const s = clean(store);
  const o = clean(owner);
  if (!s) throw new Error('اسم المتجر مطلوب');
  if (!o) throw new Error('اسم ممثّل المتجر مطلوب');

  const { PDFDocument, degrees } = require('pdf-lib');

  const overlayBytes = await buildOverlay(s, o, { sealed: seal !== false });
  const base    = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const overlay = await PDFDocument.load(overlayBytes);

  const [ovPage] = await base.embedPdf(overlay, [0]);
  const page = base.getPages()[0];
  page.drawPage(ovPage, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });

  if (seal !== false) {
    // pdf-lib يدوّر حول نقطة الرسم، فنحسب الزاوية السفلى حتى يطلع المركز بمكانه
    const stick = async (file, cx, cyTop, w, h, rotate, opacity) => {
      const img = await base.embedPng(fs.readFileSync(file));
      const th = (rotate * Math.PI) / 180;
      const hw = w / 2, hh = h / 2;
      page.drawImage(img, {
        x: cx - (hw * Math.cos(th) - hh * Math.sin(th)),
        y: (PAGE_H - cyTop) - (hw * Math.sin(th) + hh * Math.cos(th)),
        width: w, height: h, rotate: degrees(rotate), opacity,
      });
    };

    // التوقيع أول، والختم فوقه — مثل ما تنوقّع العقود بالواقع
    if (fs.existsSync(SIGN)) {
      const sg = await base.embedPng(fs.readFileSync(SIGN));
      const { width, cx, cyTop, rotate, opacity } = SIGNATURE;
      const h = (width * sg.height) / sg.width;
      await stick(SIGN, cx, cyTop, width, h, rotate, opacity);
    }
    if (fs.existsSync(STAMP)) {
      const { size, cx, cyTop, rotate, opacity } = SEAL;
      await stick(STAMP, cx, cyTop, size, size, rotate, opacity);
    }
  }

  return Buffer.from(await base.save());
}

/** اسم الملف المرسل للمتجر — يفرّق المسودة عن النسخة المختومة */
function fileName(store, sealed = true) {
  const safe = clean(store, 40).replace(/[\\/:*?"<>|]/g, '').trim() || 'متجر';
  return `${sealed ? 'عقد خدمات' : 'مسودة عقد'} - ${safe}.pdf`;
}

module.exports = { fillContract, fileName, clean };
