/**
 * طبقة الذكاء — تخلي البوت يفهم الكلام الحر ويرد مثل موظف حقيقي
 *
 * الفكرة: السيناريوهات (الأزرار) تبقى هي الي تجمع البيانات — لأنها دقيقة.
 * بس أي شي يكتبه الزبون برّا السيناريو، بدل "ما فهمت قصدك"، يروح لهنا.
 *
 * إذا ما كو ANTHROPIC_API_KEY، الدالة ترجع null والبوت يشتغل بسلوكه القديم.
 */

const F = require('./flows');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = process.env.AI_MODEL || 'claude-sonnet-4-5';
const ENABLED = !!API_KEY;

if (!ENABLED) {
  console.warn('[ai] ⚠️  ANTHROPIC_API_KEY مو مضبوط — البوت راح يرد بالردود الثابتة بس.');
}

/* ================================================================
   المعرفة — كلها مسحوبة من flows.js حتى ما تنفصل عن ردود البوت
   ================================================================ */
const KNOWLEDGE = `
# هسة (Hassah)
منصة تسوّق وتوصيل ببغداد. الزبون يطلب من التطبيق ويوصله لباب البيت.
أكثر من 200 متجر وأكثر من 8,000 منتج.

## للزبون
- التوصيل: داخل بغداد — الرصافة والكرخ وأغلب المناطق. من 60 لـ120 دقيقة حسب المنطقة والزحام.
- أجرة التوصيل: ${F.PRICING?.deliveryFee || '5,000'} دينار، سعر ثابت يظهر قبل تأكيد الطلب. ماكو رسوم مخفية.
- الدفع: نقداً عند الاستلام، أو بطاقة (ماستر/فيزا)، أو محافظ إلكترونية.
- الإرجاع: إذا وصل منتج غلط أو فيه عيب — يراسلنا خلال 24 ساعة وإحنا نتكفّل.
  المواد الغذائية والمنتجات الشخصية ما تنرجع لأسباب صحية.
- الطلب: نزّل التطبيق → سجّل برقمك → اختار المتجر أو دوّر على المنتج → ضيفه للسلة → أكّد.
- منطقة مو مغطاة؟ ناخذ اسمها ونسجّلها بقائمة التوسّع.

## للمندوب (سواق التوصيل)
- الشرط الوحيد: عنده دراجة نارية أو سيارة.
- الأجر: من ${F.PRICING?.courierMin || '2,000'} لـ ${F.PRICING?.courierMax || '3,000'} دينار على كل توصيلة.
- دوام مرن — يشتغل بالوقت الي يناسبه.
- الطلبات توصله بالتطبيق مباشرة، ويختار المنطقة الي تناسبه.
- ماكو راتب ثابت — المحاسبة على كل توصيلة.

## للمتجر
- نوقّع اتفاقية لفترة محددة، وخلالها: التصوير مجاناً، والترويج، والتوصيل — كلها علينا.
- البضاعة تبقى بالمتجر، ما ننقلها لمخزن.
- عليه بس: بضاعته.

## الدوام
9 صباحاً – 10 مساءً، كل أيام الأسبوع.
`.trim();

/* ================================================================
   التعليمات — نبرة موظف عراقي حقيقي، مو روبوت
   ================================================================ */
