/**
 * صندوق الوارد — إنبوكس هسة
 * ------------------------------------------------------------------
 *   GET  /inbox?key=...                    ← الصفحة
 *   GET  /inbox/api/threads?key=...        ← المحادثات + الإحصائيات
 *   GET  /inbox/api/thread?key=..&phone=   ← محادثة وحدة
 *   POST /inbox/api/send                   ← رد الموظف
 *   POST /inbox/api/bot                    ← تشغيل/إيقاف البوت
 *   POST /inbox/api/status                 ← جديد / قيد المعالجة / تم
 *   POST /inbox/api/note                   ← ملاحظة على رسالة
 *
 * التخزين: الذاكرة + ملف inbox.jsonl على القرص الدائم.
 * ⚠️ ما ننحذف أي رسالة — أبداً. الملف append-only.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'inbox.jsonl');

/** phone → thread */
const threads = new Map();

const STATUSES = ['new', 'open', 'done'];

function thread(phone) {
  let t = threads.get(phone);
  if (!t) {
    t = {
      phone, name: '', messages: [], lastAt: 0, step: '',
      unread: 0, botPaused: false, status: 'new',
    };
    threads.set(phone, t);
  }
  return t;
}

function appendFile(rec) {
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8'); } catch { /* لا يهم */ }
}

/* ═══════════════ تشغيل السجل من القرص ═══════════════ */

function applyRecord(r) {
  if (!r || !r.phone) return false;
  const t = thread(r.phone);

  if (r.t === 'note') {
    const m = t.messages.find((x) => x.id === r.mid);
    if (m) (m.notes = m.notes || []).push({ text: r.text, at: r.at, by: r.by || 'agent' });
    return true;
  }
  if (r.t === 'status') {
    if (STATUSES.includes(r.value)) t.status = r.value;
    return true;
  }
  if (r.t === 'name') { t.name = r.name || t.name; return true; }

  if (!r.dir) return false;
  if (!r.id) r.id = `${r.at}-${t.messages.length}`;   // معرّف ثابت للسجلات القديمة
  if (!r.notes) r.notes = [];
  t.messages.push(r);
  if (r.at > t.lastAt) t.lastAt = r.at;
  return true;
}

function loadFromDisk() {
  let n = 0;
  try {
    if (!fs.existsSync(FILE)) return;
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (applyRecord(r)) n++;
    }
    for (const t of threads.values()) { t.messages.sort((a, b) => a.at - b.at); recomputeUnread(t); }
    console.log(`[inbox] ♻️  استرجعنا ${n} سجل من ${threads.size} محادثة`);
  } catch (e) {
    console.error('[inbox] فشل الاسترجاع:', e.message);
  }
}

/* الرسايل الي ضاعت قبل ما نركّب القرص الدائم — تنستورد مرة وحدة */
function importRecovered() {
  const marker = path.join(DATA_DIR, '.recovered');
  const src = path.join(__dirname, 'recovered.jsonl');
  try {
    if (!fs.existsSync(src) || fs.existsSync(marker)) return;
    let n = 0;
    for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r.phone || !r.dir) continue;
      const t = thread(r.phone);
      if (t.messages.some((m) => m.at === r.at && m.text === r.text)) continue;
      applyRecord(r);
      appendFile(r);
      n++;
    }
    for (const t of threads.values()) { t.messages.sort((a, b) => a.at - b.at); recomputeUnread(t); }
    fs.writeFileSync(marker, new Date().toISOString());
    console.log(`[inbox] 🧾 رجّعنا ${n} رسالة قديمة من سجلات السيرفر`);
  } catch (e) {
    console.error('[inbox] فشل استرجاع القديم:', e.message);
  }
}

/* ═══════════════ الكتابة ═══════════════ */

let seq = 0;
const newId = () => `${Date.now().toString(36)}${(seq = (seq + 1) % 4096).toString(36)}`;

/** @param {'in'|'out'} dir */
function record(phone, dir, text, meta = {}) {
  const t = thread(phone);
  const rec = {
    id: newId(),
    phone, dir,
    text: String(text || '').slice(0, 4000),
    at: Date.now(),
    by: meta.by || (dir === 'in' ? 'customer' : 'bot'),
    st: meta.step || '',
    notes: [],
  };
  t.messages.push(rec);
  t.lastAt = rec.at;
  if (meta.step) t.step = meta.step;
  if (meta.name && meta.name !== t.name) {
    t.name = meta.name;
    appendFile({ t: 'name', phone, name: t.name, at: rec.at });
  }
  if (dir === 'in') {
    t.unread += 1;
    if (t.status === 'done') setStatus(phone, 'open');   // رجع يحچي → ترجع للمعالجة
  }
  appendFile(rec);
  return rec;
}

