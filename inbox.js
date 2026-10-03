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
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');

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
  if (meta.media && meta.media.id) rec.media = meta.media;
  if (meta.location) rec.loc = meta.location;
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

/** بيانات المتجر الي جمعها البوت — يستعملها زر العقد بدل ما يكتبها الموظف */
function setStore(phone, data = {}) {
  const t = thread(String(phone));
  t.store = { ...(t.store || {}), ...data };
}

/* ═══════════════ التصنيف ═══════════════ */

/* ── الرسايل الي تنعرض ──
   خلل قديم كان يسجّل رد الموظف مرتين (مرة كـ"بوت" ومرة كـ"موظف").
   ما نمسح ولا سجل من الملف — بس نعرض النسخة المكررة مرة وحدة. ═══ */
function visible(msgs) {
  const out = [];
  for (const m of msgs) {
    const p = out[out.length - 1];
    if (p && p.dir === 'out' && m.dir === 'out' &&
        p.text === m.text && Math.abs(m.at - p.at) < 15000) {
      if (m.by === 'agent') out[out.length - 1] = m;   // نخلي نسخة الموظف
      continue;
    }
    out.push(m);
  }
  return out;
}

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
  const msgs = visible(t.messages);
  const agent = [], bot = [];
  let pendingAgent = null;   // أقدم واردة ما ردّ عليها موظف
  let pendingBot = null;     // آخر واردة ما ردّ عليها البوت
  for (const m of msgs) {
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
  const last = msgs[msgs.length - 1];
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
        store: t.store || null,
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
.fbar{background:#1a2030;border-bottom:1px solid var(--line);padding:7px 13px;font-size:12px;
  color:var(--dim);display:flex;align-items:center;gap:8px}
.fbar b{color:var(--txt)}
.fbar a{margin-inline-start:auto;color:var(--acc2);cursor:pointer;font-weight:700;text-decoration:none}

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
.m img.ph{max-width:260px;max-height:320px;border-radius:10px;display:block;cursor:zoom-in;margin:2px 0}
.m audio{width:250px;height:38px;display:block;margin:3px 0}
.m .loc{display:flex;gap:7px;align-items:center;background:rgba(0,0,0,.07);
  padding:8px 11px;border-radius:10px;text-decoration:none;color:inherit;font-size:13px;margin:2px 0}
.m .fl{font-size:13px;opacity:.85}
#compose .ib{background:#eef1f4;border:0;border-radius:10px;width:38px;height:38px;
  font-size:17px;cursor:pointer;flex:none}
#compose .ib:hover{background:#e0e5ea}
#compose .ib.rec{background:#e5484d;color:#fff;animation:pulse 1.1s infinite}
@keyframes pulse{50%{opacity:.55}}
#rectime{font-size:13px;color:#e5484d;font-weight:700;min-width:42px;text-align:center}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;
  justify-content:center;z-index:99;cursor:zoom-out}
.lightbox img{max-width:92vw;max-height:92vh;border-radius:8px}
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
  <a href="/contract" id="lnkContract" class="ghost" title="سوّي عقد بدون محادثة"
     style="padding:6px 11px;font-size:12.5px;text-decoration:none;display:inline-block">📄 عقد جديد</a>
  <button id="bPhone" class="ghost" title="انسخ رابط يشتغل بالتلفون بدون ما تدخل المفتاح"
     style="padding:6px 11px;font-size:12.5px">📱 رابط التلفون</button>
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
      <button data-s="all">كل الحالات</button>
      <button data-s="new">🔵 جديد</button>
      <button data-s="open">🟠 قيد المعالجة</button>
      <button data-s="done">🟢 تم</button>
      <button data-s="unread" class="on">🔴 ينتظر رد</button>
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
    <div id="compose"><button class="ib" id="btnVoice" title="سجّل رسالة صوتية">🎤</button><button class="ib" id="btnLoc" title="أرسل موقع الشركة">📍</button><button class="ib" id="btnDoc" title="أرسل عقد المتاجر">📄</button><span id="rectime"></span><input id="txt" placeholder="اكتب ردك..." autocomplete="off"><button id="send">إرسال</button></div>
  </div>
</main>
<script>
let KEY='';
(function(){
  /* المفتاح: من الرابط إذا موجود (الروابط المحفوظة بالتلفون تشتغل دائماً)،
     وإلا من ذاكرة المتصفح. ما ننشّله من الرابط — هذا كان يكسر الروابط المحفوظة. */
  const u=new URLSearchParams(location.search).get('key')||'';
  if(u){KEY=u;try{localStorage.setItem('hsaKey',u);}catch(e){}return;}
  try{KEY=localStorage.getItem('hsaKey')||'';}catch(e){}
})();
if(KEY){try{document.getElementById('lnkContract').href='/contract?key='+encodeURIComponent(KEY);}catch(e){}}