const SYSTEM = `
إنت تشتغل بخدمة زبائن *هسة* — منصة تسوّق وتوصيل ببغداد. تردّ على واتساب.

## شلون تحچي
- باللهجة العراقية البغدادية الطبيعية. مو فصحى، ومو ترجمة.
- قصير: سطر لسطرين. هذا واتساب مو إيميل.
- دافي وبسيط، مثل موظف يعرف شغله ومستعجل يساعد.
- إيموجي وحدة بأكثر تقدير، وبس إذا تخدم المعنى. أغلب الردود بدون إيموجي.
- لا تكرر التحية بكل رسالة. حيّي بس أول مرة.
- لا تستعمل عبارات روبوتية: "شكراً لتواصلك معنا"، "نحن سعداء بخدمتك"، "يرجى الانتظار".
- لا تستعمل قوائم مرقّمة إلا إذا الزبون طلب خطوات فعلاً.

## شنو تعرف
استعمل المعرفة المنطية بس. **لا تخترع** أسعار ولا مواعيد ولا سياسات ولا أسماء متاجر.
إذا السؤال يحتاج معلومة ما عندك (حالة طلب معيّن، سعر منتج، شكوى، استثناء) — حوّله لموظف.

## شنو ترجّع
رجّع JSON بس، بدون أي نص قبله أو بعده:
{"reply": "ردّك", "action": "answer"}

قيم action:
- "answer" — جاوبت وخلصت
- "menu"   — الزبون ضايع أو يريد يرجع للبداية
- "courier"— يريد يشتغل مندوب/سواق توصيل
- "store"  — عنده متجر ويريد يشترك
- "agent"  — يحتاج موظف بشري (شكوى، حالة طلب، سعر منتج، شي ما تعرفه، أو طلب صراحة)

## قواعد مهمة
- إذا حوّلت لموظف (agent)، خلي الرد قصير يطمّنه إن أحد راح يرد، بدون ما توعد بوقت محدد.
- إذا سألك مباشرة "إنت بوت؟" — كون صادق وخفيف: إنك مساعد آلي من فريق هسة وتگدر تحوّله لموظف بأي لحظة. لا تدّعي إنك إنسان.
- لا تطلب معلومات شخصية حساسة (رقم بطاقة، كلمة مرور).
- إذا الزبون يحچي بالإنكليزي، رد بالإنكليزي.

## المعرفة
${KNOWLEDGE}
`.trim();

/* ================================================================
   الاستدعاء
   ================================================================ */

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} history آخر الرسائل
 * @param {string} situation وصف مختصر لوين الزبون بالسيناريو
 * @returns {Promise<{reply:string, action:string}|null>}
 */
async function think(history, situation = '') {
  if (!ENABLED) return null;

  const messages = history
    .filter((m) => m.content && m.content.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));

  if (!messages.length) return null;
  if (messages[0].role !== 'user') messages.shift();
  if (!messages.length) return null;

  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0.7,
        // نخلي التعليمات الثابتة بالكاش — أرخص وأسرع
        system: [
          { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
          ...(situation ? [{ type: 'text', text: `## وين الزبون هسة\n${situation}` }] : []),
        ],
        messages,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[ai] فشل النداء', res.status, body.slice(0, 300));
      return null;
    }

    const json = await res.json();
    const raw = (json.content || []).map((c) => c.text || '').join('').trim();
    const out = parse(raw);
    const u = json.usage || {};
    console.log(`[ai] ${out ? out.action : 'parse-fail'} · ${Date.now() - t0}ms · in ${u.input_tokens || 0} (cache ${u.cache_read_input_tokens || 0}) out ${u.output_tokens || 0}`);
    return out;
  } catch (e) {
    console.error('[ai] خطأ:', e.message);
    return null;
  }
}

/* يلقط الـJSON حتى لو النموذج لفّه بنص أو ```json */
function parse(raw) {
  if (!raw) return null;
  let t = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);

  try {
    const o = JSON.parse(t);
    const reply = String(o.reply || '').trim();
    if (!reply) return null;
    const ok = ['answer', 'menu', 'courier', 'store', 'agent'];
    return { reply: reply.slice(0, 900), action: ok.includes(o.action) ? o.action : 'answer' };
  } catch {
    // النموذج رد نص عادي بدل JSON — نقبله كجواب
    const clean = raw.trim();
    return clean ? { reply: clean.slice(0, 900), action: 'answer' } : null;
  }
}

/* ================================================================
   هل هذا سؤال؟ — نستعملها وسط السيناريوهات
   حتى ما نسجّل "شكد الراتب؟" كاسم المندوب
   ================================================================ */
const QUESTION_WORDS = [
  'شنو', 'شلون', 'شكد', 'شگد', 'وين', 'ليش', 'متى', 'منو', 'هل', 'اكو', 'أكو',
  'ممكن', 'تگدر', 'تكدر', 'عندكم', 'عدكم', 'كم', 'ايش', 'كيف', 'مو',
  'what', 'how', 'where', 'why', 'when', 'who', 'can', 'do you',
];

function looksLikeQuestion(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  if (t.includes('؟') || t.includes('?')) return true;
  return QUESTION_WORDS.some((w) => t === w || t.startsWith(w + ' ') || t.includes(' ' + w + ' '));
}

module.exports = { think, looksLikeQuestion, enabled: ENABLED };