function setStatus(phone, status, by = 'agent') {
  if (!STATUSES.includes(status)) return null;
  const t = thread(phone);
  if (t.status === status) return t.status;
  t.status = status;
  appendFile({ t: 'status', phone, value: status, at: Date.now(), by });
  return status;
}

function addNote(phone, mid, text, by = 'agent') {
  const t = threads.get(phone);
  if (!t) return null;
  const m = t.messages.find((x) => x.id === mid);
  if (!m) return null;
  const note = { text: String(text).slice(0, 1000), at: Date.now(), by };
  (m.notes = m.notes || []).push(note);
  appendFile({ t: 'note', phone, mid, text: note.text, at: note.at, by });
  return note;
}

const setStep     = (phone, step) => { thread(phone).step = step; };
const markSeen    = (phone) => { thread(phone).unread = 0; };
const isBotPaused = (phone) => !!threads.get(phone)?.botPaused;
const setBotPaused = (phone, v) => { thread(phone).botPaused = !!v; };

/* ═══════════════ التصنيف ═══════════════ */

function kindOf(t) {
  let k = 'unknown';
  for (const m of t.messages) {
    const st = m.st || '';
    const x = String(m.text || '');
    if (st.startsWith('STORE') || x === 'MENU_STORE' || x.startsWith('CAT_') ||
        x.startsWith('DAY_') || x.startsWith('TIME_') || x.startsWith('PH_') ||
        x.includes('عندي متجر')) k = 'store';
    else if (st.startsWith('COURIER') || x === 'MENU_COURIER' || x === 'BIKE_YES' ||
             x === 'CAR_YES' || x === 'BIKE_NO' || x.includes('أشتغل مندوب')) k = 'courier';
    else if (st.startsWith('CUSTOMER') || x === 'MENU_CUSTOMER' || x.startsWith('CUS_') ||
             x.startsWith('FAQ_') || x.includes('عندي طلب')) k = 'customer';
  }
  if (k === 'unknown') {
    const st = t.step || '';
    if (st.startsWith('STORE')) k = 'store';
    else if (st.startsWith('COURIER')) k = 'courier';
    else if (st.startsWith('CUSTOMER') || st === 'AGENT') k = 'customer';
  }
  return k;
}

/* ═══════════════ الإحصائيات ═══════════════ */

/** لكل رسالة واردة: شكد استغرق الرد عليها — نفصل رد الموظف عن رد البوت */
function replyDeltas(t) {
  const agent = [], bot = [];
  let pendingAgent = null;   // أقدم واردة ما ردّ عليها موظف
  let pendingBot = null;     // آخر واردة ما ردّ عليها البوت
  for (const m of t.messages) {
    if (m.dir === 'in') {
      if (pendingAgent === null) pendingAgent = m.at;
      pendingBot = m.at;
      continue;
    }
    if (m.by === 'agent') {
      if (pendingAgent !== null) {
        const d = m.at - pendingAgent;
        if (d >= 0 && d < 7 * 24 * 3600e3) agent.push(d);
        pendingAgent = null;
      }
      pendingBot = null;
    } else if (pendingBot !== null) {
      const d = m.at - pendingBot;
      if (d >= 0 && d < 3600e3) bot.push(d);
      pendingBot = null;
    }
  }
  // "ينتظر رد" = آخر رسالة بالمحادثة واردة، يعني ماكو أي رد بعدها
  const last = t.messages[t.messages.length - 1];
  const stillWaiting = last && last.dir === 'in' ? last.at : null;
  return { agent, bot, stillWaiting };
}

/** غير المقروء = الرسايل الواردة الي بعد آخر رد صادر */
function recomputeUnread(t) {
  let n = 0;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    if (t.messages[i].dir !== 'in') break;
    n++;
  }
  t.unread = n;
}

function stats() {
  const all = [...threads.values()];
  const agentAll = [], botAll = [];
  let waiting = 0, longestWait = 0, unread = 0;
  const byStatus = { new: 0, open: 0, done: 0 };
  const now = Date.now();

  for (const t of all) {
    const { agent, bot, stillWaiting } = replyDeltas(t);
    agentAll.push(...agent);
    botAll.push(...bot);
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    unread += t.unread;
    if (stillWaiting !== null && t.status !== 'done') {
      waiting++;
      longestWait = Math.max(longestWait, now - stillWaiting);
    }
  }
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  return {
    total: all.length,
    ...byStatus,
    unread,
    waiting,
    longestWaitMs: longestWait,
    agentAvgMs: avg(agentAll),
    agentCount: agentAll.length,
    botAvgMs: avg(botAll),
  };
}