function askKey(msg){
  const v=(prompt(msg||'مفتاح الإنبوكس:')||'').trim();
  if(!v)return false;
  KEY=v;try{localStorage.setItem('hsaKey',v);}catch(e){}
  return true;
}
document.getElementById('bPhone').onclick=function(){
  if(!KEY){alert('أدخل المفتاح أول');return;}
  var link=location.origin+'/inbox?key='+encodeURIComponent(KEY);
  var done=function(){
    var b=document.getElementById('bPhone'), t=b.textContent;
    b.textContent='✅ انتسخ'; setTimeout(function(){b.textContent=t;},1800);
  };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(link).then(done,function(){prompt('انسخ الرابط:',link);});
  } else { prompt('انسخ الرابط ودزّه لنفسك بالواتساب:',link); }
};

function keyGate(){
  $('list').innerHTML='<div class="empty">محتاج مفتاح الإنبوكس<br><br>'
    +'<button class="ghost" onclick="relogin()">أدخل المفتاح</button></div>';
  $('stats').innerHTML='';
}
function relogin(){ if(askKey('مفتاح الإنبوكس:')) loadList(); }
let cur=null,curData=null,allThreads=[],st={},fKind='all',fStatus='unread',q='';
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
  if(!KEY){keyGate();return;}
  let r;
  try{ r=await fetch('/inbox/api/threads?key='+encodeURIComponent(KEY)); }
  catch(e){ $('list').innerHTML='<div class="empty">ماكو اتصال بالسيرفر — نحاول مرة ثانية...</div>'; return; }
  if(r.status===401){
    try{localStorage.removeItem('hsaKey');}catch(e){}
    KEY='';
    $('list').innerHTML='<div class="empty">المفتاح غير صحيح<br><br>'
      +'<button class="ghost" onclick="relogin()">أدخل المفتاح</button></div>';
    $('stats').innerHTML='';
    return;
  }
  if(!r.ok){$('list').innerHTML='<div class="empty">السيرفر رجّع خطأ '+r.status+'</div>';return;}
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

function showAll(){
  fStatus='all';fKind='all';q='';
  $('search').value='';
  document.querySelectorAll('#fKind button').forEach(b=>b.classList.toggle('on',b.dataset.f==='all'));
  document.querySelectorAll('#fStatus button').forEach(b=>b.classList.toggle('on',b.dataset.s==='all'));
  render();
}
function render(){
  if(!KEY){keyGate();return;}
  const c={all:allThreads.length,unread:0,store:0,courier:0,customer:0,new:0,open:0,done:0};
  allThreads.forEach(t=>{if(t.unread)c.unread++;if(c[t.kind]!==undefined)c[t.kind]++;if(c[t.status]!==undefined)c[t.status]++;});
  document.querySelectorAll('#fKind button').forEach(b=>{
    const base=b.dataset.base||(b.dataset.base=b.textContent);b.textContent=base+' '+(c[b.dataset.f]||0);});
  document.querySelectorAll('#fStatus button').forEach(b=>{
    const base=b.dataset.base||(b.dataset.base=b.textContent);
    b.textContent=base+' '+(b.dataset.s==='all'?c.all:(c[b.dataset.s]||0));});

  let rows=allThreads.filter(pass);
  // لمن نعرض «ينتظر رد» نرتّب بالأطول انتظاراً — الي ينتظر ٤ ساعات أول صف
  if(fStatus==='unread') rows=rows.slice().sort((a,b)=>(b.waitMs||0)-(a.waitMs||0)||(a.lastAt||0)-(b.lastAt||0));
  const hidden=allThreads.length-rows.length;
  const fbar=hidden>0
    ?'<div class="fbar">تعرض <b>'+rows.length+'</b> من <b>'+allThreads.length+'</b> محادثة · '+hidden+' مخفية بالفلتر'+
      '<a onclick="showAll()">اعرض الكل</a></div>'
    :'';
  $('list').innerHTML=fbar+rows.map(t=>{
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
  }).join('')||'<div class="empty">'+(fStatus==='unread'
    ?'ماكو أحد ينتظر رد 🎉<br><br><button class="ghost" onclick="showAll()">اعرض كل المحادثات</button>'
    :'ماكو محادثات بهذا الفلتر')+'</div>';
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
      '<div class="m '+m.dir+'">'+media(m)+esc(m.text)+'<span class="w">'+
      new Date(m.at).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'})+
      (m.by==='agent'?' · موظف':m.by==='bot'?' · بوت':m.by==='system'?' · نظام':'')+'</span></div>'+
      notes+
      '<button class="nbtn" onclick="noteForm(this,\\''+m.id+'\\')">📝 أضف ملاحظة</button>'+
      '</div>';
  }).join('')||'<div class="empty">ماكو رسايل</div>';
  $('msgs').scrollTop=1e9;loadList();
}


