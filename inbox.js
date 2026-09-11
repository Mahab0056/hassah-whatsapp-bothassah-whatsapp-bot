/**
 * صندوق الوارد — إنبوكس هسة
 * ------------------------------------------------------------------
 * يخزن كل المحادثات ويعرضها بصفحة ويب محمية بمفتاح.
 *
 *   GET  /inbox?key=...                  ← الصفحة
 *   GET  /inbox/api/threads?key=...      ← قائمة المحادثات
 *   GET  /inbox/api/thread?key=..&phone= ← محادثة وحدة
 *   POST /inbox/api/send                 ← رد الموظف
 *   POST /inbox/api/bot                  ← تشغيل/إيقاف البوت لمحادثة
 *
 * التخزين: بالذاكرة + ملف احتياطي inbox.jsonl
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'inbox.jsonl');
const MAX_MSGS_PER_THREAD = 200;
const MAX_THREADS = 2000;

/** phone → { phone, name, messages[], lastAt, step, unread, botPaused } */
const threads = new Map();

function thread(phone) {
  let t = threads.get(phone);
  if (!t) {
    t = { phone, name: '', messages: [], lastAt: 0, step: '', unread: 0, botPaused: false };
    threads.set(phone, t);
    if (threads.size > MAX_THREADS) {
      const oldest = [...threads.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) threads.delete(oldest.phone);
    }
  }
  return t;
}

function appendFile(rec) {
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8'); } catch { /* لا يهم */ }
}

/**
 * تسجيل رسالة.
 * @param {'in'|'out'} dir
 */
function record(phone, dir, text, meta = {}) {
  const t = thread(phone);
  const rec = {
    phone, dir,
    text: String(text || '').slice(0, 4000),
    at: Date.now(),
    by: meta.by || (dir === 'in' ? 'customer' : 'bot'),
  };
  t.messages.push(rec);
  if (t.messages.length > MAX_MSGS_PER_THREAD) t.messages.shift();
  t.lastAt = rec.at;
  if (meta.step) t.step = meta.step;
  if (meta.name) t.name = meta.name;
  if (dir === 'in') t.unread += 1;
  appendFile(rec);
  return rec;
}

const setStep    = (phone, step) => { thread(phone).step = step; };
const markSeen   = (phone) => { thread(phone).unread = 0; };
const isBotPaused = (phone) => !!threads.get(phone)?.botPaused;
const setBotPaused = (phone, v) => { thread(phone).botPaused = !!v; };

function list() {
  return [...threads.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 300)
    .map((t) => ({
      phone: t.phone,
      name: t.name,
      step: t.step,
      unread: t.unread,
      botPaused: t.botPaused,
      lastAt: t.lastAt,
      last: t.messages.length ? t.messages[t.messages.length - 1].text.slice(0, 80) : '',
      lastDir: t.messages.length ? t.messages[t.messages.length - 1].dir : '',
    }));
}

const get = (phone) => threads.get(phone) || null;

/* ─────────────────────────── الصفحة ─────────────────────────── */