function list() {
  const now = Date.now();
  return [...threads.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      const { stillWaiting } = replyDeltas(t);
      const notes = t.messages.reduce((n, m) => n + (m.notes ? m.notes.length : 0), 0);
      return {
        phone: t.phone,
        name: t.name,
        kind: kindOf(t),
        status: t.status,
        step: t.step,
        unread: t.unread,
        notes,
        botPaused: t.botPaused,
        lastAt: t.lastAt,
        waitMs: stillWaiting !== null && t.status !== 'done' ? now - stillWaiting : 0,
        last: last ? last.text.slice(0, 90) : '',
        lastDir: last ? last.dir : '',
      };
    });
}

const get = (phone) => threads.get(phone) || null;

/* ═══════════════════════════ الصفحة ═══════════════════════════ */

const PAGE = `<!doctype html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>إنبوكس هسة</title>
<style>
:root{
  --bg:#0b0e14; --panel:#11151d; --panel2:#161b26; --line:#232a38;
  --txt:#e9edf3; --dim:#8d97a8; --me:#1f7a54; --them:#1e2432;
  --acc:#6d5efc; --acc2:#00c2a8; --warn:#f0a132; --bad:#ef5361;
  --new:#4da3ff; --open:#f0a132; --done:#3ddc84;
}
*{box-sizing:border-box}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:#2a3244;border-radius:8px}
body{margin:0;font:15px/1.55 -apple-system,"Segoe UI",Roboto,"Noto Naskh Arabic",sans-serif;
  background:var(--bg);color:var(--txt);height:100dvh;display:flex;flex-direction:column;overflow:hidden}

header{background:linear-gradient(135deg,#171a2e,#101522);border-bottom:1px solid var(--line);
  padding:10px 16px;display:flex;align-items:center;gap:14px;flex:0 0 auto;flex-wrap:wrap}
header h1{margin:0;font-size:16px;font-weight:700;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.pulse{width:9px;height:9px;border-radius:50%;background:#3ddc84;box-shadow:0 0 0 0 rgba(61,220,132,.6);animation:p 2.2s infinite}
@keyframes p{70%{box-shadow:0 0 0 9px rgba(61,220,132,0)}100%{box-shadow:0 0 0 0 rgba(61,220,132,0)}}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-inline-start:auto;align-items:center}
.stat{background:#1a2030;border:1px solid var(--line);border-radius:10px;padding:5px 11px;
  display:flex;flex-direction:column;line-height:1.25;min-width:74px}
.stat b{font-size:15px;font-weight:700}
.stat span{font-size:10px;color:var(--dim)}
.stat.good b{color:var(--done)} .stat.warn b{color:var(--warn)} .stat.bad b{color:var(--bad)}

main{flex:1;display:flex;min-height:0}
#listwrap{width:370px;border-left:1px solid var(--line);display:flex;flex-direction:column;
  min-height:0;flex:0 0 auto;background:var(--panel)}
#search{margin:10px 10px 6px;background:var(--panel2);border:1px solid var(--line);color:var(--txt);
  border-radius:10px;padding:9px 13px;font:inherit;font-size:14px}
#search:focus{outline:none;border-color:var(--acc)}
.tabs{display:flex;gap:6px;padding:0 10px 8px;overflow-x:auto;flex:0 0 auto}
.tabs::-webkit-scrollbar{display:none}
.tabs button{background:#1a2030;color:#b6bfcf;border:1px solid var(--line);border-radius:20px;
  padding:5px 12px;font:inherit;font-size:12.5px;font-weight:600;white-space:nowrap;cursor:pointer;transition:.15s}
.tabs button:hover{border-color:#3a4459}
.tabs button.on{background:var(--acc);border-color:var(--acc);color:#fff}
.tabs.st button.on{background:var(--acc2);border-color:var(--acc2);color:#04231e}
#list{overflow-y:auto;flex:1;min-height:0}

.row{padding:11px 13px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:11px;transition:.12s}
.row:hover{background:#151a25}
.row.sel{background:#1a2133;box-shadow:inset 3px 0 0 var(--acc)}
.av{width:38px;height:38px;border-radius:12px;flex:0 0 auto;display:grid;place-items:center;
  font-size:17px;background:#222a3a}
.av.store{background:#3a2d12}.av.courier{background:#10303a}.av.customer{background:#14311f}
.rmain{flex:1;min-width:0}
.rtop{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.rname{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rphone{direction:ltr;unicode-bidi:embed;font-size:11.5px;color:var(--dim)}
.rw{font-size:11px;color:var(--dim);white-space:nowrap;display:flex;align-items:center;gap:5px}
.rlast{color:var(--dim);font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;align-items:center}
.chip{border-radius:5px;padding:1px 7px;font-size:10.5px;font-weight:600}
.c-store{background:#3a2d12;color:#f0c674}.c-courier{background:#10303a;color:#7ad7f0}
.c-customer{background:#14311f;color:#7fe0a0}.c-unknown{background:#252b38;color:#9aa0aa}
.s-new{background:#12304d;color:#7cc0ff}.s-open{background:#3b2c10;color:#f5bd63}.s-done{background:#123020;color:#6ee7a0}
.badge{background:#3ddc84;color:#04150c;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:800}
.wait{color:var(--warn);font-weight:700}.wait.bad{color:var(--bad)}
.note-c{background:#2a2f3d;color:#c6b2ff;border-radius:5px;padding:1px 6px;font-size:10.5px}

#chat{flex:1;display:flex;flex-direction:column;min-width:0;background:
  radial-gradient(1200px 600px at 80% -10%,#141a28 0,var(--bg) 60%)}
#head{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;
  align-items:center;gap:10px;flex:0 0 auto;flex-wrap:wrap;background:var(--panel)}
#head .who{display:flex;align-items:center;gap:10px;min-width:0}
#head .p{font-weight:700;direction:ltr;unicode-bidi:embed;font-size:14px}
#head .sub{font-size:11.5px;color:var(--dim)}
.acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
button.ghost{background:#222a3a;color:#c9cfd8;padding:6px 11px;font-size:12.5px;border-radius:8px;
  border:1px solid var(--line);font-weight:600;cursor:pointer;transition:.15s}
button.ghost:hover{border-color:#3a4459;color:#fff}
button.ghost.on{background:var(--acc2);color:#04231e;border-color:var(--acc2)}
.sep{width:1px;height:22px;background:var(--line);margin:0 4px;display:inline-block}
button.ghost.tiny{padding:5px 9px;font-size:14px;line-height:1;opacity:.5;background:transparent}
button.ghost.tiny:hover{opacity:1}
button.ghost.tiny.on{opacity:1;background:#4a2020;border-color:#7a3030;color:#ff9a9a}
button{background:var(--me);color:#fff;border:0;border-radius:20px;padding:10px 18px;font:inherit;
  font-weight:600;cursor:pointer}
#msgs{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px}
.mwrap{display:flex;flex-direction:column;max-width:78%}
.mwrap.in{align-self:flex-start}.mwrap.out{align-self:flex-end;align-items:flex-end}
.m{padding:9px 13px;border-radius:14px;white-space:pre-wrap;word-break:break-word;font-size:14px;position:relative}
.m.in{background:var(--them);border-bottom-right-radius:5px}
.m.out{background:var(--me);border-bottom-left-radius:5px}
.m .w{display:block;font-size:10px;color:#cfd6e0;opacity:.65;margin-top:5px}
.nbtn{background:none;border:0;color:#6b7487;font-size:11px;padding:3px 4px;cursor:pointer;
  opacity:.5;transition:.15s;align-self:flex-start}
.mwrap:hover .nbtn{opacity:1}
.nbtn:hover{color:var(--acc)}
.note{background:#241f3d;border-inline-start:3px solid #7c6cff;border-radius:8px;padding:6px 10px;
  font-size:12.5px;color:#d6cdff;margin-top:5px;max-width:100%}
.note b{color:#a898ff;font-size:11px}
.nform{display:flex;gap:6px;margin-top:6px;width:100%}
.nform input{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--txt);
  border-radius:8px;padding:6px 10px;font:inherit;font-size:13px}
.nform button{border-radius:8px;padding:6px 12px;font-size:12.5px}
#compose{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line);flex:0 0 auto;background:var(--panel)}
#compose input{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--txt);
  border-radius:22px;padding:11px 17px;font:inherit}
#compose input:focus{outline:none;border-color:var(--acc)}
.empty{margin:auto;color:var(--dim);text-align:center;padding:40px;font-size:14px}
.note-bar{font-size:12px;color:var(--dim);padding:0 14px 9px}
.note-bar.warn{color:var(--warn)}
@media(max-width:820px){
  #listwrap{width:100%}#listwrap.hide{display:none}#chat.hide{display:none}
  .stats{width:100%;margin-inline-start:0;justify-content:flex-start}
  .mwrap{max-width:92%}
}
</style></head><body>
<header>
  <h1><span class="pulse"></span> إنبوكس هسة</h1>
  <div class="stats" id="stats"></div>
  <button id="bell" class="ghost" title="تنبيه صوتي" style="padding:5px 10px;font-size:15px">🔔</button>
</header>
<main>
  <div id="listwrap">
    <input id="search" placeholder="دوّر برقم، اسم، أو نص رسالة..." autocomplete="off">
    <div class="tabs" id="fKind">
      <button data-f="all" class="on">الكل</button>
      <button data-f="courier">🛵 مندوبين</button>
      <button data-f="store">🏪 متاجر</button>
      <button data-f="customer">🛒 زبائن</button>
    </div>
    <div class="tabs st" id="fStatus">
      <button data-s="all" class="on">كل الحالات</button>
      <button data-s="new">🔵 جديد</button>
      <button data-s="open">🟠 قيد المعالجة</button>
      <button data-s="done">🟢 تم</button>
      <button data-s="unread">🔴 غير مقروء</button>
    </div>
    <div id="list"></div>
  </div>
  <div id="chat" class="hide">
    <div id="head">
      <div class="who">
        <span class="av" id="hav">💬</span>
        <div><div class="p" id="hp">—</div><div class="sub" id="hsub"></div></div>
      </div>
      <div class="acts">
        <button class="ghost" data-set="new">جديد</button>
        <button class="ghost" data-set="open">قيد المعالجة</button>
        <button class="ghost" data-set="done">تم</button>
        <span class="sep"></span>
        <button class="ghost" id="btnBack">رجوع</button>
        <button class="ghost tiny" id="btnBot" title="إيقاف البوت لهذه المحادثة">🤖</button>
      </div>
    </div>
    <div id="msgs"><div class="empty">اختار محادثة من القائمة</div></div>
    <div class="note-bar" id="note"></div>
    <div id="compose"><input id="txt" placeholder="اكتب ردك..." autocomplete="off"><button id="send">إرسال</button></div>
  </div>
</main>
<script>
const KEY=new URLSearchParams(location.search).get('key')||'';
let cur=null,curData=null,allThreads=[],st={},fKind='all',fStatus='all',q='';
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=t=>{const s=(Date.now()-t)/1000;if(s<60)return'الآن';if(s<3600)return Math.floor(s/60)+' د';
  if(s<86400)return Math.floor(s/3600)+' س';return Math.floor(s/86400)+' يوم';};
const dur=ms=>{if(ms==null)return'—';const s=Math.round(ms/1000);
  if(s<60)return s+' ث';if(s<3600)return Math.round(s/60)+' د';
  if(s<86400)return (s/3600).toFixed(1)+' س';return Math.round(s/86400)+' يوم';};

const KINDS={store:{i:'🏪',t:'متجر'},courier:{i:'🛵',t:'مندوب'},customer:{i:'🛒',t:'زبون'},unknown:{i:'💬',t:'غير مصنّف'}};
const ST={new:{t:'جديد'},open:{t:'قيد المعالجة'},done:{t:'تم'}};
const STEPS={STORE_NAME:'تسجيل متجر',STORE_CATEGORY:'تسجيل متجر',STORE_PHOTOS:'اختيار الصور',
  STORE_PHOTO_DAY:'موعد تصوير',STORE_PHOTO_TIME:'موعد تصوير',STORE_LOCATION:'ينتظر الموقع',
  COURIER_NAME:'تسجيل مندوب',COURIER_BIKE:'تسجيل مندوب',COURIER_AREA:'تسجيل مندوب',
  CUSTOMER_MENU:'زبون',CUSTOMER_ORDER_NO:'يتابع طلب',CUSTOMER_FAQ:'أسئلة',AGENT:'ينتظر موظف',MENU:'القائمة'};

document.querySelectorAll('#fKind button').forEach(b=>b.onclick=()=>{
  fKind=b.dataset.f;document.querySelectorAll('#fKind button').forEach(x=>x.classList.toggle('on',x===b));render();});
document.querySelectorAll('#fStatus button').forEach(b=>b.onclick=()=>{
  fStatus=b.dataset.s;document.querySelectorAll('#fStatus button').forEach(x=>x.classList.toggle('on',x===b));render();});
$('search').oninput=e=>{q=e.target.value.trim().toLowerCase();render();};

const pass=t=>{
  if(fKind!=='all'&&t.kind!==fKind)return false;
  if(fStatus==='unread'){if(!t.unread)return false;}
  else if(fStatus!=='all'&&t.status!==fStatus)return false;
  if(q&&!((t.phone+' '+(t.name||'')+' '+(t.last||'')).toLowerCase().includes(q)))return false;
  return true;
};

async function loadList(){
  const r=await fetch('/inbox/api/threads?key='+encodeURIComponent(KEY));
  if(!r.ok){$('list').innerHTML='<div class="empty">مفتاح غير صحيح</div>';return;}
  const d=await r.json();
  allThreads=d.threads;st=d.stats||{};
  onCounts(st.unread||0);
  renderStats();render();
}

function renderStats(){
  const slow=st.agentAvgMs!=null&&st.agentAvgMs>15*60000;
  const lw=st.longestWaitMs>30*60000;
  $('stats').innerHTML=
    tile(st.total||0,'محادثة')+
    tile(st.new||0,'جديد')+
    tile(st.open||0,'قيد المعالجة')+
    tile(st.done||0,'تم','good')+
    tile(dur(st.agentAvgMs),'متوسط رد الموظف',slow?'bad':'good')+
    tile(dur(st.botAvgMs),'متوسط رد البوت')+
    tile(st.waiting||0,'ينتظرون رد',st.waiting?'warn':'')+
    tile(st.longestWaitMs?dur(st.longestWaitMs):'—','أطول انتظار',lw?'bad':'');
}
const tile=(v,l,c)=>'<div class="stat '+(c||'')+'"><b>'+v+'</b><span>'+l+'</span></div>';

function render(){
  const c={all:allThreads.length,unread:0,store:0,courier:0,customer:0,new:0,open:0,done:0};
  allThreads.forEach(t=>{if(t.unread)c.unread++;if(c[t.kind]!==undefined)c[t.kind]++;if(c[t.status]!==undefined)c[t.status]++;});
  document.querySelectorAll('#fKind button').forEach(b=>{
    const base=b.dataset.base||(b.dataset.base=b.textContent);b.textContent=base+' '+(c[b.dataset.f]||0);});
  document.querySelectorAll('#fStatus button').forEach(b=>{
    const base=b.dataset.base||(b.dataset.base=b.textContent);
    b.textContent=base+' '+(b.dataset.s==='all'?c.all:(c[b.dataset.s]||0));});

  const rows=allThreads.filter(pass);
  $('list').innerHTML=rows.map(t=>{
    const k=KINDS[t.kind]||KINDS.unknown;
    const w=t.waitMs>5*60000?'<span class="wait'+(t.waitMs>30*60000?' bad':'')+'">⏱ '+dur(t.waitMs)+'</span>':'';
    return '<div class="row'+(t.phone===cur?' sel':'')+'" onclick="open_(\\''+t.phone+'\\')">'+
      '<div class="av '+t.kind+'">'+k.i+'</div>'+
      '<div class="rmain"><div class="rtop">'+
        '<div class="rname">'+(t.name?esc(t.name):'')+'<span class="rphone"> +'+t.phone+'</span></div>'+
        '<span class="rw">'+w+' '+ago(t.lastAt)+(t.unread?' <span class="badge">'+t.unread+'</span>':'')+'</span>'+
      '</div>'+
      '<div class="rlast">'+(t.lastDir==='out'?'↩ ':'')+esc(t.last||'')+'</div>'+
      '<div class="chips">'+
        '<span class="chip c-'+t.kind+'">'+k.i+' '+k.t+'</span>'+
        '<span class="chip s-'+t.status+'">'+(ST[t.status]||ST.new).t+'</span>'+
        (t.step&&STEPS[t.step]?'<span class="chip c-unknown">'+STEPS[t.step]+'</span>':'')+
        (t.notes?'<span class="note-c">📝 '+t.notes+'</span>':'')+
        (t.botPaused?'<span class="chip c-unknown">البوت متوقف</span>':'')+
      '</div></div></div>';
  }).join('')||'<div class="empty">ماكو محادثات بهذا الفلتر</div>';
}

async function open_(p){
  cur=p;
  if(innerWidth<=820){$('listwrap').classList.add('hide');$('chat').classList.remove('hide');}
  else $('chat').classList.remove('hide');
  const r=await fetch('/inbox/api/thread?key='+encodeURIComponent(KEY)+'&phone='+p);
  const t=await r.json();curData=t;
  const k=KINDS[t.kind]||KINDS.unknown;
  $('hav').className='av '+t.kind;$('hav').textContent=k.i;
  $('hp').textContent=(t.name?t.name+' · ':'')+'+'+p;
  $('hsub').textContent=k.t+(t.step&&STEPS[t.step]?' · '+STEPS[t.step]:'');
  document.querySelectorAll('[data-set]').forEach(b=>b.classList.toggle('on',b.dataset.set===t.status));
  $('btnBot').textContent=t.botPaused?'🚫':'🤖';
  $('btnBot').title=t.botPaused?'البوت متوقف — اضغط لتشغيله':'البوت شغّال — اضغط لإيقافه لهذه المحادثة';
  $('btnBot').classList.toggle('on',t.botPaused);
  const mins=t.lastInAt?Math.floor((Date.now()-t.lastInAt)/60000):9999;
  $('note').className='note-bar'+(mins>=1440?' warn':'');
  $('note').textContent=mins<1440
    ?'نافذة الرد المجاني مفتوحة — تنتهي بعد '+Math.floor((1440-mins)/60)+' ساعة'
    :'⚠️ مرت 24 ساعة على آخر رسالة — الرد يحتاج تمبلت معتمد وراح ينرفض';
  $('msgs').innerHTML=t.messages.map(m=>{
    const notes=(m.notes||[]).map(n=>'<div class="note"><b>📝 ملاحظة · '+
      new Date(n.at).toLocaleString('ar-IQ',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'})+
      '</b><br>'+esc(n.text)+'</div>').join('');
    return '<div class="mwrap '+m.dir+'" data-mid="'+m.id+'">'+
      '<div class="m '+m.dir+'">'+esc(m.text)+'<span class="w">'+
      new Date(m.at).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'})+
      (m.by==='agent'?' · موظف':m.by==='bot'?' · بوت':m.by==='system'?' · نظام':'')+'</span></div>'+
      notes+
      '<button class="nbtn" onclick="noteForm(this,\\''+m.id+'\\')">📝 أضف ملاحظة</button>'+
      '</div>';
  }).join('')||'<div class="empty">ماكو رسايل</div>';
  $('msgs').scrollTop=1e9;loadList();
}

function noteForm(btn,mid){
  if(btn.nextElementSibling&&btn.nextElementSibling.className==='nform')return;
  const f=document.createElement('div');f.className='nform';
  f.innerHTML='<input placeholder="ملاحظة داخلية — الزبون ما يشوفها"><button>حفظ</button>';
  btn.after(f);
  const inp=f.querySelector('input'),b=f.querySelector('button');
  inp.focus();
  const save=async()=>{
    const v=inp.value.trim();if(!v)return f.remove();
    await fetch('/inbox/api/note',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({key:KEY,phone:cur,mid,text:v})});
    open_(cur);
  };
  b.onclick=save;inp.addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape')f.remove();});
}

document.querySelectorAll('[data-set]').forEach(b=>b.onclick=async()=>{
  if(!cur)return;
  await fetch('/inbox/api/status',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:KEY,phone:cur,status:b.dataset.set})});
  open_(cur);
});
$('btnBack').onclick=()=>{$('listwrap').classList.remove('hide');if(innerWidth<=820)$('chat').classList.add('hide');};
$('btnBot').onclick=async()=>{
  if(!cur)return;
  const next=!curData.botPaused;
  // الإيقاف يحتاج تأكيد حتى ما ينداس بالغلط — التشغيل ما يحتاج
  if(next&&!confirm('توقف البوت لهذه المحادثة؟\\n\\nراح يسكت ولا يرد على الزبون لحد ما تشغّله أو يكتب الزبون 0.'))return;
  await fetch('/inbox/api/bot',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:KEY,phone:cur,paused:next})});
  open_(cur);
};
async function send(){
  const v=$('txt').value.trim();if(!v||!cur)return;
  $('txt').value='';
  const r=await fetch('/inbox/api/send',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:KEY,phone:cur,text:v})});
  if(!r.ok){const e=await r.json().catch(()=>({}));alert('ما انرسلت: '+(e.error||r.status));}
  open_(cur);
}
$('send').onclick=send;
$('txt').addEventListener('keydown',e=>{if(e.key==='Enter')send();});

/* ── تنبيه صوتي ── */
let soundOn=true; try{soundOn=localStorage.getItem('hsaSound')!=='0';}catch(e){}
let actx=null,lastUnread=null;
$('bell').textContent=soundOn?'🔔':'🔕';
$('bell').onclick=()=>{soundOn=!soundOn;$('bell').textContent=soundOn?'🔔':'🔕';
  try{localStorage.setItem('hsaSound',soundOn?'1':'0');}catch(e){}if(soundOn)chime();};
['click','keydown','touchstart'].forEach(ev=>addEventListener(ev,function unlock(){
  try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume();}catch(e){}
  removeEventListener(ev,unlock);},{once:true}));
function chime(){
  if(!soundOn)return;
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended')actx.resume();
    const t=actx.currentTime;
    [[880,0,0.22],[1318.51,0.11,0.18]].forEach(([f,d,v])=>{
      const o=actx.createOscillator(),g=actx.createGain();
      o.type='sine';o.frequency.value=f;
      g.gain.setValueAtTime(0,t+d);g.gain.linearRampToValueAtTime(v,t+d+0.012);
      g.gain.exponentialRampToValueAtTime(0.0001,t+d+0.55);
      o.connect(g);g.connect(actx.destination);o.start(t+d);o.stop(t+d+0.6);
    });
  }catch(e){}
}
function onCounts(total){
  if(lastUnread!==null&&total>lastUnread){
    chime();
    try{if(!document.hasFocus()&&Notification&&Notification.permission==='granted')
      new Notification('رسالة جديدة — إنبوكس هسة',{body:'عندك '+total+' رسالة غير مقروءة'});}catch(e){}
  }
  lastUnread=total;
  document.title=(total?'('+total+') ':'')+'إنبوكس هسة';
}
try{if(window.Notification&&Notification.permission==='default')
  $('bell').addEventListener('click',()=>Notification.requestPermission(),{once:true});}catch(e){}

loadList();setInterval(()=>{loadList();if(cur&&document.hasFocus())open_(cur);},5000);
</script></body></html>`;