/* يرسم الصور والصوت والمواقع داخل الفقاعة */
function media(m){
  const u=id=>'/inbox/media/'+encodeURIComponent(id)+'?key='+encodeURIComponent(KEY);
  let h='';
  if(m.loc&&m.loc.lat){
    h+='<a class="loc" target="_blank" rel="noopener" href="https://maps.google.com/?q='+
       m.loc.lat+','+m.loc.lng+'">📍 <span>'+esc(m.loc.name||m.loc.address||'الموقع على الخريطة')+'</span></a>';
  }
  if(!m.media||!m.media.id) return h;
  const k=m.media.kind;
  if(k==='image'||k==='sticker'){
    h+='<img class="ph" loading="lazy" src="'+u(m.media.id)+'" onclick="zoom(this.src)" alt="صورة">';
  }else if(k==='audio'){
    h+='<audio controls preload="none" src="'+u(m.media.id)+'"></audio>';
  }else if(k==='video'){
    h+='<a class="loc" target="_blank" rel="noopener" href="'+u(m.media.id)+'">🎬 <span>افتح الفيديو</span></a>';
  }else{
    h+='<a class="loc" target="_blank" rel="noopener" href="'+u(m.media.id)+'">📄 <span>'+
       esc(m.media.filename||'افتح الملف')+'</span></a>';
  }
  return h;
}
function zoom(src){
  const d=document.createElement('div');d.className='lightbox';
  d.innerHTML='<img src="'+src+'">';d.onclick=()=>d.remove();document.body.appendChild(d);
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


/* ── تسجيل وإرسال رسالة صوتية ── */
let mediaRec=null,chunks=[],recTimer=null,recStart=0;
const pickMime=()=>['audio/ogg;codecs=opus','audio/webm;codecs=opus','audio/webm','audio/mp4']
  .find(t=>window.MediaRecorder&&MediaRecorder.isTypeSupported(t))||'';
function recUI(on){
  $('btnVoice').classList.toggle('rec',on);
  $('btnVoice').textContent=on?'⏹':'🎤';
  $('btnVoice').title=on?'أوقف وأرسل':'سجّل رسالة صوتية';
  if(!on){$('rectime').textContent='';clearInterval(recTimer);}
}
async function startRec(){
  if(!cur)return alert('اختر محادثة أول');
  if(!navigator.mediaDevices||!window.MediaRecorder)
    return alert('المتصفح ما يدعم التسجيل. استعمل كروم أو فايرفوكس حديث.');
  let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});}
  catch(e){return alert('ما وصلني إذن المايك. افتح إعدادات الموقع واسمح بالمايكروفون.');}
  const mt=pickMime();
  try{mediaRec=mt?new MediaRecorder(stream,{mimeType:mt}):new MediaRecorder(stream);}
  catch(e){mediaRec=new MediaRecorder(stream);}
  chunks=[];recStart=Date.now();
  mediaRec.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
  mediaRec.onstop=async()=>{
    stream.getTracks().forEach(t=>t.stop());
    recUI(false);
    const secs=(Date.now()-recStart)/1000;
    const blob=new Blob(chunks,{type:mediaRec.mimeType||'audio/webm'});
    if(secs<0.7||blob.size<1200)return;                 // ضغطة غلط — ما نرسل
    $('btnVoice').disabled=true;$('btnVoice').textContent='⏳';
    try{
      const r=await fetch('/inbox/api/send-voice?key='+encodeURIComponent(KEY)+'&phone='+encodeURIComponent(cur),
        {method:'POST',headers:{'Content-Type':blob.type||'audio/webm'},body:blob});
      if(!r.ok){const e=await r.json().catch(()=>({}));alert('ما انرسلت: '+(e.error||r.status));}
      else{const j=await r.json();if(j&&j.voice===false)
        console.warn('انرسلت كمرفق صوتي — التحويل لـogg ما اشتغل');}
    }catch(e){alert('ما انرسلت: '+e.message);}
    $('btnVoice').disabled=false;recUI(false);open_(cur);
  };
  mediaRec.start();recUI(true);
  recTimer=setInterval(()=>{
    const s2=Math.floor((Date.now()-recStart)/1000);
    $('rectime').textContent=String(Math.floor(s2/60)).padStart(2,'0')+':'+String(s2%60).padStart(2,'0');
    if(s2>=180)stopRec();                               // سقف ٣ دقائق
  },250);
}
function stopRec(){try{if(mediaRec&&mediaRec.state!=='inactive')mediaRec.stop();}catch(e){}}
$('btnVoice').onclick=()=>{(mediaRec&&mediaRec.state==='recording')?stopRec():startRec();};