const PAGE = `<!doctype html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>إنبوكس هسة</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#272b34;--txt:#e8eaed;--dim:#9aa0aa;--me:#1f6f4a;--them:#242833;--acc:#2E3350}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Roboto,"Noto Naskh Arabic",sans-serif;background:var(--bg);color:var(--txt);height:100vh;display:flex;flex-direction:column}
header{background:var(--acc);padding:12px 16px;display:flex;align-items:center;gap:10px;flex:0 0 auto}
header h1{margin:0;font-size:16px;font-weight:600}
header .dot{width:8px;height:8px;border-radius:50%;background:#3ddc84}
main{flex:1;display:flex;min-height:0}
#list{width:340px;border-left:1px solid var(--line);overflow-y:auto;flex:0 0 auto;background:var(--panel)}
#chat{flex:1;display:flex;flex-direction:column;min-width:0}
.row{padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover{background:#1e222b}.row.sel{background:#222733}
.row .t{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.row .p{font-weight:600;font-size:14px;direction:ltr;text-align:right}
.row .w{font-size:11px;color:var(--dim);white-space:nowrap}
.row .l{color:var(--dim);font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{background:#3ddc84;color:#04150c;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700}
.tag{display:inline-block;background:#2a2f3a;color:#b9c0cc;border-radius:4px;padding:1px 6px;font-size:11px;margin-top:4px}
#head{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px;flex:0 0 auto}
#head .p{font-weight:600;direction:ltr}
#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.m{max-width:75%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;font-size:14px}
.m.in{background:var(--them);align-self:flex-start;border-bottom-right-radius:4px}
.m.out{background:var(--me);align-self:flex-end;border-bottom-left-radius:4px}
.m .w{display:block;font-size:10px;color:#c9cfd8;opacity:.7;margin-top:4px}
#compose{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line);flex:0 0 auto}
#compose input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--txt);border-radius:20px;padding:10px 16px;font:inherit}
button{background:var(--me);color:#fff;border:0;border-radius:20px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:#2a2f3a;color:#c9cfd8;padding:6px 12px;font-size:13px;border-radius:8px}
.empty{margin:auto;color:var(--dim);text-align:center;padding:40px}
.note{font-size:12px;color:var(--dim);padding:0 12px 10px}
@media(max-width:760px){#list{width:100%;}#list.hide{display:none}#chat.hide{display:none}}
</style></head><body>
<header><span class="dot"></span><h1>إنبوكس هسة</h1><span id="cnt" style="margin-inline-start:auto;font-size:13px;opacity:.8"></span><button id="bell" class="ghost" title="تنبيه صوتي" style="padding:4px 10px;font-size:16px;line-height:1">🔔</button></header>
<main>
  <div id="list"></div>
  <div id="chat" class="hide">
    <div id="head"><span class="p" id="hp">—</span>
      <span><button class="ghost" id="btnBot">إيقاف البوت</button>
      <button class="ghost" id="btnBack">رجوع</button></span></div>
    <div id="msgs"><div class="empty">اختار محادثة</div></div>
    <div class="note" id="note"></div>
    <div id="compose"><input id="txt" placeholder="اكتب ردك..." autocomplete="off"><button id="send">إرسال</button></div>
  </div>
</main>
<script>
const KEY=new URLSearchParams(location.search).get('key')||'';
let cur=null,curData=null;
const $=id=>document.getElementById(id);
const ago=t=>{const s=(Date.now()-t)/1000;if(s<60)return'الآن';if(s<3600)return Math.floor(s/60)+' د';if(s<86400)return Math.floor(s/3600)+' س';return Math.floor(s/86400)+' يوم';};
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const STEPS={STORE_NAME:'🏪 تسجيل متجر',STORE_CATEGORY:'🏪 تسجيل متجر',STORE_AREA:'🏪 تسجيل متجر',STORE_PHOTO_DAY:'📸 موعد تصوير',STORE_PHOTO_TIME:'📸 موعد تصوير',COURIER_NAME:'🛵 تسجيل مندوب',COURIER_BIKE:'🛵 تسجيل مندوب',COURIER_AREA:'🛵 تسجيل مندوب',CUSTOMER_MENU:'🛒 زبون',CUSTOMER_ORDER_NO:'📦 يتابع طلب',CUSTOMER_FAQ:'❓ أسئلة',AGENT:'💬 ينتظر موظف',MENU:'القائمة'};

async function loadList(){
  const r=await fetch('/inbox/api/threads?key='+encodeURIComponent(KEY));
  if(!r.ok){$('list').innerHTML='<div class="empty">مفتاح غير صحيح</div>';return;}
  const d=await r.json();
  $('cnt').textContent=d.threads.length+' محادثة';
  onCounts(d.threads.reduce((n,t)=>n+(t.unread||0),0));
  $('list').innerHTML=d.threads.map(t=>
    '<div class="row'+(t.phone===cur?' sel':'')+'" onclick="open_(\\''+t.phone+'\\')">'+
    '<div class="t"><span class="p">+'+t.phone+'</span><span class="w">'+ago(t.lastAt)+
    (t.unread?' <span class="badge">'+t.unread+'</span>':'')+'</span></div>'+
    '<div class="l">'+(t.lastDir==='out'?'↩ ':'')+esc(t.last||'')+'</div>'+
    (t.step?'<span class="tag">'+(STEPS[t.step]||t.step)+'</span>':'')+
    (t.botPaused?' <span class="tag">البوت متوقف</span>':'')+'</div>').join('')
    ||'<div class="empty">ماكو محادثات بعد</div>';
}
async function open_(p){
  cur=p;
  if(innerWidth<=760){$('list').classList.add('hide');$('chat').classList.remove('hide');}
  else $('chat').classList.remove('hide');
  const r=await fetch('/inbox/api/thread?key='+encodeURIComponent(KEY)+'&phone='+p);
  const t=await r.json();curData=t;
  $('hp').textContent='+'+p;
  $('btnBot').textContent=t.botPaused?'تشغيل البوت':'إيقاف البوت';
  const mins=t.lastInAt?Math.floor((Date.now()-t.lastInAt)/60000):9999;
  $('note').textContent=mins<1440
    ?'نافذة الرد المجاني مفتوحة — تنتهي بعد '+Math.floor((1440-mins)/60)+' ساعة'
    :'⚠️ مرت 24 ساعة على آخر رسالة — الرد يحتاج تمبلت معتمد وراح ينرفض';
  $('msgs').innerHTML=t.messages.map(m=>'<div class="m '+m.dir+'">'+esc(m.text)+
    '<span class="w">'+new Date(m.at).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'})+
    (m.by==='agent'?' · موظف':m.by==='bot'?' · بوت':'')+'</span></div>').join('');
  $('msgs').scrollTop=1e9;loadList();
}
$('btnBack').onclick=()=>{$('list').classList.remove('hide');if(innerWidth<=760)$('chat').classList.add('hide');};
$('btnBot').onclick=async()=>{
  if(!cur)return;
  await fetch('/inbox/api/bot',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:KEY,phone:cur,paused:!curData.botPaused})});
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
let actx=null, lastUnread=null;
$('bell').textContent=soundOn?'🔔':'🔕';
$('bell').onclick=()=>{
  soundOn=!soundOn;
  $('bell').textContent=soundOn?'🔔':'🔕';
  try{localStorage.setItem('hsaSound',soundOn?'1':'0');}catch(e){}
  if(soundOn)chime();
};
/* المتصفح يمنع الصوت قبل أول لمسة — نفكّه بأول تفاعل */
['click','keydown','touchstart'].forEach(ev=>addEventListener(ev,function unlock(){
  try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume();}catch(e){}
  removeEventListener(ev,unlock);
},{once:true}));

function chime(){
  if(!soundOn)return;
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended')actx.resume();
    const t=actx.currentTime;
    /* نغمتين ناعمتين — مثل جرس خفيف، مو إزعاج */
    [[880,0,0.22],[1318.51,0.11,0.18]].forEach(([f,d,v])=>{
      const o=actx.createOscillator(), g=actx.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0,t+d);
      g.gain.linearRampToValueAtTime(v,t+d+0.012);
      g.gain.exponentialRampToValueAtTime(0.0001,t+d+0.55);
      o.connect(g); g.connect(actx.destination);
      o.start(t+d); o.stop(t+d+0.6);
    });
  }catch(e){}
}

function onCounts(total){
  /* أول تحميل ما ينبّه — بس الزيادة الجديدة */
  if(lastUnread!==null && total>lastUnread){
    chime();
    try{
      if(!document.hasFocus() && Notification && Notification.permission==='granted')
        new Notification('رسالة جديدة — إنبوكس هسة',{body:'عندك '+total+' رسالة غير مقروءة'});
    }catch(e){}
  }
  lastUnread=total;
  document.title=(total?'('+total+') ':'')+'إنبوكس هسة';
}
try{ if(window.Notification && Notification.permission==='default')
  $('bell').addEventListener('click',()=>Notification.requestPermission(),{once:true}); }catch(e){}

loadList();setInterval(()=>{loadList();if(cur&&document.hasFocus())open_(cur);},5000);
</script></body></html>`;

/* ─────────────────────────── التركيب ─────────────────────────── */

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
    res.json({ threads: list() });
  });

  app.get('/inbox/api/thread', (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'مفتاح غير صحيح' });
    const t = get(String(req.query.phone || ''));
    if (!t) return res.json({ messages: [] });
    markSeen(t.phone);
    const lastIn = [...t.messages].reverse().find((m) => m.dir === 'in');
    res.json({
      phone: t.phone, step: t.step, botPaused: t.botPaused,
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
}

module.exports = { record, setStep, markSeen, isBotPaused, setBotPaused, list, get, mount };