/* ═══════════════════════════ التركيب ═══════════════════════════ */

function mount(app, wa) {
  const ok = (req) => {
    const key = req.query.key || req.body?.key;
    return process.env.INBOX_KEY && key === process.env.INBOX_KEY;
  };

  app.get('/inbox', (req, res) => {
    if (!process.env.INBOX_KEY) return res.status(503).send('INBOX_KEY غير مضبوط');
    res.type('html').send(PAGE);
  });

  app.get('/inbox/api/threads', (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    res.json({ threads: list(), stats: stats() });
  });

  app.get('/inbox/api/thread', (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const t = get(String(req.query.phone || ''));
    if (!t) return res.json({ messages: [] });
    markSeen(t.phone);
    const lastIn = [...t.messages].reverse().find((m) => m.dir === 'in');
    res.json({
      phone: t.phone, name: t.name, step: t.step, kind: kindOf(t),
      status: t.status, botPaused: t.botPaused,
      lastInAt: lastIn ? lastIn.at : null, messages: t.messages,
    });
  });

  app.post('/inbox/api/send', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const { phone, text } = req.body || {};
    if (!phone || !text) return res.status(400).json({ error: 'phone و text مطلوبين' });
    try {
      await wa.sendText(String(phone), String(text));
      setBotPaused(phone, true);              // الموظف تدخّل → البوت يسكت
      setStatus(phone, 'open');               // وتنتقل تلقائياً لقيد المعالجة
      record(phone, 'out', text, { by: 'agent' });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.details?.error?.message || e.message });
    }
  });

  app.post('/inbox/api/bot', (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const { phone, paused } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone مطلوب' });
    setBotPaused(phone, paused);
    res.json({ ok: true, botPaused: !!paused });
  });

  app.post('/inbox/api/status', (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const { phone, status } = req.body || {};
    if (!phone || !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'phone و status مطلوبين' });
    }
    setStatus(phone, status);
    res.json({ ok: true, status });
  });

  app.post('/inbox/api/note', (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const { phone, mid, text } = req.body || {};
    if (!phone || !mid || !text) return res.status(400).json({ error: 'phone و mid و text مطلوبين' });
    const note = addNote(phone, mid, text);
    if (!note) return res.status(404).json({ error: 'الرسالة مو موجودة' });
    res.json({ ok: true, note });
  });
}

loadFromDisk();
importRecovered();

module.exports = {
  record, setStep, markSeen, isBotPaused, setBotPaused,
  setStatus, addNote, list, get, stats, mount,
};