/* ── إرسال موقع الشركة ── */
$('btnLoc').onclick=async()=>{
  if(!cur)return alert('اختر محادثة أول');
  if(!confirm('أرسل موقع الشركة لهذا الزبون؟'))return;
  $('btnLoc').disabled=true;
  try{
    const r=await fetch('/inbox/api/send-location',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,phone:cur})});
    if(!r.ok){const e=await r.json().catch(()=>({}));alert('ما انرسل: '+(e.error||r.status));}
  }catch(e){alert('ما انرسل: '+e.message);}
  $('btnLoc').disabled=false;open_(cur);
};

/* ── إرسال عقد المتاجر ── */
$('btnDoc').onclick=async()=>{
  if(!cur)return alert('اختر محادثة أول');
  const sv=(curData&&curData.store)||{};
  let store=sv.name||'', owner=sv.rep||'';
  if(!store) store=(prompt('اسم المتجر (ما جمعه البوت):')||'').trim();
  if(!store)return;
  if(!owner) owner=(prompt('اسم الممثل القانوني (ما جمعه البوت):')||'').trim();
  if(!owner)return;
  const pick=(prompt('أي نسخة ترسل؟\\n\\n1 = مسودة للمراجعة (بدون ختم)\\n2 = نسخة نهائية مختومة','1')||'').trim();
  if(pick!=='1'&&pick!=='2')return;
  const seal=pick==='2';
  if(!confirm((seal?'أرسل النسخة النهائية المختومة؟':'أرسل المسودة للمراجعة؟')
    +'\\n\\nالمتجر: '+store+'\\nيمثله: '+owner))return;
  $('btnDoc').disabled=true;$('btnDoc').textContent='⏳';
  try{
    const r=await fetch('/inbox/api/send-contract',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({key:KEY,phone:cur,store:store,owner:owner,seal:seal})});
    if(!r.ok){const e=await r.json().catch(()=>({}));alert('ما انرسل: '+(e.error||r.status));}
  }catch(e){alert('ما انرسل: '+e.message);}
  $('btnDoc').disabled=false;$('btnDoc').textContent='📄';open_(cur);
};

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


/* ═══════════════ الوسائط ═══════════════ */

const MEDIA_DIR = path.join(DATA_DIR, 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* موجود */ }

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/amr': 'amr', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
};
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);

/** ينزّل الوسيط مرة وحدة ويخزنه على القرص الدائم — واتساب تحذفه بعد ٣٠ يوم */
async function fetchMedia(wa, mediaId) {
  const id = safeId(mediaId);
  if (!id) throw new Error('معرّف وسيط غير صالح');
  const metaPath = path.join(MEDIA_DIR, `${id}.json`);
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const binPath = path.join(MEDIA_DIR, meta.file);
    if (fs.existsSync(binPath)) return { path: binPath, mime: meta.mime };
  }
  const { buffer, mime } = await wa.downloadMedia(id);
  const file = `${id}.${EXT[mime.split(';')[0]] || 'bin'}`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
  fs.writeFileSync(metaPath, JSON.stringify({ file, mime, at: Date.now() }));
  return { path: path.join(MEDIA_DIR, file), mime };
}

/** يحوّل تسجيل المتصفح (webm/opus) إلى ogg/opus — شرط ميتا للبصمة الصوتية.
    نسخ بلا إعادة ترميز، فالعملية لحظية وبلا خسارة جودة. */
function toOggOpus(inputBuf, inMime) {
  return new Promise((resolve) => {
    if (/ogg/i.test(inMime)) return resolve({ buffer: inputBuf, voice: true });
    let bin;
    try { bin = require('@ffmpeg-installer/ffmpeg').path; } catch { bin = 'ffmpeg'; }
    const tmpIn = path.join(os.tmpdir(), `v${Date.now()}.in`);
    try { fs.writeFileSync(tmpIn, inputBuf); } catch { return resolve({ buffer: inputBuf, voice: false }); }
    const args = ['-hide_banner', '-loglevel', 'error', '-i', tmpIn,
      '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1'];
    let out = [];
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { fs.unlinkSync(tmpIn); } catch {} resolve(r); };
    let p;
    try { p = spawn(bin, args); } catch { return finish({ buffer: inputBuf, voice: false }); }
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', () => finish({ buffer: inputBuf, voice: false }));
    p.on('close', (code) => {
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 100) finish({ buffer: buf, voice: true });
      else finish({ buffer: inputBuf, voice: false });   // ما انحوّل → يروح كمرفق صوتي عادي
    });
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish({ buffer: inputBuf, voice: false }); }, 20000);
  });
}

/* 07XXXXXXXXX  →  9647XXXXXXXXX */
function normPhone(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('964')) return d;
  if (d.startsWith('0')) return '964' + d.slice(1);
  if (d.length === 10 && d.startsWith('7')) return '964' + d;
  return d;
}

const CONTRACT_PAGE = `<!doctype html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>عقد متجر — هسة</title>
<style>
:root{--bg:#0b0e14;--panel:#11151d;--panel2:#161b26;--line:#232a38;--txt:#e9edf3;
  --dim:#8d97a8;--acc:#6d5efc;--acc2:#00c2a8;--warn:#f0a132;--bad:#ef5361;--done:#3ddc84}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 -apple-system,"Segoe UI",Roboto,"Noto Naskh Arabic",sans-serif;
  background:var(--bg);color:var(--txt);min-height:100dvh}
header{background:linear-gradient(135deg,#171a2e,#101522);border-bottom:1px solid var(--line);
  padding:12px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{margin:0;font-size:17px;font-weight:700;display:flex;align-items:center;gap:9px}
header a{margin-inline-start:auto;color:var(--dim);font-size:13px;text-decoration:none;
  border:1px solid var(--line);border-radius:8px;padding:6px 12px}
header a:hover{color:#fff;border-color:#3a4459}
.wrap{max-width:1180px;margin:0 auto;padding:18px;display:grid;gap:18px;grid-template-columns:400px 1fr}
@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h2{margin:0 0 14px;font-size:14px;color:var(--dim);font-weight:700;letter-spacing:.3px}
label{display:block;font-size:12.5px;color:var(--dim);font-weight:600;margin:14px 0 6px}
label:first-of-type{margin-top:0}
input{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--txt);
  border-radius:10px;padding:11px 13px;font:inherit;font-size:14.5px}
input:focus{outline:none;border-color:var(--acc)}
input.ltr{direction:ltr;unicode-bidi:embed;text-align:left}
.hint{font-size:11.5px;color:#6c7687;margin-top:5px}
.seg{display:flex;gap:8px;margin-top:4px}
.seg button{flex:1;background:#1a2030;color:#b6bfcf;border:1px solid var(--line);border-radius:10px;
  padding:11px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;transition:.15s}
.seg button:hover{border-color:#3a4459}
.seg button.on{background:var(--acc);border-color:var(--acc);color:#fff}
.btns{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}
.btn{flex:1;min-width:120px;border:none;border-radius:10px;padding:12px;font:inherit;font-size:14px;
  font-weight:700;cursor:pointer;transition:.15s}
.btn.p{background:var(--acc2);color:#04231e}
.btn.s{background:#222a3a;color:#c9cfd8;border:1px solid var(--line)}
.btn.w{background:#1f7a54;color:#fff}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn:hover:not(:disabled){filter:brightness(1.12)}
#msg{margin-top:14px;font-size:13.5px;border-radius:10px;padding:0;min-height:0;transition:.2s}
#msg.on{padding:11px 13px}
#msg.ok{background:#123020;color:#8ff0b5;border:1px solid #1d5236}
#msg.err{background:#331519;color:#ffadb5;border:1px solid #5c2027}
#msg.busy{background:#1a2030;color:var(--dim);border:1px solid var(--line)}
.prev{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;
  display:flex;flex-direction:column;min-height:620px}
.prev .bar{padding:10px 15px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--dim);
  display:flex;align-items:center;gap:8px}
.prev iframe{flex:1;width:100%;border:none;background:#2b2f38}
.empty{flex:1;display:grid;place-items:center;color:#5a6373;font-size:14px;text-align:center;padding:40px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}
.dot.ok{background:var(--done)}
</style></head><body>

<header>
  <h1>📄 عقد متجر — هسة</h1>
  <a href="/inbox" id="back">↩ رجوع للإنبوكس</a>
</header>

<div class="wrap">
  <div class="card">
    <h2>بيانات العقد</h2>

    <label>اسم المتجر <span style="color:var(--bad)">*</span></label>
    <input id="store" placeholder="مثال: متجر الورد للعطور" autocomplete="off">

    <label>اسم الممثّل القانوني <span style="color:var(--bad)">*</span></label>
    <input id="owner" placeholder="مثال: علي حسن كريم" autocomplete="off">
    <div class="hint">الاسم الكامل مثل ما بالهوية — يُكتب بالعقد كطرف ثاني.</div>

    <label>نوع النسخة</label>
    <div class="seg">
      <button id="bDraft" data-seal="0">مسودة · بعلامة مائية</button>
      <button id="bFinal" class="on" data-seal="1">نهائية · مختومة وموقّعة</button>
    </div>
    <div class="hint" id="sealHint">النهائية تحمل تاريخ اليوم + الختم + التوقيع.</div>

    <label>رقم واتساب (اختياري — للإرسال المباشر)</label>
    <input id="phone" class="ltr" placeholder="07XX XXX XXXX" autocomplete="off">
    <div class="hint">اتركه فارغ إذا تريد تنزيل الملف بس.</div>

    <div class="btns">
      <button class="btn p" id="bPrev">👁 معاينة</button>
      <button class="btn s" id="bDown">⬇ تنزيل</button>
    </div>
    <div class="btns" style="margin-top:8px">
      <button class="btn w" id="bSend">دزّه واتساب</button>
    </div>

    <div id="msg"></div>
  </div>

  <div class="prev">
    <div class="bar"><span class="dot" id="pdot"></span><span id="ptitle">ماكو معاينة بعد</span>
      <a id="popen" style="margin-inline-start:auto;color:var(--acc2);display:none;text-decoration:none;font-weight:700"
         target="_blank">↗ افتحها بتبويب</a></div>
    <div class="empty" id="pempty">عبّي الاسمين واضغط «معاينة»<br>حتى تشوف العقد قبل ما تدزّه</div>
    <iframe id="pframe" style="display:none"></iframe>
  </div>
</div>

<script>
var KEY='';
(function(){
  var u=new URLSearchParams(location.search).get('key')||'';
  if(u){KEY=u;try{localStorage.setItem('hsaKey',u);}catch(e){}return;}
  try{KEY=localStorage.getItem('hsaKey')||'';}catch(e){}
})();

if(KEY){try{document.getElementById('back').href='/inbox?key='+encodeURIComponent(KEY);}catch(e){}}

var SEAL=1, lastUrl=null;
var $=function(id){return document.getElementById(id);};

function setSeal(v){
  SEAL=v;
  $('bDraft').className = v?'':'on';
  $('bFinal').className = v?'on':'';
  $('sealHint').textContent = v
    ? 'النهائية تحمل تاريخ اليوم + الختم + التوقيع.'
    : 'المسودة بدون تاريخ وبدون ختم، وعليها علامة مائية «مسودة عقد».';
}
$('bDraft').onclick=function(){setSeal(0);};
$('bFinal').onclick=function(){setSeal(1);};

function say(cls,txt){
  var m=$('msg');
  m.className = txt ? ('on '+cls) : '';
  m.textContent = txt||'';
}

function vals(){
  var s=$('store').value.trim(), o=$('owner').value.trim();
  if(!s){say('err','اكتب اسم المتجر');$('store').focus();return null;}
  if(!o){say('err','اكتب اسم الممثّل القانوني');$('owner').focus();return null;}
  if(o.split(/\\s+/).length<2){say('err','اسم الممثّل القانوني لازم اسمين على الأقل');$('owner').focus();return null;}
  if(!KEY){say('err','ماكو مفتاح — افتح الصفحة بـ ?key=... مرة واحدة');return null;}
  return {store:s,owner:o,seal:SEAL===1,key:KEY};
}

async function build(){
  var v=vals(); if(!v) return null;
  say('busy','يبني العقد…');
  var r=await fetch('/contract/api/build',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(v)});
  if(!r.ok){
    var e={}; try{e=await r.json();}catch(x){}
    say('err', e.error || ('فشل البناء — '+r.status));
    return null;
  }
  var blob=await r.blob();
  var name=decodeURIComponent(r.headers.get('X-File-Name')||'contract.pdf');
  return {blob:blob,name:name};
}

$('bPrev').onclick=async function(){
  var b=await build(); if(!b) return;
  if(lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl=URL.createObjectURL(b.blob);
  $('pempty').style.display='none';
  var f=$('pframe'); f.style.display='block'; f.src=lastUrl;
  $('pdot').className='dot ok';
  $('ptitle').textContent=b.name+'  ·  '+Math.round(b.blob.size/1024)+' كيلوبايت';
  var po=$('popen'); po.href=lastUrl; po.style.display='inline';
  say('ok','المعاينة جاهزة — شوفها على اليسار');
};

$('bDown').onclick=async function(){
  var b=await build(); if(!b) return;
  var u=URL.createObjectURL(b.blob);
  var a=document.createElement('a'); a.href=u; a.download=b.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){URL.revokeObjectURL(u);},4000);
  say('ok','نزّلنا: '+b.name);
};

$('bSend').onclick=async function(){
  var v=vals(); if(!v) return;
  var p=$('phone').value.trim();
  if(!p){say('err','اكتب رقم الواتساب أول');$('phone').focus();return;}
  if(!confirm('أدزّ '+(SEAL?'النسخة المختومة':'المسودة')+' لـ '+p+' ؟')) return;
  v.phone=p;
  say('busy','يدزّ…');
  var r=await fetch('/contract/api/send',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(v)});
  var j={}; try{j=await r.json();}catch(x){}
  if(r.ok && j.ok) say('ok','انرسل ✅  '+j.file+'  →  '+j.to);
  else say('err', j.error || ('فشل الإرسال — '+r.status));
};

['store','owner','phone'].forEach(function(id){
  $(id).addEventListener('keydown',function(e){ if(e.key==='Enter') $('bPrev').click(); });
});
</script>
</body></html>`;

function mount(app, wa) {
  const ok = (req) => {
    const key = req.query.key || req.body?.key;
    return process.env.INBOX_KEY && key === process.env.INBOX_KEY;
  };

  app.get('/inbox', (req, res) => {
    if (!process.env.INBOX_KEY) return res.status(503).send('INBOX_KEY غير مضبوط');
    res.type('html').send(PAGE);
  });

  /* ── صفحة العقد المستقلة — خارج الإنبوكس ── */
  app.get('/contract', (req, res) => {
    if (!process.env.INBOX_KEY) return res.status(503).send('INBOX_KEY غير مضبوط');
    res.type('html').send(CONTRACT_PAGE);
  });

  app.post('/contract/api/build', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const store = String((req.body && req.body.store) || '').trim();
    const owner = String((req.body && req.body.owner) || '').trim();
    const seal  = (req.body && req.body.seal) !== false;
    if (!store) return res.status(400).json({ error: 'اسم المتجر مطلوب' });
    if (!owner) return res.status(400).json({ error: 'اسم الممثّل القانوني مطلوب' });
    try {
      const contract = require('./contract');
      const pdf  = await contract.fillContract({ store, owner, seal });
      const name = contract.fileName(store, seal);
      res.setHeader('X-File-Name', encodeURIComponent(name));
      res.setHeader('Access-Control-Expose-Headers', 'X-File-Name');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="contract.pdf"');
      res.send(pdf);
    } catch (e) {
      console.error('[contract] بناء العقد فشل:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/contract/api/send', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const store = String((req.body && req.body.store) || '').trim();
    const owner = String((req.body && req.body.owner) || '').trim();
    const seal  = (req.body && req.body.seal) !== false;
    const to    = normPhone(req.body && req.body.phone);
    if (!store) return res.status(400).json({ error: 'اسم المتجر مطلوب' });
    if (!owner) return res.status(400).json({ error: 'اسم الممثّل القانوني مطلوب' });
    if (to.length < 11) return res.status(400).json({ error: 'رقم الواتساب مو صحيح' });
    try {
      const contract = require('./contract');
      const pdf  = await contract.fillContract({ store, owner, seal });
      const name = contract.fileName(store, seal);
      const id   = await wa.uploadMedia(pdf, 'application/pdf', name);
      await wa.sendDocument(to, id, {
        filename: name,
        caption: seal
          ? `عقد خدمات — ${contract.clean(store)}`
          : `مسودة عقد للمراجعة — ${contract.clean(store)}`,
        by: 'agent',
      });
      console.log(`[contract] 📄 ${seal ? 'مختوم' : 'مسودة'} ${to} — ${contract.clean(store)} (صفحة مستقلة)`);
      res.json({ ok: true, file: name, to, sealed: seal });
    } catch (e) {
      console.error('[contract] إرسال العقد فشل:', e.message, e.details || '');
      res.status(502).json({ error: (e.details && e.details.error && e.details.error.message) || e.message });
    }
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
      phone: t.phone, name: t.name, step: t.step, kind: kindOf(t), store: t.store || null,
      status: t.status, botPaused: t.botPaused,
      lastInAt: lastIn ? lastIn.at : null, messages: visible(t.messages),
    });
  });

  app.post('/inbox/api/send', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const { phone, text } = req.body || {};
    if (!phone || !text) return res.status(400).json({ error: 'phone و text مطلوبين' });
    try {
      // wa.sendText تسجّلها بالإنبوكس بنفسها — ما نسجّلها مرة ثانية وإلا تنعرض مرتين
      await wa.sendText(String(phone), String(text), true, 'agent');
      setBotPaused(phone, true);              // الموظف تدخّل → البوت يسكت
      setStatus(phone, 'open');               // وتنتقل تلقائياً لقيد المعالجة
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.details?.error?.message || e.message });
    }
  });


  /* ── وسيط الوسائط: يخدم الصور والصوت للمتصفح ──
     المفتاح بالكويري لأن <img> و<audio> ما يكدرون يرسلون هيدرز */
  app.get('/inbox/media/:id', async (req, res) => {
    if (!ok(req)) return res.status(401).send('مفتاح غير صحيح');
    try {
      const { path: p2, mime } = await fetchMedia(wa, req.params.id);
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      fs.createReadStream(p2).pipe(res);
    } catch (e) {
      console.error('[inbox] وسيط فشل:', e.message);
      res.status(404).send('الوسيط مو متوفر');
    }
  });

  /* ── إرسال رسالة صوتية من الحاسبة ──
     المتصفح يسجّل webm/opus، نحوّلها ogg/opus حتى تنعرض بصمة صوتية */
  app.post('/inbox/api/send-voice',
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '16mb' }),
    async (req, res) => {
      if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
      const phone = String(req.query.phone || '');
      if (!phone) return res.status(400).json({ error: 'phone مطلوب' });
      const raw = req.body;
      if (!raw || !raw.length) return res.status(400).json({ error: 'ماكو صوت' });
      try {
        const inMime = req.get('content-type') || 'audio/webm';
        const { buffer, voice } = await toOggOpus(raw, inMime);
        const mime = voice ? 'audio/ogg' : (inMime.split(';')[0] || 'audio/mpeg');
        const mediaId = await wa.uploadMedia(buffer, mime, voice ? 'voice.ogg' : 'audio');
        await wa.sendAudio(phone, mediaId, { voice, by: 'agent' });
        // نخزّنها محلياً حتى تنعرض بالإنبوكس فوراً بلا ما ننزّلها من واتساب
        try {
          const id = safeId(mediaId);
          const file = `${id}.${voice ? 'ogg' : 'bin'}`;
          fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
          fs.writeFileSync(path.join(MEDIA_DIR, `${id}.json`), JSON.stringify({ file, mime, at: Date.now() }));
        } catch { /* الكاش اختياري */ }
        const t = thread(phone);
        const last = t.messages[t.messages.length - 1];
        if (last && last.dir === 'out') {
          last.media = { kind: 'audio', id: mediaId, mime, voice };
          appendFile(last);
        }
        setBotPaused(phone, true);
        setStatus(phone, 'open');
        res.json({ ok: true, voice });
      } catch (e) {
        console.error('[inbox] إرسال صوت فشل:', e.message, e.details || '');
        res.status(502).json({ error: e.details?.error?.message || e.message });
      }
    });

  /* ── إرسال موقع الشركة ──
     الإحداثيات من متغيّرات البيئة حتى ما تنحفر بالكود */
  app.post('/inbox/api/send-location', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone مطلوب' });
    const lat = Number(process.env.COMPANY_LAT);
    const lng = Number(process.env.COMPANY_LNG);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'COMPANY_LAT و COMPANY_LNG مو مضبوطين بمتغيّرات Railway' });
    }
    try {
      await wa.sendLocation(String(phone), {
        lat, lng,
        name: process.env.COMPANY_NAME || 'هسة',
        address: process.env.COMPANY_ADDRESS || '',
      }, 'agent');
      setBotPaused(phone, true);
      setStatus(phone, 'open');
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.details?.error?.message || e.message });
    }
  });

  /* ── إرسال عقد المتاجر ──
     نفس ملف العقد الأصلي، نعبّي بس اسم المتجر واسم ممثّله */
  app.post('/inbox/api/send-contract', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const { phone } = req.body || {};
    const sealed = req.body?.seal !== false;   // الافتراضي: نسخة مختومة
    if (!phone) return res.status(400).json({ error: 'phone مطلوب' });
    // الأسماء من المحادثة أولاً — الموظف ما يكتبها إلا إذا ما جمعها البوت
    const saved = (get(String(phone)) || {}).store || {};
    const store = req.body?.store || saved.name  || '';
    const owner = req.body?.owner || saved.rep   || '';
    if (!store) return res.status(400).json({ error: 'ماكو اسم متجر محفوظ بهذي المحادثة — اكتبه يدوي' });
    if (!owner) return res.status(400).json({ error: 'ماكو اسم ممثل قانوني محفوظ — اكتبه يدوي' });
    try {
      const contract = require('./contract');
      const pdf  = await contract.fillContract({ store, owner, seal: sealed });
      const name = contract.fileName(store, sealed);
      const id   = await wa.uploadMedia(pdf, 'application/pdf', name);
      await wa.sendDocument(String(phone), id, {
        filename: name,
        caption: sealed
          ? `عقد خدمات — ${contract.clean(store)}`
          : `مسودة عقد للمراجعة — ${contract.clean(store)}`,
        by: 'agent',
      });
      setBotPaused(phone, true);
      setStatus(phone, 'open');
      console.log(`[contract] 📄 ${sealed ? 'مختوم' : 'مسودة'} ${phone} — ${contract.clean(store)}`);
      res.json({ ok: true, file: name, sealed });
    } catch (e) {
      console.error('[inbox] إرسال العقد فشل:', e.message, e.details || '');
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
  record, setStep, markSeen, isBotPaused, setBotPaused, setStore,
  setStatus, addNote, list, get, stats, mount,
};
