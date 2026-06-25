/* ===================================================================
   OUR CORNER v2 — core.js
   Foundation: swappable storage adapter, auth, per-account cache.

   ┌─────────────────────────────────────────────────────────────┐
   │  SECURITY WARNING — READ THIS                                 │
   │  This is a STATIC, browser-only app. The "login" and SHA-256  │
   │  password hashing here are NOT real security. Everything —    │
   │  accounts, hashes, every couple's messages and photos — lives │
   │  in THIS browser's IndexedDB. Anyone with dev tools can read  │
   │  it. Accounts are NOT synced between devices, and NOT private │
   │  from a technical person sharing the same device/deployment.  │
   │  Fine for a personal prototype. For real privacy (especially  │
   │  intimate content) you need a backend: Supabase / Firebase /  │
   │  your own server. See swap instructions at bottom of file.    │
   └─────────────────────────────────────────────────────────────┘

   ── HOW THE "SWAP A BACKEND IN LATER" DESIGN WORKS ──
   Every read/write in the entire app goes through `Store` (below).
   `Store` delegates to an ADAPTER object that implements a fixed
   interface (init, allAccounts, putAccount, loadAccount, saveAccount,
   blobPut, blobGet, blobDel). Today the active adapter is
   `IndexedDBAdapter`. To move to a real backend you implement that
   same interface against Supabase/Firebase in a new adapter object
   and set `const ACTIVE_ADAPTER = SupabaseAdapter`. No page/UI code
   changes — they only ever call Store.* and Auth.*.
   =================================================================== */
'use strict';

/* ---------- password hashing (prototype only) ---------- */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function uid(prefix='id') { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

/* ===================================================================
   ADAPTER INTERFACE (the swap seam)
   Any adapter must implement:
     async init()                         -> opens/prepares storage
     async allAccounts()                  -> [accountRecord, ...]
     async putAccount(acct)               -> upsert one account record
     async deleteAccountHard(accountId)   -> remove account + its data
     async loadAccount(accountId)         -> { ...allDataBlobForAccount }
     async saveAccount(accountId, dataObj)-> persist that data blob
     async blobPut(accountId, key, b64)   -> store one large media blob
     async blobGet(accountId, key)        -> retrieve one media blob
     async blobDel(accountId, key)        -> delete one media blob
   =================================================================== */

const IndexedDBAdapter = (() => {
  const DB_NAME = 'OurCornerDB';
  const DB_VERSION = 1;
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        // accounts: one record per couple (admin-managed)
        if (!d.objectStoreNames.contains('accounts'))
          d.createObjectStore('accounts', { keyPath: 'accountId' });
        // data: one JSON blob per account holding all small/structured data
        if (!d.objectStoreNames.contains('data'))
          d.createObjectStore('data', { keyPath: 'accountId' });
        // media: large photo/drawing/voice blobs, keyed "accountId::mediaKey"
        if (!d.objectStoreNames.contains('media'))
          d.createObjectStore('media', { keyPath: 'k' });
        // meta: admin credentials, app-level flags
        if (!d.objectStoreNames.contains('meta'))
          d.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(store, mode='readonly') { return db.transaction(store, mode).objectStore(store); }
  function pReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  return {
    async init() { if (!db) db = await open(); return true; },

    // meta (admin creds etc.)
    async metaGet(k) { const r = await pReq(tx('meta').get(k)); return r ? r.v : null; },
    async metaSet(k, v) { await pReq(tx('meta','readwrite').put({ k, v })); },

    async allAccounts() { return (await pReq(tx('accounts').getAll())) || []; },
    async putAccount(acct) { await pReq(tx('accounts','readwrite').put(acct)); },
    async deleteAccountHard(accountId) {
      await pReq(tx('accounts','readwrite').delete(accountId));
      await pReq(tx('data','readwrite').delete(accountId));
      // purge media for this account
      const all = await pReq(tx('media').getAllKeys());
      const mine = all.filter(k => String(k).startsWith(accountId + '::'));
      await Promise.all(mine.map(k => pReq(tx('media','readwrite').delete(k))));
    },

    async loadAccount(accountId) {
      const r = await pReq(tx('data').get(accountId));
      return r ? r.data : {};
    },
    async saveAccount(accountId, dataObj) {
      await pReq(tx('data','readwrite').put({ accountId, data: dataObj }));
    },

    async blobPut(accountId, key, b64) {
      await pReq(tx('media','readwrite').put({ k: accountId + '::' + key, v: b64 }));
    },
    async blobGet(accountId, key) {
      const r = await pReq(tx('media').get(accountId + '::' + key));
      return r ? r.v : null;
    },
    async blobDel(accountId, key) {
      await pReq(tx('media','readwrite').delete(accountId + '::' + key));
    },
    async blobBytesForAccount(accountId) {
      const all = await pReq(tx('media').getAll());
      return all.filter(x => String(x.k).startsWith(accountId + '::'))
                .reduce((n, x) => n + (x.v ? x.v.length : 0), 0);
    }
  };
})();

/* ── To swap in Supabase later, implement an object with the SAME methods:
   const SupabaseAdapter = { async init(){...}, async allAccounts(){...}, ... };
   then change the next line. Nothing else in the app needs editing.        */
/* ===================================================================
   OUR CORNER — supabase-adapter.js
   Drop-in backend that makes the app SYNC across devices.
   Implements the same interface as IndexedDBAdapter, so no page/UI
   code changes — only the ACTIVE_ADAPTER line below switches over.

   Storage model (per your choice: one row per data key):
     • accounts        -> (account_id, username, data jsonb)   one row/couple
     • account_data    -> (account_id, key, value jsonb)       one row/key
   Media (photos/drawings, base64) live in account_data under keys
   prefixed "media::". Admin creds live under account_id '__meta__'.

   SECURITY NOTE (unchanged): login logic is in the browser and the
   publishable key is public, so this is app-level access, not true
   per-couple isolation. Fine for friends; not airtight for secrets.
   =================================================================== */
'use strict';

const SUPABASE_URL = 'https://mkurdowpyvdvahmplmta.supabase.co';
const SUPABASE_KEY = 'sb_publishable_36A4z6wkzP5Oq0GIhLxzjw_xjbPWEPu';

const _lastLoaded = {};
const SupabaseAdapter = (() => {
  const REST = SUPABASE_URL + '/rest/v1';
  const HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  const META_ID = '__meta__';

  async function sb(path, opts = {}) {
    const res = await fetch(REST + path, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Supabase ' + res.status + ': ' + txt);
    }
    if (res.status === 204) return null;
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  // upsert one (account_id,key,value) row
  async function putRow(accountId, key, value) {
    await sb('/account_data?on_conflict=account_id,key', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ account_id: accountId, key, value }])
    });
  }
  async function getRow(accountId, key) {
    const rows = await sb('/account_data?account_id=eq.' + encodeURIComponent(accountId) +
                          '&key=eq.' + encodeURIComponent(key) + '&select=value');
    return rows && rows.length ? rows[0].value : null;
  }
  async function delRow(accountId, key) {
    await sb('/account_data?account_id=eq.' + encodeURIComponent(accountId) +
             '&key=eq.' + encodeURIComponent(key),
             { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
  }

  return {
    async init() { return true; },

    /* ---- admin creds / app meta (stored as one row under __meta__) ---- */
    async metaGet(k) { return await getRow(META_ID, k); },
    async metaSet(k, v) { await putRow(META_ID, k, v); },

    /* ---- accounts ---- */
    async allAccounts() {
      const rows = await sb('/accounts?select=data&order=username');
      return (rows || []).map(r => r.data).filter(Boolean);
    },
    async putAccount(acct) {
      await sb('/accounts?on_conflict=account_id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ account_id: acct.accountId, username: acct.username, data: acct }])
      });
    },
    async deleteAccountHard(accountId) {
      await sb('/account_data?account_id=eq.' + encodeURIComponent(accountId),
               { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
      await sb('/accounts?account_id=eq.' + encodeURIComponent(accountId),
               { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
    },

    /* ---- per-account structured data (one row per key) ---- */
    async loadAccount(accountId) {
      const rows = await sb('/account_data?account_id=eq.' + encodeURIComponent(accountId) +
                            '&select=key,value');
      const out = {};
      (rows || []).forEach(r => { if (!String(r.key).startsWith('media::')) out[r.key] = r.value; });
      // remember what we loaded so saveAccount only writes changed keys
      _lastLoaded[accountId] = JSON.stringify(out);
      return out;
    },
    async saveAccount(accountId, dataObj) {
      // diff against last snapshot; upsert only changed keys
      let prev = {};
      try { prev = JSON.parse(_lastLoaded[accountId] || '{}'); } catch {}
      const tasks = [];
      for (const k of Object.keys(dataObj)) {
        if (JSON.stringify(dataObj[k]) !== JSON.stringify(prev[k]))
          tasks.push(putRow(accountId, k, dataObj[k]));
      }
      for (const k of Object.keys(prev)) {
        if (!(k in dataObj)) tasks.push(delRow(accountId, k));
      }
      await Promise.all(tasks);
      _lastLoaded[accountId] = JSON.stringify(dataObj);
    },

    /* ---- media blobs (base64) stored as account_data rows ---- */
    async blobPut(accountId, key, b64) { await putRow(accountId, 'media::' + key, b64); },
    async blobGet(accountId, key) { return await getRow(accountId, 'media::' + key); },
    async blobDel(accountId, key) { await delRow(accountId, 'media::' + key); },
    async blobBytesForAccount(accountId) {
      const rows = await sb('/account_data?account_id=eq.' + encodeURIComponent(accountId) +
                            '&key=like.media::*&select=value');
      return (rows || []).reduce((n, r) => n + (r.value ? String(r.value).length : 0), 0);
    }
  };
})();


/* ===== Backend switched to Supabase (sync across devices) ===== */
const ACTIVE_ADAPTER = SupabaseAdapter;

/* ===================================================================
   Store — what the whole app actually calls.
   Hydrates the current account's data blob into a synchronous in-memory
   cache on login (so the existing page code can read it synchronously),
   and writes through to the adapter asynchronously on every change.
   =================================================================== */
const Store = {
  _cache: {},          // current account's structured data (in memory)
  _accountId: null,
  _saveTimer: null,

  adapter: ACTIVE_ADAPTER,
  async init() { await this.adapter.init(); },

  // ---- account session ----
  async use(accountId) {
    this._accountId = accountId;
    this._cache = (await this.adapter.loadAccount(accountId)) || {};
  },
  clear() { this._cache = {}; this._accountId = null; },
  get accountId() { return this._accountId; },

  // ---- synchronous structured reads/writes (mirror old DB.get/DB.set) ----
  get(key, fallback) {
    return (key in this._cache) ? this._cache[key] : fallback;
  },
  set(key, val) {
    this._cache[key] = val;
    this._flushSoon();
    return true;
  },
  _flushSoon() {
    clearTimeout(this._saveTimer);
    const id = this._accountId, snapshot = this._cache;
    this._saveTimer = setTimeout(() => {
      if (id) this.adapter.saveAccount(id, snapshot).catch(()=>{});
    }, 150);
  },
  async flushNow() {
    if (this._accountId) await this.adapter.saveAccount(this._accountId, this._cache);
  },

  // ---- media blobs (photos etc.) ----
  async putMedia(key, b64) { return this.adapter.blobPut(this._accountId, key, b64); },
  async getMedia(key) { return this.adapter.blobGet(this._accountId, key); },
  async delMedia(key) { return this.adapter.blobDel(this._accountId, key); },

  // ---- account management (admin) ----
  async allAccounts() { return this.adapter.allAccounts(); },
  async putAccount(a) { return this.adapter.putAccount(a); },
  async deleteAccountHard(id) { return this.adapter.deleteAccountHard(id); },
  async storageUsedMB(accountId) {
    const blob = (await this.adapter.loadAccount(accountId)) || {};
    const structBytes = JSON.stringify(blob).length;
    const mediaBytes = await this.adapter.blobBytesForAccount(accountId);
    return +((structBytes + mediaBytes) / (1024*1024)).toFixed(2);
  }
};

/* ===================================================================
   Auth — admin + couple login. Swappable the same way (it only uses
   Store/adapter meta + accounts). Session kept in sessionStorage so a
   refresh stays logged in but closing the tab logs out (Remember Me
   promotes it to localStorage).
   =================================================================== */
const Auth = {
  SESSION_KEY: 'ourCorner_session',

  async ensureAdmin() {
    // First run: create default admin (admin / admin123) — must change.
    let cred = await ACTIVE_ADAPTER.metaGet('admin');
    if (!cred) {
      cred = { username: 'admin', passwordHash: await sha256('admin123'), mustChange: true };
      await ACTIVE_ADAPTER.metaSet('admin', cred);
    }
    return cred;
  },
  async adminLogin(username, password) {
    const cred = await this.ensureAdmin();
    const ok = username === cred.username && (await sha256(password)) === cred.passwordHash;
    if (ok) this._setSession({ role: 'admin', username }, true);
    return ok;
  },
  async setAdminPassword(newPass) {
    const cred = await this.ensureAdmin();
    cred.passwordHash = await sha256(newPass); cred.mustChange = false;
    await ACTIVE_ADAPTER.metaSet('admin', cred);
  },

  async coupleLogin(username, password, remember) {
    const accts = await Store.allAccounts();
    const a = accts.find(x => x.username === username && x.status === 'active');
    if (!a) return null;
    if ((await sha256(password)) !== a.passwordHash) return null;
    a.lastLogin = new Date().toISOString();
    await Store.putAccount(a);
    this._setSession({ role: 'couple', accountId: a.accountId, username }, remember);
    return a;
  },

  _setSession(sess, persist) {
    const s = JSON.stringify(sess);
    sessionStorage.setItem(this.SESSION_KEY, s);
    if (persist) localStorage.setItem(this.SESSION_KEY, s);
  },
  session() {
    try {
      return JSON.parse(sessionStorage.getItem(this.SESSION_KEY)
        || localStorage.getItem(this.SESSION_KEY) || 'null');
    } catch { return null; }
  },
  logout() {
    sessionStorage.removeItem(this.SESSION_KEY);
    localStorage.removeItem(this.SESSION_KEY);
    Store.clear();
  }
};
/* ===================================================================
   OUR CORNER — app.js
   Vanilla JS SPA. All state in localStorage. No backend.
   =================================================================== */
'use strict';

/* ===== MULTI-ACCOUNT NAME HELPERS (added in v3) =====
   Internal role slots stay 'luke'(his)/'sophie'(her); only DISPLAY uses real names. */
function HIS(){ return (window.App&&App.account&&App.account.hisName)||'Him'; }
function HER(){ return (window.App&&App.account&&App.account.herName)||'Her'; }
function NAME(who){ return who==='luke'?HIS():HER(); }


/* ---------- Storage helpers ---------- */
/* DB now delegates to the account-namespaced Store (swap-safe). Same get/set API,
   so none of the feature code below needed changing. */
const DB = {
  get(key, fallback) { return Store.get(key, fallback); },
  set(key, val) { return Store.set(key, val); }
};
const K = {
  messages:'ourCorner_messages', diary:'ourCorner_diary', countdowns:'ourCorner_countdowns',
  streaks:'ourCorner_streaks', moods:'ourCorner_moods', potd:'ourCorner_photoOfDay',
  pet:'ourCorner_pet', drawings:'ourCorner_drawings', photos:'ourCorner_photos',
  games:'ourCorner_games', prayers:'ourCorner_prayers', settings:'ourCorner_settings',
  questions:'ourCorner_questions', activity:'ourCorner_activity', dates:'ourCorner_dates',
  customQuestions:'ourCorner_customQuestions',
  story:'ourCorner_story', gratitude:'ourCorner_gratitude',
  start:'ourCorner_startDate'
};

/* ---------- Tiny DOM helpers ---------- */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const todayStr = () => new Date().toISOString().slice(0,10);
const now = () => Date.now();

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

/* ---------- Activity feed ---------- */
function logActivity(text) {
  const a = DB.get(K.activity, []);
  a.unshift({ text, t: now() });
  DB.set(K.activity, a.slice(0, 30));
  renderActivity();
}
function renderActivity() {
  const a = DB.get(K.activity, []).slice(0, 5);
  const el = $('#activityFeed');
  if (!a.length) { el.innerHTML = '<li class="muted">No activity yet — start exploring! 💕</li>'; return; }
  el.innerHTML = a.map(x => `<li>${escapeHtml(x.text)} · <span class="muted">${timeAgo(x.t)}</span></li>`).join('');
}
function timeAgo(t) {
  const s = Math.floor((now()-t)/1000);
  if (s<60) return 'just now';
  if (s<3600) return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function escapeHtml(str='') {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- Settings / personalization ---------- */
function getSettings() {
  return DB.get(K.settings, {
    petName:'Our Puppy', lukeAvatar:'🦂', sophieAvatar:'🌸',
    notify:false, night:false, lukeCity:'', sophieCity:''
  });
}
function saveSettings(s) { DB.set(K.settings, s); }

/* ---------- Navigation ---------- */
function go(page) {
  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $('#page-' + page);
  if (target) { target.classList.add('active'); window.scrollTo(0,0); }
  // lazy-render per page
  if (page === 'home') renderDashboard();
  if (page === 'messages') { renderMessages(); }
  if (page === 'diary') renderDiary();
  if (page === 'questions') renderQuestion();
  if (page === 'game-wyr') renderWYR();
  if (page === 'game-memory') startMemoryOrResume();
  if (page === 'game-war') initWar(true);
  if (page === 'game-checkers') renderCheckers();
  if (page === 'game-story') renderStoryWriting();
  if (page === 'gratitude') renderGratitude();
  if (page === 'calendar') renderPhotoCalendar();
  if (page === 'pet') renderPet();
  if (page === 'dates') renderDates();
  if (page === 'draw') initDrawCanvas();
  if (page === 'gallery') renderGallery();
  if (page === 'stats') renderStats();
  if (page === 'prayer') renderPrayer();
  if (page === 'map') renderMap();
  if (page === 'settings') renderSettingsPage();
}
document.addEventListener('click', e => {
  const goEl = e.target.closest('[data-go]');
  if (goEl) { go(goEl.dataset.go); }
});

/* ===================================================================
   DASHBOARD
   =================================================================== */
function greetingText() {
  const h = new Date().getHours();
  if (h < 12)  return ['Good morning', '☀️'];
  if (h < 18)  return ['Good afternoon', '🌤️'];
  return ['Good evening', '🌙'];
}
function renderDashboard() {
  const [g, emoji] = greetingText();
  $('#greeting').textContent = `${g}, ${HIS()} & ${HER()}! ${emoji}`;
  $('#dateline').textContent = new Date().toLocaleDateString(undefined,
    { weekday:'long', month:'long', day:'numeric' });
  renderPOTD();
  renderMoodPicker();
  renderCountdowns();
  renderStreaks();
  renderActivity();
}

/* ---------- Photo of the Day (multi-update, preserves history) ---------- */
function potdUploaderName(who) { return who==='luke' ? HIS() : who==='sophie' ? HER() : 'Someone'; }
function potdTimeStr(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }); }
  catch { return ''; }
}
function renderPOTD() {
  const data = DB.get(K.potd, null);
  const img = $('#potdImg'), empty = $('#potdEmpty'), cap = $('#potdCaption');
  const edit = $('#potdEdit'), meta = $('#potdMeta');
  if (data && data.img) {
    img.src = data.img; img.hidden = false; empty.style.display = 'none';
    cap.value = data.caption || '';
    if (edit) edit.hidden = false;
    if (meta) {
      if (data.uploadedBy || data.uploadedAt) {
        meta.hidden = false;
        const by = data.uploadedBy ? `Uploaded by ${potdUploaderName(data.uploadedBy)}` : 'Uploaded';
        const at = data.uploadedAt ? ` at ${potdTimeStr(data.uploadedAt)}` : '';
        meta.textContent = by + at;
      } else meta.hidden = true;
    }
  } else {
    img.hidden = true; empty.style.display = 'block'; cap.value = '';
    if (edit) edit.hidden = true;
    if (meta) meta.hidden = true;
  }
}

/* Move the CURRENT photo-of-the-day into the gallery so it's never lost. */
function archiveCurrentPOTD() {
  const cur = DB.get(K.potd, null);
  if (!cur || !cur.img) return;
  const photos = DB.get(K.photos, []);
  const dateStr = cur.date || todayStr();
  photos.unshift({
    id: cur.uploadedAt || now(),
    img: cur.img,
    caption: cur.caption || '',
    fav: false,
    folder: 'photoOfDay',
    tags: ['Photo of the Day - ' + dateStr],
    isPhotoOfDay: false,           // it WAS, but is now archived
    photoOfDayDate: dateStr,
    uploadedBy: cur.uploadedBy || null,
    uploadedAt: cur.uploadedAt || now(),
    t: cur.uploadedAt || now()
  });
  DB.set(K.photos, photos.slice(0, 200));
}

/* Open the upload flow (used by + , by Edit, and by tapping empty frame). */
function potdStartUpload() { $('#potdInput').click(); }

$('#potdFrame').addEventListener('click', (e) => {
  // Edit button handled separately; tapping the photo opens full-screen,
  // tapping the empty frame starts an upload.
  if (e.target.closest('#potdEdit')) return;
  const data = DB.get(K.potd, null);
  if (data && data.img) openLightbox([{img:data.img, caption:data.caption}], 0);
  else potdStartUpload();
});
const _potdEditBtn = $('#potdEdit');
if (_potdEditBtn) _potdEditBtn.addEventListener('click', (e) => { e.stopPropagation(); potdStartUpload(); });

$('#potdInput').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  compressImage(file, 800, dataUrl => {
    // preserve the previous photo of the day into the gallery first
    archiveCurrentPOTD();
    const who = (typeof deviceWho === 'function' ? deviceWho() : null);
    DB.set(K.potd, {
      img: dataUrl, caption: '', date: todayStr(),
      uploadedBy: who, uploadedAt: now()
    });
    renderPOTD();
    bumpStreak('photo');
    logActivity(`📸 ${potdUploaderName(who)} set a new Photo of the Day`);
    toast('Photo of the Day updated! 📸');
    e.target.value = ''; // allow re-selecting the same file again later
  });
});
$('#potdCaption').addEventListener('change', e => {
  const data = DB.get(K.potd, null); if (!data) return;
  data.caption = e.target.value; DB.set(K.potd, data);
});

/* ---------- Photo of the Day: history ---------- */
function potdHistory() {
  const photos = DB.get(K.photos, []).filter(p => p.folder === 'photoOfDay');
  const cur = DB.get(K.potd, null);
  const list = [];
  if (cur && cur.img) list.push({
    img: cur.img, caption: cur.caption || '', current: true,
    photoOfDayDate: cur.date || todayStr(), uploadedBy: cur.uploadedBy, uploadedAt: cur.uploadedAt
  });
  return list.concat(photos);
}
const _potdHistBtn = $('#potdHistoryBtn');
if (_potdHistBtn) _potdHistBtn.addEventListener('click', () => {
  const hist = potdHistory();
  openModal(`
    <h3>📸 Photo of the Day History</h3>
    ${hist.length ? `<div class="potd-history-grid">${hist.map((p,i)=>`
      <div class="potd-hist-cell" data-poth="${i}">
        <img src="${p.img}" alt="">
        ${p.current?'<span class="poth-badge">Today</span>':''}
        <div class="poth-info">
          <span class="poth-date">${p.photoOfDayDate||''}</span>
          <span class="poth-by">${p.uploadedBy?potdUploaderName(p.uploadedBy):''}</span>
        </div>
      </div>`).join('')}</div>`
      : '<p class="muted">No photo-of-the-day history yet. Upload one to start! 📸</p>'}
    <div class="modal-actions"><button class="pill-btn" data-close>Close</button></div>
  `);
  const imgs = hist.map(p=>({img:p.img, caption:p.caption||''}));
  $$('#modal [data-poth]').forEach(c=>c.addEventListener('click', ()=>openLightbox(imgs, +c.dataset.poth)));
});

/* ---------- Mood picker ---------- */
const MOODS = [
  ['😌','Relaxed'],['🌟','Amazing'],['🤩','Excited'],['😊','Happy'],['🙏','Grateful'],
  ['😏','Flirty'],['🤗','Cuddly'],['🥺','Cute'],['😢','Sad'],['😰','Stressed'],
  ['😴','Tired'],['🔥','Fired Up'],['🥳','Celebratory'],['💫','Inspired'],['🌈','Optimistic'],
  ['😎','Confident'],['😘','Romantic'],['🥰','Adoring'],['💞','Passionate'],['😐','Neutral'],
  ['🧘','Peaceful'],['🍃','Chill'],['😤','Frustrated'],['😠','Angry'],['😨','Anxious'],
  ['😵','Overwhelmed'],['😔','Lonely'],['😜','Silly'],['🤪','Goofy'],['😹','Playful'],['🎉','Energetic']
];
let moodWho = 'luke';
function renderMoodPicker() {
  const scroll = $('#moodScroll');
  const moods = DB.get(K.moods, {});
  const current = moods[moodWho]?.date === todayStr() ? moods[moodWho].mood : null;
  scroll.innerHTML = MOODS.map(([e,l]) =>
    `<div class="mood-item ${current===l?'active':''}" data-mood="${l}" data-emoji="${e}">
       <div class="mood-emoji">${e}</div><div class="mood-label">${l}</div></div>`).join('');
  updateMoodStatus();
}
function updateMoodStatus() {
  const s = getSettings();
  const moods = DB.get(K.moods, {});
  const lk = moods.luke?.date === todayStr() ? moods.luke : null;
  const sp = moods.sophie?.date === todayStr() ? moods.sophie : null;
  let txt = `${s.lukeAvatar||'🦂'} ${HIS()}: ${lk?`${lk.emoji} ${lk.mood}`:'—'}  |  ${s.sophieAvatar||'🌸'} ${HER()}: ${sp?`${sp.emoji} ${sp.mood}`:'—'}`;
  if (lk && sp) txt += lk.mood === sp.mood ? '  ·  Perfect match! 💞' : '  ·  Different vibes today 💕';
  $('#moodStatus').textContent = txt;
}
$('#moodScroll').addEventListener('click', e => {
  const item = e.target.closest('.mood-item'); if (!item) return;
  const moods = DB.get(K.moods, {});
  moods[moodWho] = { mood:item.dataset.mood, emoji:item.dataset.emoji, date:todayStr() };
  DB.set(K.moods, moods);
  // mood history for chart
  const hist = DB.get('ourCorner_moodHist', []);
  hist.push({ who:moodWho, mood:item.dataset.mood, date:todayStr(), t:now() });
  DB.set('ourCorner_moodHist', hist.slice(-60));
  $$('.mood-item').forEach(m => m.classList.remove('active'));
  item.classList.add('active');
  item.querySelector('.mood-emoji').classList.add('pop');
  setTimeout(()=>item.querySelector('.mood-emoji').classList.remove('pop'),400);
  updateMoodStatus();
  syncPetMood();
  logActivity(`${NAME(moodWho)} feels ${item.dataset.mood}`);
});
$('#moodWhoToggle').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  moodWho = btn.dataset.who;
  $$('#moodWhoToggle button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderMoodPicker();
});

/* ---------- Countdowns ---------- */
function renderCountdowns() {
  const list = DB.get(K.countdowns, []);
  const el = $('#countdownScroll');
  if (!list.length) { el.innerHTML = '<p class="empty-inline">No countdowns yet — tap ＋ 💕</p>'; return; }
  el.innerHTML = list.map(c => {
    const diff = new Date(c.date) - new Date();
    let big;
    if (diff <= 0) big = '🎉 It\'s here!';
    else {
      const d = Math.floor(diff/86400000);
      const h = Math.floor(diff%86400000/3600000);
      const m = Math.floor(diff%3600000/60000);
      big = `${d}<small>d</small> ${h}<small>h</small> ${m}<small>m</small>`;
    }
    return `<div class="countdown-card">
      <button class="cd-del" data-id="${c.id}">✕</button>
      <h4>${escapeHtml(c.title)}</h4>
      <div class="countdown-big">${big}</div></div>`;
  }).join('');
}
$('#countdownScroll').addEventListener('click', e => {
  const del = e.target.closest('.cd-del'); if (!del) return;
  let list = DB.get(K.countdowns, []).filter(c => c.id != del.dataset.id);
  DB.set(K.countdowns, list); renderCountdowns();
});
$('#addCountdown').addEventListener('click', () => {
  openModal(`<h3>⏳ New Countdown</h3>
    <input type="text" id="cdTitle" placeholder="Title (e.g. Next Visit)" />
    <input type="datetime-local" id="cdDate" />
    <div class="modal-actions">
      <button class="pill-btn ghost" data-close>Cancel</button>
      <button class="pill-btn" id="cdSave">Add</button></div>`);
  $('#cdSave').addEventListener('click', () => {
    const title = $('#cdTitle').value.trim(), date = $('#cdDate').value;
    if (!title || !date) { toast('Add a title and date 💕'); return; }
    const list = DB.get(K.countdowns, []);
    list.push({ id:now(), title, date });
    DB.set(K.countdowns, list); closeModal(); renderCountdowns();
    logActivity(`⏳ Added countdown: ${title}`);
  });
});

/* ---------- Streaks ---------- */
const STREAK_DEFS = [
  ['bible','📖 Bible Reading'], ['pray','🙏 Praying Together'],
  ['photo','📸 New Photo'], ['questions','💬 Daily Questions'], ['draw','🎨 Drew for Each Other']
];
function getStreaks() {
  return DB.get(K.streaks, { bible:{count:0,last:''}, pray:{count:0,last:''},
    photo:{count:0,last:''}, questions:{count:0,last:''}, draw:{count:0,last:''} });
}
function bumpStreak(key) {
  const s = getStreaks();
  if (!s[key]) s[key] = {count:0,last:''};
  const today = todayStr();
  if (s[key].last === today) return;          // already counted today
  const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
  s[key].count = (s[key].last === yesterday) ? s[key].count+1 : 1;
  s[key].last = today;
  DB.set(K.streaks, s);
  renderStreaks();
}
function renderStreaks() {
  const s = getStreaks();
  $('#streakList').innerHTML = STREAK_DEFS.map(([k,label]) => {
    const c = s[k]?.count || 0;
    const pct = Math.min(100, c*10);
    return `<div class="streak-item" data-streak="${k}">
      <div class="streak-row"><span>${label}</span><span>${c}-day ${c>0?'🔥':''}</span></div>
      <div class="streak-bar"><div class="streak-fill" style="width:${pct}%"></div></div></div>`;
  }).join('');
}
$('#streakList').addEventListener('click', e => {
  const item = e.target.closest('.streak-item'); if (!item) return;
  const s = getStreaks(); const d = s[item.dataset.streak];
  openModal(`<h3>Streak history</h3>
    <p style="font-size:14px;line-height:1.6">Current streak: <b>${d.count} days</b> 🔥<br>
    Last logged: ${d.last||'never'}<br><br>
    ${d.count>0 ? '✅ '.repeat(Math.min(d.count,14)) : 'Start today! 💕'}</p>
    <div class="modal-actions"><button class="pill-btn" data-close>Close</button></div>`);
});

/* ===================================================================
   MESSAGES
   =================================================================== */
let msgWho = 'luke';
function renderMessages(filter='') {
  const msgs = DB.get(K.messages, []);
  const s = getSettings();
  const list = $('#msgList');
  const filtered = filter
    ? msgs.filter(m => (m.text||'').toLowerCase().includes(filter.toLowerCase()))
    : msgs;
  // pinned first
  const sorted = [...filtered].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || a.t-b.t);
  if (!sorted.length) { list.innerHTML = '<p class="empty-inline" style="text-align:center">No messages yet 💌</p>'; return; }
  list.innerHTML = sorted.map(m => {
    const av = m.who==='luke' ? s.lukeAvatar : s.sophieAvatar;
    const name = m.who==='luke' ? HIS() : HER();
    return `<div class="msg-bubble ${m.who}">
      <span class="msg-pin ${m.pinned?'pinned':''}" data-pin="${m.id}">📌</span>
      <div class="msg-meta">${av} ${name} · ${new Date(m.t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
      ${m.text ? `<div class="msg-text">${escapeHtml(m.text)}</div>` : ''}
      ${m.img ? `<img src="${m.img}" data-img="${m.id}" />` : ''}
      ${m.audio ? `<audio controls src="${m.audio}"></audio>` : ''}
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}
function addMessage(obj) {
  const msgs = DB.get(K.messages, []);
  msgs.push(Object.assign({ id:now(), t:now(), who:msgWho, pinned:false }, obj));
  DB.set(K.messages, msgs);
  renderMessages($('#msgSearch').value);
  logActivity(`💌 ${NAME(msgWho)} sent a message`);
}
$('#msgSend').addEventListener('click', () => {
  const txt = $('#msgInput').value.trim();
  if (!txt) return;
  addMessage({ text: txt });
  $('#msgInput').value = ''; $('#msgInput').style.height = 'auto';
});
$('#msgInput').addEventListener('input', e => {
  e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px';
});
$('#msgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#msgSend').click(); }
});
$('#msgWho').addEventListener('click', () => {
  const s = getSettings();
  msgWho = msgWho === 'luke' ? 'sophie' : 'luke';
  $('#msgWho').textContent = msgWho === 'luke' ? s.lukeAvatar : s.sophieAvatar;
});
$('#msgPhotoBtn').addEventListener('click', () => $('#msgPhotoInput').click());
$('#msgPhotoInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  compressImage(f, 700, url => addMessage({ img:url }));
});
$('#msgSearch').addEventListener('input', e => renderMessages(e.target.value));
$('#msgList').addEventListener('click', e => {
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const msgs = DB.get(K.messages, []);
    const m = msgs.find(x => x.id == pin.dataset.pin);
    if (m) { m.pinned = !m.pinned; DB.set(K.messages, msgs); renderMessages($('#msgSearch').value); }
    return;
  }
  const img = e.target.closest('[data-img]');
  if (img) openLightbox([{img:img.src, caption:''}], 0);
});

/* ---------- Voice notes ---------- */
let mediaRecorder, audioChunks=[];
$('#msgVoiceBtn').addEventListener('click', async () => {
  const btn = $('#msgVoiceBtn');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); return;
  }
  if (!navigator.mediaDevices?.getUserMedia) { toast('Voice not supported here 🎙️'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = ev => audioChunks.push(ev.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t=>t.stop());
      btn.classList.remove('recording');
      const blob = new Blob(audioChunks, { type:'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => addMessage({ audio: reader.result });
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    btn.classList.add('recording');
    toast('Recording… tap 🎙️ to stop');
  } catch { toast('Mic permission denied 🎙️'); }
});

/* ===================================================================
   DIARY
   =================================================================== */
function renderDiary() {
  const entries = DB.get(K.diary, []).sort((a,b)=>b.t-a.t);
  const list = $('#diaryList');
  if (!entries.length) { list.innerHTML = '<p class="empty-inline" style="text-align:center">No entries yet — write your first 📖</p>'; return; }
  list.innerHTML = entries.map(en => `
    <div class="diary-entry">
      <div class="d-date">${new Date(en.t).toLocaleString([], {weekday:'short',month:'short',day:'numeric',year:'numeric'})}</div>
      ${en.title ? `<div class="d-title">${escapeHtml(en.title)}</div>` : ''}
      <div class="d-body">${escapeHtml(en.body)}</div>
      ${en.photos?.length ? `<div style="margin-top:8px">${en.photos.map(p=>`<img src="${p}" data-dimg="${p}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;margin-right:6px;cursor:pointer">`).join('')}</div>` : ''}
      ${en.tags?.length ? `<div class="d-tags">${en.tags.map(t=>`<span class="tag ${t.startsWith('private')?'private':''}">${escapeHtml(t.startsWith('#')||t.startsWith('private')?t:'#'+t)}</span>`).join('')}</div>` : ''}
      <div class="d-actions">
        <button data-edit="${en.id}">✏️ Edit</button>
        <button data-del="${en.id}">🗑️ Delete</button>
      </div>
    </div>`).join('');
}
function diaryModal(existing) {
  openModal(`<h3>${existing?'✏️ Edit':'✍️ New'} Diary Entry</h3>
    <input type="text" id="dTitle" placeholder="Title (optional)" value="${existing?escapeHtml(existing.title||''):''}" />
    <textarea id="dBody" rows="6" placeholder="Write your heart out…">${existing?escapeHtml(existing.body):''}</textarea>
    <input type="text" id="dTags" placeholder="Tags: firstcall, missyou, funny" value="${existing?(existing.tags||[]).join(', '):''}" />
    <select id="dPrivate">
      <option value="">Shared (both can see)</option>
      <option value="private to him" ${existing?.tags?.includes('private to him')?'selected':''}>Private to ${HIS()}</option>
      <option value="private to her" ${existing?.tags?.includes('private to her')?'selected':''}>Private to ${HER()}</option>
    </select>
    <button class="pill-btn full ghost" id="dPhoto">📷 Attach Photo</button>
    <div id="dPhotoPrev" style="margin:8px 0"></div>
    <div class="modal-actions">
      <button class="pill-btn ghost" data-close>Cancel</button>
      <button class="pill-btn" id="dSave">Save</button></div>`);
  let photos = existing?.photos ? [...existing.photos] : [];
  const prev = $('#dPhotoPrev');
  const drawPrev = () => prev.innerHTML = photos.map(p=>`<img src="${p}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;margin-right:6px">`).join('');
  drawPrev();
  $('#dPhoto').addEventListener('click', () => {
    const inp = document.createElement('input'); inp.type='file'; inp.accept='image/*';
    inp.onchange = ev => { const f=ev.target.files[0]; if(f) compressImage(f,600,u=>{photos.push(u);drawPrev();}); };
    inp.click();
  });
  $('#dSave').addEventListener('click', () => {
    const body = $('#dBody').value.trim();
    if (!body) { toast('Write something first 💕'); return; }
    let tags = $('#dTags').value.split(',').map(t=>t.trim()).filter(Boolean);
    const priv = $('#dPrivate').value; if (priv) tags.push(priv);
    const entries = DB.get(K.diary, []);
    if (existing) {
      const en = entries.find(x=>x.id==existing.id);
      Object.assign(en, { title:$('#dTitle').value.trim(), body, tags, photos });
    } else {
      entries.push({ id:now(), t:now(), title:$('#dTitle').value.trim(), body, tags, photos });
      bumpStreak('questions'); // writing counts toward engagement; lightweight
    }
    DB.set(K.diary, entries); closeModal(); renderDiary();
    logActivity('📖 Wrote a diary entry');
  });
}
$('#newDiary').addEventListener('click', () => diaryModal(null));
$('#diaryList').addEventListener('click', e => {
  const ed = e.target.closest('[data-edit]');
  const dl = e.target.closest('[data-del]');
  const im = e.target.closest('[data-dimg]');
  if (ed) { const en = DB.get(K.diary,[]).find(x=>x.id==ed.dataset.edit); diaryModal(en); }
  if (dl) {
    if (confirm('Delete this entry?')) {
      DB.set(K.diary, DB.get(K.diary,[]).filter(x=>x.id!=dl.dataset.del)); renderDiary();
    }
  }
  if (im) openLightbox([{img:im.dataset.dimg, caption:''}],0);
});
$('#memoryLane').addEventListener('click', () => {
  const entries = DB.get(K.diary, []);
  if (!entries.length) { toast('No entries yet 📖'); return; }
  const en = entries[Math.floor(Math.random()*entries.length)];
  openModal(`<h3>🎲 Memory Lane</h3>
    <div class="d-date">${new Date(en.t).toLocaleDateString()}</div>
    ${en.title?`<div class="d-title" style="margin:6px 0">${escapeHtml(en.title)}</div>`:''}
    <p style="font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(en.body)}</p>
    <div class="modal-actions"><button class="pill-btn" data-close>Sweet 💕</button></div>`);
});
$('#exportDiary').addEventListener('click', () => {
  const entries = DB.get(K.diary, []).sort((a,b)=>a.t-b.t);
  if (!entries.length) { toast('Nothing to export 📖'); return; }
  let html = `<html><head><meta charset="utf-8"><title>Our Corner Diary</title>
    <style>body{font-family:Georgia,serif;max-width:680px;margin:40px auto;padding:0 20px;color:#2c2c2c}
    h1{text-align:center;color:#D4A5A5}.entry{margin-bottom:36px;border-bottom:1px solid #eee;padding-bottom:24px}
    .date{color:#999;font-size:13px}.title{font-size:20px;margin:6px 0;color:#C8B8E8}
    img{max-width:200px;border-radius:8px;margin:8px 8px 0 0}</style></head><body>
    <h1>📖 ${HIS()} & ${HER()}'s Diary</h1>`;
  entries.forEach(en => {
    html += `<div class="entry"><div class="date">${new Date(en.t).toLocaleString()}</div>
      ${en.title?`<div class="title">${escapeHtml(en.title)}</div>`:''}
      <p style="white-space:pre-wrap;line-height:1.6">${escapeHtml(en.body)}</p>
      ${(en.photos||[]).map(p=>`<img src="${p}">`).join('')}</div>`;
  });
  html += '</body></html>';
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); setTimeout(()=>w.print(),500); }
  else toast('Allow pop-ups to export 📄');
});

/* ===================================================================
   DAILY QUESTIONS
   =================================================================== */
const QUESTION_BANK = [
  { c:'daily',     t:"What's one thing {them} did today that made you smile?" },
  { c:'daily',     t:"What was the best part of your day?" },
  { c:'daily',     t:"What's something you're grateful for today?" },
  { c:'daily',     t:"What made you laugh hardest this week?" },
  { c:'daily',     t:"What's a small thing that means a lot to you?" },
  { c:'daily',     t:"What song reminds you of {them}?" },
  { c:'romance',   t:"What's a dream you have for your future with {them}?" },
  { c:'romance',   t:"What's your favorite memory of us so far?" },
  { c:'romance',   t:"What's something you admire about {them}?" },
  { c:'romance',   t:"When do you feel most loved?" },
  { c:'romance',   t:"What made you fall for {them}?" },
  { c:'romance',   t:"Describe {them} in three words." },
  { c:'romance',   t:"What's a tiny habit of {them}'s you secretly love?" },
  { c:'romance',   t:"What's your favorite photo of {them} and why?" },
  { c:'romance',   t:"What's your love language and how can {them} speak it better?" },
  { c:'romance',   t:"What do you daydream about when you miss {them}?" },
  { c:'romance',   t:"What makes you feel closest to {them} across the distance?" },
  { c:'deep',      t:"Where do you see us in five years?" },
  { c:'deep',      t:"What does 'home' mean to you?" },
  { c:'deep',      t:"What's a fear you'd like to share?" },
  { c:'deep',      t:"How can {them} support you better right now?" },
  { c:'deep',      t:"What's one promise you want to make to us?" },
  { c:'deep',      t:"What's a question you've always wanted to ask {them}?" },
  { c:'adventure', t:"If we could teleport anywhere right now, where would we go?" },
  { c:'adventure', t:"Where should we travel first together?" },
  { c:'adventure', t:"What's something new you want to try together?" },
  { c:'adventure', t:"What would our perfect date look like?" },
  { c:'adventure', t:"What's the first thing you want to do when you're together again?" },
  { c:'funny',     t:"What's a silly inside joke we have?" },
  { c:'funny',     t:"If we adopted a real pet, what would we name it?" },
  { c:'funny',     t:"If we wrote a book together, what would it be about?" },
  { c:'funny',     t:"What movie should be our next watch-party pick?" },
  { c:'daily',     t:"What food do you wish you could share with {them} right now?" },
  { c:'romance',   t:"What's a tradition you'd like us to start?" },
  { c:'deep',      t:"What's a goal you want us to achieve together?" },
  { c:'romance',   t:"What's a moment you wish you could relive?" },
  { c:'romance',   t:"What do you want our anniversary to look like?" },
  { c:'daily',     t:"What's your hope for us this month?" },
  { c:'deep',      t:"What's a quality you hope our future home will have?" }
];
const QOTW = [
  "Looking back at the past year, what moment changed our relationship the most, and where do you hope you'll be a year from now?",
  "If you wrote a letter to us five years from now, what would you want that future couple to remember about right now?",
  "What does building a life together mean to you, and what's one foundation you want us to lay this season?"
];
function personalizeQ(text, who){
  const you = who==='luke'?HIS():HER(); const them = who==='luke'?HER():HIS();
  return text.replace(/\{you\}/g,you).replace(/\{them\}/g,them);
}
function customQuestions(){ return DB.get(K.customQuestions, []); }
function allQuestions(){
  const builtin = QUESTION_BANK.map((q,i)=>({ questionId:'b'+i, category:q.c, text:q.t, isCustom:false }));
  return builtin.concat(customQuestions());
}
function questionState(){ return DB.get(K.questions, { index:0, answers:{}, answeredDates:{} }); }
let qWho = 'luke';
function renderQuestion(){
  const st = questionState(); const list = allQuestions();
  const tBtns = $$('#qWhoToggle button');
  if (tBtns[0]) tBtns[0].textContent = '🦂 '+HIS();
  if (tBtns[1]) tBtns[1].textContent = '🌸 '+HER();
  const idx = st.index % list.length; const q = list[idx];
  $('#qDay').textContent = `Question ${idx+1} of ${list.length}`;
  $('#qText').innerHTML = escapeHtml(personalizeQ(q.text,qWho)) + (q.isCustom?' <span class="q-custom-badge">✏️ Your Question</span>':'');
  const week = Math.floor(Date.now()/604800000) % QOTW.length;
  $('#qotwText').textContent = personalizeQ(QOTW[week], qWho);
  const a = st.answers[q.questionId] || {};
  const reveal = $('#qReveal'), next = $('#qNext');
  if (a.luke && a.sophie){ showReveal(a,q); $('#qAnswer').value=''; reveal.hidden=false; next.hidden=false; }
  else { reveal.hidden=true; next.hidden=true; $('#qAnswer').value = a[qWho] || ''; }
}
function showReveal(a,q){
  const match = a.luke.trim().toLowerCase()===a.sophie.trim().toLowerCase();
  $('#qReveal').innerHTML = `
    <div class="q-answer-box luke"><div class="qa-who">${HIS()}</div><div class="qa-q">${escapeHtml(personalizeQ(q.text,'luke'))}</div>${escapeHtml(a.luke)}</div>
    <div class="q-answer-box sophie"><div class="qa-who">${HER()}</div><div class="qa-q">${escapeHtml(personalizeQ(q.text,'sophie'))}</div>${escapeHtml(a.sophie)}</div>
    ${match?'<div class="q-match">❤️ Match!</div>':''}`;
}
$('#qWhoToggle').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  qWho = b.dataset.who;
  $$('#qWhoToggle button').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  renderQuestion();
});
$('#qSubmit').addEventListener('click', () => {
  const val = $('#qAnswer').value.trim(); if(!val){ toast('Write an answer first 💕'); return; }
  const st = questionState(); const list = allQuestions(); const idx = st.index % list.length; const q = list[idx];
  st.answers[q.questionId] = st.answers[q.questionId] || {};
  const respondent = qWho;
  st.answers[q.questionId][respondent] = val;
  st.answers[q.questionId]._records = st.answers[q.questionId]._records || {};
  st.answers[q.questionId]._records[respondent] = { answerId:'ans_'+respondent+'_'+q.questionId, questionId:q.questionId, respondent, answer:val, timestamp:now() };
  DB.set(K.questions, st);
  if ($('#qSaveDiary').checked){
    const entries = DB.get(K.diary, []);
    entries.push({ id:now(), t:now(), title:`Q: ${personalizeQ(q.text,respondent)}`, body:`${NAME(respondent)}: ${val}`, tags:['dailyquestion'], photos:[] });
    DB.set(K.diary, entries);
  }
  const a = st.answers[q.questionId];
  if (a.luke && a.sophie){
    bumpStreak('questions'); showReveal(a,q); $('#qReveal').hidden=false; $('#qNext').hidden=false;
    logActivity('💬 Both answered the daily question');
    if (a.luke.trim().toLowerCase()===a.sophie.trim().toLowerCase()) confetti();
  } else { toast(`Saved! Waiting for ${respondent==='luke'?HER():HIS()} 💞`); $('#qAnswer').value=''; }
});
$('#qNext').addEventListener('click', () => {
  const st = questionState(); st.index = (st.index+1) % allQuestions().length;
  DB.set(K.questions, st); $('#qSaveDiary').checked=false; renderQuestion();
});
const QCATS = ['daily','romance','sexual','deep','funny','faith','adventure'];
const QCAT_LABEL = { daily:'Daily', romance:'Romance', sexual:'Sexual', deep:'Deep', funny:'Funny', faith:'Faith', adventure:'Adventure' };
function qAddModal(editId){
  const editing = editId ? customQuestions().find(q=>q.questionId===editId) : null;
  openModal(`
    <h3>${editing?'Edit':'Add'} Custom Question</h3>
    <label>Question<textarea id="qcText" rows="3" placeholder="Tip: use {them} for your partner, e.g. What did {them} do today?">${editing?escapeHtml(editing.text):''}</textarea></label>
    <label>Category<select id="qcCat">${QCATS.map(c=>`<option value="${c}" ${editing&&editing.category===c?'selected':''}>${QCAT_LABEL[c]}</option>`).join('')}</select></label>
    <div class="modal-actions">
      <button class="pill-btn ghost" data-close>Cancel</button>
      ${editing?`<button class="pill-btn danger" id="qcDelete">Delete</button>`:''}
      <button class="pill-btn" id="qcSave">${editing?'Save':'Add'}</button>
    </div>`);
  $('#qcSave').addEventListener('click', () => {
    const text = $('#qcText').value.trim(); if(!text){ toast('Write the question first'); return; }
    const cat = $('#qcCat').value; const lst = customQuestions();
    if (editing){ editing.text=text; editing.category=cat; const i=lst.findIndex(q=>q.questionId===editId); lst[i]=editing; }
    else lst.push({ questionId:'c_'+now()+'_'+Math.random().toString(36).slice(2,6), category:cat, text, isCustom:true });
    DB.set(K.customQuestions, lst); closeModal(); toast(editing?'Question updated':'Question added ✏️'); renderQuestion();
  });
  const del = $('#qcDelete');
  if (del) del.addEventListener('click', () => {
    DB.set(K.customQuestions, customQuestions().filter(q=>q.questionId!==editId));
    const st = questionState(); delete st.answers[editId]; st.index=0; DB.set(K.questions, st);
    closeModal(); toast('Question deleted'); renderQuestion();
  });
}
function qManageModal(){
  const lst = customQuestions();
  openModal(`
    <h3>Your Custom Questions</h3>
    ${lst.length?`<div class="q-manage-list">${lst.map(q=>`<div class="q-manage-row"><span><em class="q-cat-tag">${QCAT_LABEL[q.category]||q.category}</em> ${escapeHtml(q.text)}</span><button class="q-edit-btn" data-qedit="${q.questionId}">✏️</button></div>`).join('')}</div>`:'<p class="muted">No custom questions yet. Add one to mix it into your rotation!</p>'}
    <div class="modal-actions"><button class="pill-btn ghost" data-close>Close</button><button class="pill-btn" id="qManageAdd">+ Add New</button></div>`);
  $('#qManageAdd').addEventListener('click', ()=>qAddModal());
  $$('#modal [data-qedit]').forEach(b=>b.addEventListener('click', ()=>qAddModal(b.dataset.qedit)));
}
const _qAddBtn = $('#qAddCustom'); if (_qAddBtn) _qAddBtn.addEventListener('click', ()=>qAddModal());
const _qManageBtn = $('#qManage'); if (_qManageBtn) _qManageBtn.addEventListener('click', ()=>qManageModal());

/* ===================================================================
   GAME: STORY WRITING  (collaborative, alternating turns)
   Modes: word | sentence | paragraph. Each turn you add your part,
   then it's your partner's turn. Uses the gameStates turn layer.
   =================================================================== */
const STORY_PROMPTS = [
  "Our first date, except one of us is secretly a vampire.",
  "The day our pet learned to talk and immediately started giving relationship advice.",
  "We accidentally got elected co-mayors of a small, very weird town.",
  "A romantic dinner that's interrupted by a raccoon heist.",
  "We woke up and swapped bodies, and today is the worst possible day for that.",
  "Our love story, but narrated by an overly dramatic nature documentary host.",
  "We open a restaurant that only serves food at 3am to confused customers.",
  "The time we got trapped in an IKEA overnight and built a civilization.",
  "We're spies on opposite teams who keep accidentally going on dates.",
  "Our wedding, but everything that can go hilariously wrong does.",
  "We adopt a goose. The goose has opinions about our relationship.",
  "The day gravity stopped working but only in our apartment.",
  "We start a band with zero musical talent and somehow become famous.",
  "A road trip where the GPS is clearly trying to break us up.",
  "We find a genie, but it only grants extremely petty wishes.",
  "Our future kids interview us about how we 'really' met (we lie).",
  "We accidentally join a cult that's just really into competitive gardening.",
  "The grocery store run that turned into an international incident.",
  "We're the last two people on Earth and we cannot agree on what to watch.",
  "Our love letters, except autocorrect changed every important word.",
  "We get stuck in a time loop reliving our most embarrassing date.",
  "The day we became reluctant superheroes whose only power is finding parking.",
  "We host a dinner party for our exes. It goes about as well as expected.",
  "A camping trip where the squirrels have formed a tiny, hostile government.",
  "We switch lives with a royal couple and immediately cause a scandal.",
  "Our houseplants stage an intervention about how we treat them.",
  "We accidentally enter a ballroom dancing competition with no training.",
  "The morning we woke up 50 years in the future as a very famous old couple.",
  "We try to assemble furniture and accidentally summon something.",
  "Our beach vacation, narrated entirely by a judgmental seagull.",
  "We become contestants on a game show designed to test our relationship.",
  "The day our smart home gained sentience and got way too involved.",
  "We open a detective agency that only solves extremely low-stakes mysteries.",
  "A snowstorm traps us in a cabin with a very chatty ghost.",
  "We accidentally adopt 14 cats in a single afternoon and must explain ourselves.",
  "Our origin story if we were a crime-fighting duo with terrible costumes."
];
const STORY_MODES = {
  word:      { label:'One Word',     hint:'Add ONE word, then pass.' },
  sentence:  { label:'One Sentence', hint:'Add ONE sentence, then pass.' },
  paragraph: { label:'Paragraph',    hint:'Add a paragraph, then pass.' }
};
function storyState(){ return loadGameState('story'); }
function renderStoryWriting(){
  const gs = storyState();
  if (!gs || !gs.state || !gs.state.mode){
    // mode + prompt picker
    $('#storyStage').innerHTML = `
      ${deviceWhoBar('story')}
      <p class="center-note">Pick a mode and a prompt to start a story together!</p>
      <div class="story-modes">
        ${Object.entries(STORY_MODES).map(([k,m])=>`<button class="story-mode-btn" data-storymode="${k}"><b>${m.label}</b><span>${m.hint}</span></button>`).join('')}
      </div>`;
    return;
  }
  const st = gs.state;
  const cp = gs.currentPlayer;
  const mode = STORY_MODES[st.mode];
  const text = st.parts.map(p=>p.text).join(st.mode==='word'?' ':st.mode==='paragraph'?'\n\n':' ');
  $('#storyStage').innerHTML = `
    ${deviceWhoBar('story')}
    <div class="story-meta"><span class="story-mode-tag">${mode.label} Mode</span> · <span class="muted">${st.parts.length} contribution${st.parts.length!==1?'s':''}</span></div>
    <div class="story-prompt">📝 ${escapeHtml(st.prompt)}</div>
    <div class="story-text" id="storyText">${st.parts.length?escapeHtml(text):'<span class="muted">Empty — start the story!</span>'}</div>
    <textarea id="storyInput" rows="${st.mode==='paragraph'?4:2}" placeholder="${escapeHtml(mode.hint)}" ${!checkTurn('story')?'disabled':''}></textarea>
    <button class="pill-btn full" id="storyAdd" ${!checkTurn('story')?'disabled':''}>${checkTurn('story')?'Add & Pass Turn':'Waiting for '+(cp==='luke'?HIS():HER())+'…'}</button>
    <div class="row" style="gap:8px;margin-top:8px">
      <button class="pill-btn ghost sm" id="storySave">💾 Save to Diary</button>
      <button class="pill-btn ghost sm" id="storyNew">🔄 New Story</button>
    </div>`;
}
function storyValidate(text, mode){
  const t = text.trim();
  if (!t) return 'Write something first ✍️';
  if (mode==='word' && /\s/.test(t)) return 'One word only for this mode!';
  if (mode==='sentence'){
    const sentences = t.split(/[.!?]+/).filter(s=>s.trim().length);
    if (sentences.length>1) return 'Just one sentence for this mode!';
  }
  return null;
}
document.addEventListener('click', e => {
  // mode picker
  const mb = e.target.closest('[data-storymode]');
  if (mb && $('#page-game-story')?.classList.contains('active')){
    const mode = mb.dataset.storymode;
    const prompt = STORY_PROMPTS[Math.floor(Math.random()*STORY_PROMPTS.length)];
    saveGameState('story', { mode, prompt, parts:[] }, 'luke', []);
    renderStoryWriting(); return;
  }
  // add a contribution
  if (e.target.id==='storyAdd'){
    if (!checkTurn('story')){ toast(`Waiting for ${currentPlayer('story')==='luke'?HIS():HER()}`); return; }
    const gs = storyState(); if (!gs||!gs.state) return;
    const st = gs.state; const val = $('#storyInput').value;
    const err = storyValidate(val, st.mode); if (err){ toast(err); return; }
    st.parts.push({ who: gs.currentPlayer, text: val.trim(), t: now() });
    const next = gs.currentPlayer==='luke'?'sophie':'luke';
    const hist = (gs.turnHistory||[]).concat([{ who:gs.currentPlayer, text:val.trim(), t:now() }]);
    saveGameState('story', st, next, hist);
    renderStoryWriting();
    logActivity('📖 Added to your shared story');
    return;
  }
  // save to diary
  if (e.target.id==='storySave'){
    const gs = storyState(); if (!gs||!gs.state||!gs.state.parts.length){ toast('Nothing to save yet'); return; }
    const st = gs.state;
    const text = st.parts.map(p=>p.text).join(st.mode==='word'?' ':st.mode==='paragraph'?'\n\n':' ');
    const entries = DB.get(K.diary, []);
    entries.push({ id:now(), t:now(), title:`📖 Our Story: ${st.prompt}`, body:text, tags:['story'], photos:[] });
    DB.set(K.diary, entries);
    toast('Saved to diary 📖');
    return;
  }
  // new story
  if (e.target.id==='storyNew'){
    saveGameState('story', { mode:null }, 'luke', []);
    renderStoryWriting();
    return;
  }
});


/* ===================================================================
   DAILY GRATITUDE & EXCITEMENT  (per-partner, with scrollable history)
   =================================================================== */
let gratWho = 'luke';
function gratitudeAll(){ return DB.get(K.gratitude, {}); }
function renderGratitude(){
  const who = (typeof deviceWho==='function' && deviceWho()) ? deviceWho() : gratWho;
  gratWho = who;
  const all = gratitudeAll();
  const today = todayStr();
  const todayRec = all[today] || {};
  const mine = todayRec[who] || {};
  const dev = (typeof deviceWho==='function') ? deviceWho() : null;
  $('#gratWhoBar').innerHTML = dev
    ? `<div class="grat-asyou">Answering as <b>${who==='luke'?HIS():HER()}</b></div>`
    : `<div class="who-toggle" id="gratWhoToggle">
         <button data-gw="luke" class="${who==='luke'?'active':''}">🦂 ${HIS()}</button>
         <button data-gw="sophie" class="${who==='sophie'?'active':''}">🌸 ${HER()}</button>
       </div>`;
  $('#gratToday').innerHTML = `
    <div class="grat-card">
      <label class="grat-q">🙏 One thing you're grateful for about ${who==='luke'?HER():HIS()} today</label>
      <textarea id="gratGrateful" rows="2" placeholder="Today I'm grateful that…">${escapeHtml(mine.grateful||'')}</textarea>
      <label class="grat-q">✨ One thing you're excited about in your future with ${who==='luke'?HER():HIS()}</label>
      <textarea id="gratExcited" rows="2" placeholder="I can't wait until…">${escapeHtml(mine.excited||'')}</textarea>
      <button class="pill-btn full" id="gratSave">Save Today's Entry</button>
    </div>`;
  renderGratitudeHistory();
}
function renderGratitudeHistory(){
  const all = gratitudeAll();
  const dates = Object.keys(all).sort().reverse();
  const host = $('#gratHistory');
  if (!dates.length){ host.innerHTML = '<p class="muted center">No entries yet — start today! 💕</p>'; return; }
  host.innerHTML = `<h3 class="grat-hist-title">Past Entries</h3>` + dates.map(d=>{
    const rec = all[d];
    const blocks = ['luke','sophie'].map(w=>{
      const r = rec[w]; if (!r || (!r.grateful && !r.excited)) return '';
      return `<div class="grat-hist-person ${w}">
        <div class="grat-hist-who">${w==='luke'?HIS():HER()}</div>
        ${r.grateful?`<div class="grat-hist-line">🙏 ${escapeHtml(r.grateful)}</div>`:''}
        ${r.excited?`<div class="grat-hist-line">✨ ${escapeHtml(r.excited)}</div>`:''}
      </div>`;
    }).join('');
    if (!blocks.trim()) return '';
    return `<div class="grat-hist-day"><div class="grat-hist-date">${fmtDate(d)}</div>${blocks}</div>`;
  }).join('');
}
function fmtDate(ymd){
  try { const [y,m,dd]=ymd.split('-'); return new Date(y,m-1,dd).toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'}); }
  catch { return ymd; }
}
document.addEventListener('click', e => {
  const gw = e.target.closest('#gratWhoToggle button');
  if (gw){ gratWho = gw.dataset.gw; renderGratitude(); return; }
  if (e.target.id==='gratSave'){
    const all = gratitudeAll(); const today = todayStr();
    all[today] = all[today] || {};
    const g = $('#gratGrateful').value.trim(), x = $('#gratExcited').value.trim();
    if (!g && !x){ toast('Write at least one thing 💕'); return; }
    all[today][gratWho] = { grateful:g, excited:x, t:now() };
    DB.set(K.gratitude, all);
    logActivity(`💛 ${gratWho==='luke'?HIS():HER()} shared today's gratitude`);
    toast('Saved 💛'); renderGratitude();
  }
});

/* ===================================================================
   PHOTO CALENDAR — month grid of past Photos of the Day
   =================================================================== */
let calYear, calMonth;
function photosByDate(){
  const map = {};
  DB.get(K.photos, []).filter(p=>p.folder==='photoOfDay' && p.photoOfDayDate).forEach(p=>{
    if (!map[p.photoOfDayDate] || (p.uploadedAt||0) > (map[p.photoOfDayDate].uploadedAt||0)) map[p.photoOfDayDate]=p;
  });
  const cur = DB.get(K.potd, null);
  if (cur && cur.img){ const d = cur.date || todayStr(); map[d] = { img:cur.img, caption:cur.caption||'', photoOfDayDate:d, uploadedBy:cur.uploadedBy, uploadedAt:cur.uploadedAt, current:true }; }
  return map;
}
function renderPhotoCalendar(){
  if (calYear==null){ const n=new Date(); calYear=n.getFullYear(); calMonth=n.getMonth(); }
  const map = photosByDate();
  const first = new Date(calYear, calMonth, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
  const monthName = first.toLocaleDateString([], {month:'long', year:'numeric'});
  let cells = '';
  for (let i=0;i<startDow;i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d=1; d<=daysInMonth; d++){
    const ymd = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const p = map[ymd];
    cells += `<div class="cal-cell ${p?'has-photo':''}" ${p?`data-calphoto="${ymd}"`:''}>
      ${p?`<img src="${p.img}" alt="">`:''}
      <span class="cal-day">${d}</span>
    </div>`;
  }
  $('#calGrid').innerHTML = `
    <div class="cal-head">
      <button class="cal-nav" id="calPrev">‹</button>
      <span class="cal-month">${monthName}</span>
      <button class="cal-nav" id="calNext">›</button>
    </div>
    <div class="cal-dow">${['S','M','T','W','T','F','S'].map(x=>`<span>${x}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>`;
}
document.addEventListener('click', e => {
  if (e.target.id==='calPrev'){ calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderPhotoCalendar(); return; }
  if (e.target.id==='calNext'){ calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderPhotoCalendar(); return; }
  const cc = e.target.closest('[data-calphoto]');
  if (cc && $('#page-calendar')?.classList.contains('active')){
    const map = photosByDate(); const p = map[cc.dataset.calphoto];
    if (p) openLightbox([{img:p.img, caption:`${fmtDate(cc.dataset.calphoto)}${p.uploadedBy?' · '+(p.uploadedBy==='luke'?HIS():HER()):''}${p.caption?' · '+p.caption:''}`}], 0);
  }
});

/* ===================================================================
   GAME: WOULD YOU RATHER
   =================================================================== */
const WYR = [
  ["Always have to sing instead of speak","Always have to dance everywhere you walk","silly"],
  ["Spend a year apart but with daily video","Be together but only text once a week","spicy"],
  ["Have a tiny home that travels anywhere","A huge mansion that never moves","silly"],
  ["Relive our first date","Fast-forward to our wedding","spicy"],
  ["Only eat your partner's cooking forever","Only eat your own cooking forever","silly"],
  ["Read each other's minds for a day","Swap bodies for a day","spicy"],
  ["Have a pet dragon","Have a pet unicorn","silly"],
  ["Always be 10 min early","Always be 10 min late","silly"],
  ["Take a surprise trip with no planning","Plan every detail for months","spicy"],
  ["Have matching tattoos","Have matching haircuts","spicy"],
  ["Live by the beach","Live in the mountains","silly"],
  ["Give up coffee forever","Give up dessert forever","silly"],
  ["Be famous together","Be rich and private","spicy"],
  ["Have endless date nights","Have endless lazy mornings","spicy"],
  ["Travel to the past","Travel to the future","silly"],
  ["Sing a love song in public","Write a love poem and read it aloud","spicy"],
  ["Always know what gift the other wants","Always plan the perfect surprise","silly"],
  ["Have a movie made about your love","Have a song written about it","spicy"],
  ["Speak every language","Play every instrument","silly"],
  ["Cuddle all day","Adventure all day","spicy"],
  ["Have a kitchen that cooks itself","A room that cleans itself","silly"],
  ["Spend holidays with your family","With your partner's family","spicy"],
  ["Be able to teleport to each other","Have unlimited free flights","spicy"],
  ["Win a year of dates","Win a dream vacation","silly"],
  ["Always finish each other's sentences","Always know each other's mood","spicy"],
  ["Have a treehouse","Have a houseboat","silly"],
  ["Slow dance in the rain","Watch sunrise on a rooftop","spicy"],
  ["Be each other's personal chef","Personal masseuse","spicy"],
  ["Have a photo wall of every memory","A video diary of every day","silly"],
  ["Get lost in a new city together","Have every trip perfectly guided","silly"],
  ["Adopt ten dogs","Adopt ten cats","silly"],
  ["Have a secret handshake","A secret language","silly"],
  ["Always pick the movie","Always pick the restaurant","silly"],
  ["Surprise breakfast in bed daily","Surprise notes daily","spicy"],
  ["Be pen pals for life","Be roommates for life","spicy"],
  ["Have a star named after you two","An island named after you two","silly"],
  ["Stargaze every clear night","Beach walk every warm evening","spicy"],
  ["Learn to cook a cuisine together","Learn a dance together","silly"],
  ["Have unlimited movie nights","Unlimited game nights","silly"],
  ["Send a daily voice note","Send a daily drawing","spicy"],
  ["Be the planner","Be the spontaneous one","silly"],
  ["Have a cozy cabin getaway","A luxe city hotel getaway","silly"],
  ["Always remember every anniversary","Always plan the best one","spicy"],
  ["Grow a garden together","Build furniture together","silly"],
  ["Have a personalized playlist always","A personalized photo book always","silly"],
  ["Whisper secrets at midnight","Shout love from a rooftop","spicy"],
  ["Have one long trip a year","Many short trips a year","silly"],
  ["Be each other's first call always","Each other's last text always","spicy"],
  ["Have a fireplace for winters","A porch swing for summers","silly"],
  ["Trade chores forever","Do all chores together forever","silly"]
];
function wyrState(){ return DB.get('ourCorner_wyr', { index:0, choices:{} }); }
function renderWYR() {
  const st = wyrState();
  const idx = st.index % WYR.length;
  const [a,b,tag] = WYR[idx];
  const choice = st.choices[idx] || {};
  $('#wyrStage').innerHTML = `
    <div class="wyr-tag">${tag==='spicy'?'🌶️ Spicy':'😄 Silly'} · ${idx+1}/${WYR.length}</div>
    <div class="wyr-card a ${choice.luke==='a'||choice.sophie==='a'?'chosen':''}" data-opt="a">${escapeHtml(a)}</div>
    <div class="wyr-or">— or —</div>
    <div class="wyr-card b ${choice.luke==='b'||choice.sophie==='b'?'chosen':''}" data-opt="b">${escapeHtml(b)}</div>
    <div class="who-toggle" id="wyrWho" style="justify-content:center;margin:8px 0">
      <button data-who="luke" class="${wyrWho==='luke'?'active':''}">${HIS()}</button>
      <button data-who="sophie" class="${wyrWho==='sophie'?'active':''}">${HER()}</button></div>
    ${choice.luke&&choice.sophie ? `<p class="center-note">${HIS()}: ${choice.luke==='a'?'A':'B'} | ${HER()}: ${choice.sophie==='a'?'A':'B'} ${choice.luke===choice.sophie?'· Match! ❤️':''}</p>`:''}
    <button class="pill-btn full ghost" id="wyrNext">Next →</button>`;
}
let wyrWho='luke';
$('#wyrStage').addEventListener('click', e => {
  const opt = e.target.closest('[data-opt]');
  const who = e.target.closest('#wyrWho button');
  const next = e.target.closest('#wyrNext');
  if (who) { wyrWho = who.dataset.who; renderWYR(); return; }
  if (next) { const st=wyrState(); st.index=(st.index+1)%WYR.length; DB.set('ourCorner_wyr',st); renderWYR(); return; }
  if (opt) {
    const st = wyrState(); const idx = st.index % WYR.length;
    st.choices[idx] = st.choices[idx] || {};
    st.choices[idx][wyrWho] = opt.dataset.opt;
    DB.set('ourCorner_wyr', st);
    const c = st.choices[idx];
    if (c.luke && c.sophie && c.luke===c.sophie) confetti();
    renderWYR();
  }
});

/* ===================================================================
   GAME: MEMORY MATCH  (turn-based, persistent)
   On a match you keep your turn; on a miss, turn passes.
   =================================================================== */
const MEM_ICONS = ['❤️','⭐','🌸','🦂','🌙','🔥','🎀','🍓'];
let memLock=false;
function memFreshState() {
  const deck = [...MEM_ICONS, ...MEM_ICONS]
    .map(v=>({v, r:Math.random()})).sort((a,b)=>a.r-b.r).map(x=>x.v);
  return { deck, flipped:[], matched:[], moves:{luke:0,sophie:0}, scores:{luke:0,sophie:0}, note:'Find all the pairs!' };
}
function startMemory() {
  saveGameState('memory', memFreshState(), 'luke', []);
  renderMemoryFromState();
}
function renderMemoryFromState() {
  let gs = loadGameState('memory');
  if (!gs || !gs.state || !gs.state.deck) { startMemory(); return; }
  const st = gs.state;
  const isOver = st.matched.length === MEM_ICONS.length;
  $('#memoryNote').innerHTML = deviceWhoBar('memory') +
    `<div class="mem-scores">${HIS()}: ${st.scores.luke} · ${HER()}: ${st.scores.sophie}</div>` +
    `<div>${isOver ? `🎉 Game over! ${st.scores.luke===st.scores.sophie?'Tie!':(st.scores.luke>st.scores.sophie?HIS():HER())+' wins!'}` : escapeHtml(st.note)}</div>`;
  $('#memoryGrid').innerHTML = st.deck.map((v,i)=>{
    const isFlipped = st.flipped.includes(i) || st.matched.includes(i);
    return `<div class="mem-card ${st.flipped.includes(i)?'flipped':''} ${st.matched.includes(i)?'matched':''}" data-i="${i}">
      <span>${isFlipped ? v : ''}</span></div>`;
  }).join('');
  $('#memoryGrid').classList.toggle('locked', !checkTurn('memory'));
}
function startMemoryOrResume() {
  const gs = loadGameState('memory');
  if (gs && gs.state && gs.state.deck) renderMemoryFromState();
  else startMemory();
}
$('#memoryReset').addEventListener('click', startMemory);
$('#memoryGrid').addEventListener('click', e => {
  const card = e.target.closest('.mem-card'); if (!card || memLock) return;
  if (!checkTurn('memory')) { toast(`Waiting for ${currentPlayer('memory')==='luke'?HIS():HER()}`); return; }
  const gs = loadGameState('memory'); const st = gs.state;
  const i = +card.dataset.i;
  if (st.flipped.includes(i) || st.matched.includes(i) || st.flipped.length>=2) return;
  st.flipped.push(i);
  const cp = gs.currentPlayer;
  if (st.flipped.length < 2) { saveGameState('memory', st, cp, gs.turnHistory); renderMemoryFromState(); return; }
  // two flipped → evaluate
  st.moves[cp] = (st.moves[cp]||0)+1;
  const [a,b] = st.flipped;
  saveGameState('memory', st, cp, gs.turnHistory); renderMemoryFromState();
  memLock = true;
  if (st.deck[a] === st.deck[b]) {
    setTimeout(()=>{
      const g2 = loadGameState('memory'); const s2 = g2.state;
      s2.matched.push(a,b); s2.flipped=[]; s2.scores[cp]=(s2.scores[cp]||0)+1;
      let done = s2.matched.length===MEM_ICONS.length;
      saveGameState('memory', s2, cp, g2.turnHistory); // match → keep turn
      memLock=false; renderMemoryFromState();
      if (done) { confetti(); logActivity('🃏 Finished a Memory Match game'); addCoins(5); }
    }, 500);
  } else {
    setTimeout(()=>{
      const g2 = loadGameState('memory'); const s2 = g2.state;
      s2.flipped=[];
      const next = cp==='luke'?'sophie':'luke';
      saveGameState('memory', s2, next, g2.turnHistory); // miss → pass turn
      memLock=false; renderMemoryFromState();
    }, 850);
  }
});

/* ===================================================================
   GAME: WAR  (turn-based: each player flips one card, then compare)
   =================================================================== */
function makeDeck() {
  const d=[]; for (let s=0;s<4;s++) for (let r=2;r<=14;r++) d.push({r, s});
  for (let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
const SUITS=['♠','♥','♦','♣'];
function cardFace(c){ const names={11:'J',12:'Q',13:'K',14:'A'}; return (names[c.r]||c.r)+SUITS[c.s]; }

function warFreshState() {
  const full = makeDeck();
  return { luke: full.slice(0,26), sophie: full.slice(26), flip:{luke:null,sophie:null}, msg:'Flip to begin! ⚔️' };
}
function initWar(keepState) {
  let gs = loadGameState('war');
  if (!keepState || !gs || !gs.state || !gs.state.luke) {
    saveGameState('war', warFreshState(), 'luke', []);
    gs = loadGameState('war');
  }
  renderWar();
}
function renderWar() {
  const gs = loadGameState('war'); if (!gs) { initWar(); return; }
  const st = gs.state;
  const lFace = st.flip.luke ? cardFace(st.flip.luke) : '?';
  const sFace = st.flip.sophie ? cardFace(st.flip.sophie) : '?';
  const lRed = st.flip.luke && (st.flip.luke.s===1||st.flip.luke.s===2);
  const sRed = st.flip.sophie && (st.flip.sophie.s===1||st.flip.sophie.s===2);
  $('#warStage').innerHTML = `
    ${deviceWhoBar('war')}
    <p class="war-msg" id="warMsg">${escapeHtml(st.msg)}</p>
    <div class="war-row">
      <div class="war-side"><h4>${HIS()}</h4><div class="war-card-face ${lRed?'red':'black'}" id="warL">${lFace}</div><div class="war-count" id="warLC">${st.luke.length} cards</div></div>
      <div class="war-side"><h4>${HER()}</h4><div class="war-card-face ${sRed?'red':'black'}" id="warS">${sFace}</div><div class="war-count" id="warSC">${st.sophie.length} cards</div></div>
    </div>`;
}
$('#warDraw').addEventListener('click', () => {
  let gs = loadGameState('war'); if (!gs || !gs.state || !gs.state.luke) { initWar(); gs = loadGameState('war'); }
  const st = gs.state;
  const cp = gs.currentPlayer;             // whose flip is pending
  if (!checkTurn('war')) { toast(`Waiting for ${cp==='luke'?HIS():HER()} to flip`); return; }
  if (!st.luke.length || !st.sophie.length) { initWar(); return; }

  // current player flips their card
  st.flip[cp] = st[cp][0];
  // if the other hasn't flipped yet, pass turn to them
  const other = cp==='luke' ? 'sophie' : 'luke';
  if (!st.flip[other]) {
    st.msg = `${cp==='luke'?HIS():HER()} flipped. ${other==='luke'?HIS():HER()}'s turn to flip.`;
    saveGameState('war', st, other, gs.turnHistory);
    renderWar(); return;
  }
  // both flipped → resolve the round
  const l = st.luke.shift(), s = st.sophie.shift();
  st.flip = { luke:null, sophie:null };
  let msg;
  if (l.r>s.r){ st.luke.push(l,s); msg=`${HIS()} wins the round! (${cardFace(l)} vs ${cardFace(s)})`; }
  else if (s.r>l.r){ st.sophie.push(l,s); msg=`${HER()} wins the round! (${cardFace(s)} vs ${cardFace(l)})`; }
  else { msg='⚔️ WAR! (tie — pot splits)'; st.luke.push(l); st.sophie.push(s); }
  st.msg = msg;
  let winner = 'luke';
  if (!st.luke.length){ st.msg=`${HER()} wins the game! 🎉`; confetti(); }
  if (!st.sophie.length){ st.msg=`${HIS()} wins the game! 🎉`; confetti(); }
  const hist = (gs.turnHistory||[]).concat([{ round:true, l:cardFace(l), s:cardFace(s), timestamp:now() }]);
  // next round starts with luke flipping again
  saveGameState('war', st, 'luke', hist);
  renderWar();
});
$('#warReset').addEventListener('click', () => initWar());

/* ===================================================================
   GAME SYNC LAYER (Build A: turn logic + persistence, syncs on refresh)
   Unified gameStates store in IndexedDB (via DB->Store->Supabase).
   Realtime push can be layered on later by subscribing to changes and
   calling the game's render fn — the save/load seam is ready for it.
   =================================================================== */
const K_GAMESTATES = 'ourCorner_gameStates';

/* Which partner is on THIS device? Saved per-device so the turn
   indicator can say "Your Turn" vs "Waiting for ...". */
function deviceWho() {
  let w = null;
  try { w = localStorage.getItem('ourCorner_deviceWho'); } catch {}
  return (w==='luke'||w==='sophie') ? w : null;
}
function setDeviceWho(w) { try { localStorage.setItem('ourCorner_deviceWho', w); } catch {} ; refreshTurnIndicators(); }

/* gameStates: { [gameType]: { state, currentPlayer, turnHistory, lastUpdated } } */
function allGameStates() { return DB.get(K_GAMESTATES, {}); }
function loadGameState(gameType) {
  const g = allGameStates();
  return g[gameType] || null;
}
function saveGameState(gameType, state, currentPlayer, turnHistory) {
  const g = allGameStates();
  g[gameType] = {
    gameStateId: gameType + '_' + (g[gameType]?.gameStateId?.split('_')[1] || now()),
    accountId: (window.App && App.account) ? App.account.accountId : null,
    gameType, state,
    currentPlayer: currentPlayer || g[gameType]?.currentPlayer || 'luke',
    turnHistory: turnHistory || g[gameType]?.turnHistory || [],
    lastUpdated: now()
  };
  DB.set(K_GAMESTATES, g);
}
function switchTurn(gameType) {
  const g = allGameStates();
  if (!g[gameType]) return;
  g[gameType].currentPlayer = g[gameType].currentPlayer === 'luke' ? 'sophie' : 'luke';
  g[gameType].lastUpdated = now();
  DB.set(K_GAMESTATES, g);
  return g[gameType].currentPlayer;
}
function currentPlayer(gameType) {
  return loadGameState(gameType)?.currentPlayer || 'luke';
}
/* true if it's THIS device's partner's turn. If device identity not set,
   returns true (so single-device pass-and-play still works freely). */
function checkTurn(gameType) {
  const who = deviceWho();
  if (!who) return true;
  return currentPlayer(gameType) === who;
}
/* Standard turn-indicator text + whether input should be allowed */
function turnText(gameType) {
  const cp = currentPlayer(gameType);
  const cpName = cp==='luke' ? HIS() : HER();
  const who = deviceWho();
  if (!who) return `${cpName}'s turn`;            // shared-device mode
  return checkTurn(gameType) ? '🟢 Your Turn' : `⏳ Waiting for ${cpName}…`;
}
/* Re-render the turn indicator on whatever game page is showing */
function refreshTurnIndicators() {
  if ($('#page-game-checkers')?.classList.contains('active')) renderCheckers();
}

/* A reusable "who is on this device?" chooser shown atop each game */
function deviceWhoBar(gameType) {
  const who = deviceWho();
  return `<div class="device-who-bar">
    <span class="dw-label">${turnText(gameType)}</span>
    <span class="dw-pick">I'm:
      <button class="dw-btn ${who==='luke'?'on':''}" data-dwwho="luke">${HIS()}</button>
      <button class="dw-btn ${who==='sophie'?'on':''}" data-dwwho="sophie">${HER()}</button>
    </span>
  </div>`;
}
/* delegated handler for all "I'm Luke/Sophie" buttons */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-dwwho]'); if (!b) return;
  setDeviceWho(b.dataset.dwwho);
  // re-render current game so indicators + lock state update
  const pg = document.querySelector('.page.active');
  if (pg) {
    if (pg.id==='page-game-checkers') renderCheckers();
    else if (pg.id==='page-game-war') initWar(true);
    else if (pg.id==='page-game-memory') renderMemoryFromState();
    else if (pg.id==='page-game-wyr') renderWYR();
    else if (pg.id==='page-game-draw') renderDrawTurn();
    else if (pg.id==='page-game-story') renderStoryWriting();
    else if (pg.id==='page-gratitude') renderGratitude();
  }
});

/* ===================================================================
   GAME: CHECKERS  (8x8, simplified rules: diagonal moves, jumps, kinging)
   =================================================================== */
let chBoard, chTurn, chSelected, chHistory;
function freshCheckers() {
  // 0 empty, {p:'l'|'s', king:false}
  const b = Array.from({length:8},()=>Array(8).fill(0));
  for (let r=0;r<3;r++) for (let c=0;c<8;c++) if ((r+c)%2===1) b[r][c]={p:'s',king:false};
  for (let r=5;r<8;r++) for (let c=0;c<8;c++) if ((r+c)%2===1) b[r][c]={p:'l',king:false};
  return b;
}
function loadCheckers() {
  const gs = loadGameState('checkers');
  const valid = gs && gs.state && Array.isArray(gs.state.board)
    && gs.state.board.length===8 && gs.state.board.every(row=>Array.isArray(row)&&row.length===8);
  if (valid) {
    chBoard = gs.state.board;
    chTurn = gs.currentPlayer === 'luke' ? 'l' : 's';
  } else {
    chBoard = freshCheckers(); chTurn = 'l';
    saveGameState('checkers', { board: chBoard }, 'luke', []);
  }
  chSelected = null; chHistory = [];
}
function saveCheckers() {
  const cp = chTurn === 'l' ? 'luke' : 'sophie';
  const gs = loadGameState('checkers') || {};
  saveGameState('checkers', { board: chBoard }, cp, gs.turnHistory || []);
}
function renderCheckers() {
  const ok8 = Array.isArray(chBoard) && chBoard.length===8 && chBoard.every(r=>Array.isArray(r)&&r.length===8);
  if (!ok8) loadCheckers();
  const s = getSettings();
  // turn indicator + device-who chooser
  let bar = $('#checkersTurnBar');
  $('#checkersTurn').innerHTML = deviceWhoBar('checkers');
  const board = $('#checkersBoard');
  board.innerHTML='';
  for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
    const sq=document.createElement('div');
    sq.className='ch-sq '+((r+c)%2===1?'dark':'light');
    sq.dataset.r=r; sq.dataset.c=c;
    const cell=chBoard[r][c];
    if (cell) {
      const icon = cell.p==='l'?s.lukeAvatar:s.sophieAvatar;
      sq.innerHTML=`<span class="ch-piece ${cell.king?'king':''}" style="color:${cell.p==='l'?'#D4A5A5':'#B8C5B6'}">${icon}</span>`;
    }
    if (chSelected && chSelected.r===r && chSelected.c===c) sq.classList.add('sel');
    if (chSelected && isValidMove(chSelected, {r,c})) sq.classList.add('target');
    board.appendChild(sq);
  }
  // lock the board visually when it's not this device's turn
  board.classList.toggle('locked', !checkTurn('checkers'));
}
function pieceMoves(from) {
  const cell=chBoard[from.r][from.c]; if(!cell) return [];
  const dirs = cell.king ? [[-1,-1],[-1,1],[1,-1],[1,1]]
    : cell.p==='l' ? [[-1,-1],[-1,1]] : [[1,-1],[1,1]];
  const moves=[];
  for (const [dr,dc] of dirs) {
    const nr=from.r+dr, nc=from.c+dc;
    if (inBounds(nr,nc) && !chBoard[nr][nc]) moves.push({r:nr,c:nc,jump:false});
    const jr=from.r+2*dr, jc=from.c+2*dc;
    if (inBounds(jr,jc) && !chBoard[jr][jc] && chBoard[nr]?.[nc] && chBoard[nr][nc].p!==cell.p)
      moves.push({r:jr,c:jc,jump:true,over:{r:nr,c:nc}});
  }
  return moves;
}
function inBounds(r,c){ return r>=0&&r<8&&c>=0&&c<8; }
function isValidMove(from,to){ return pieceMoves(from).some(m=>m.r===to.r&&m.c===to.c); }
$('#checkersBoard').addEventListener('click', e => {
  const sq=e.target.closest('.ch-sq'); if(!sq) return;
  // turn lock: if this device has an identity and it isn't its turn, block.
  if (!checkTurn('checkers')) { toast(`Not your turn — waiting for ${currentPlayer('checkers')==='luke'?HIS():HER()}`); return; }
  const r=+sq.dataset.r, c=+sq.dataset.c, cell=chBoard[r][c];
  if (chSelected) {
    const move = pieceMoves(chSelected).find(m=>m.r===r&&m.c===c);
    if (move) {
      chHistory.push(JSON.stringify({board:chBoard, turn:chTurn}));
      const piece=chBoard[chSelected.r][chSelected.c];
      chBoard[r][c]=piece; chBoard[chSelected.r][chSelected.c]=0;
      if (move.jump){ chBoard[move.over.r][move.over.c]=0; sq.querySelector('.ch-piece')?.classList.add('capture-anim'); }
      // kinging
      if (piece.p==='l' && r===0) piece.king=true;
      if (piece.p==='s' && r===7) piece.king=true;
      // record move in turnHistory
      const gs = loadGameState('checkers') || {};
      const hist = gs.turnHistory || [];
      hist.push({ player: chTurn==='l'?'luke':'sophie', from:{r:chSelected.r,c:chSelected.c}, to:{r,c}, jump:!!move.jump, timestamp: now() });
      // win check
      const sSide=chBoard.flat().filter(x=>x&&x.p==='s').length;
      const lSide=chBoard.flat().filter(x=>x&&x.p==='l').length;
      chSelected=null;
      if (sSide===0){ saveGameState('checkers',{board:chBoard}, 'luke', hist); renderCheckers(); $('#checkersTurn').textContent=`${HIS()} wins! 🎉`; confetti(); logActivity('🔴 Won a Checkers game'); return; }
      if (lSide===0){ saveGameState('checkers',{board:chBoard}, 'sophie', hist); renderCheckers(); $('#checkersTurn').textContent=`${HER()} wins! 🎉`; confetti(); logActivity('🔴 Won a Checkers game'); return; }
      chTurn = chTurn==='l'?'s':'l';
      saveGameState('checkers', {board:chBoard}, chTurn==='l'?'luke':'sophie', hist);
      renderCheckers(); return;
    }
    chSelected=null; renderCheckers(); return;
  }
  if (cell && cell.p===chTurn) { chSelected={r,c}; renderCheckers(); }
});
$('#checkersUndo').addEventListener('click', () => {
  if (!checkTurn('checkers')) { toast('You can only undo on your turn'); return; }
  if (!chHistory.length) { toast('Nothing to undo'); return; }
  const prev = JSON.parse(chHistory.pop());
  chBoard=prev.board; chTurn=prev.turn; chSelected=null;
  const gs = loadGameState('checkers') || {};
  const hist = (gs.turnHistory||[]).slice(0,-1);
  saveGameState('checkers', {board:chBoard}, chTurn==='l'?'luke':'sophie', hist);
  renderCheckers();
});
$('#checkersReset').addEventListener('click', () => {
  chBoard=freshCheckers(); chTurn='l'; chSelected=null; chHistory=[];
  saveGameState('checkers', {board:chBoard}, 'luke', []);
  renderCheckers();
});

/* ===================================================================
   PET (gacha dog)
   =================================================================== */
function getPet() {
  return DB.get(K.pet, {
    name:'Our Puppy', happiness:70, cleanliness:70, energy:70, hunger:40,
    coins:0, accessories:[], activeAcc:null, born:todayStr(), lastDecay:todayStr()
  });
}
function savePet(p){ DB.set(K.pet, p); }
function petStage(p) {
  const days = Math.floor((Date.now()-new Date(p.born))/86400000);
  if (days>=100) return ['🐕‍🦺','Golden'];
  if (days>=30)  return ['🐕','Adult'];
  return ['🐶','Puppy'];
}
function decayPet(p) {
  // gentle daily decay
  if (p.lastDecay !== todayStr()) {
    p.happiness=Math.max(0,p.happiness-5);
    p.cleanliness=Math.max(0,p.cleanliness-8);
    p.energy=Math.max(0,p.energy-6);
    p.hunger=Math.min(100,p.hunger+15);
    p.lastDecay=todayStr(); savePet(p);
  }
}
function renderPet() {
  const p=getPet(); decayPet(p);
  const s=getSettings();
  if (p.name==='Our Puppy' && s.petName!=='Our Puppy') p.name=s.petName;
  const [sprite,stage]=petStage(p);
  $('#petSprite').textContent = p.activeAcc ? sprite : sprite;
  $('#petName').textContent = p.name;
  $('#petStage').textContent = stage;
  $('#loveCoins').textContent = p.coins;
  $('#petCollar').textContent = 'L & S';
  const bars=[['Happiness',p.happiness,'#D4A5A5'],['Cleanliness',p.cleanliness,'#C8B8E8'],
    ['Energy',p.energy,'#B8C5B6'],['Hunger',100-p.hunger,'#e8b96a']];
  $('#petBars').innerHTML = bars.map(([l,v,col])=>`
    <div class="pet-bar-row"><span class="pb-label">${l==='Hunger'?'Fullness':l}</span>
    <div class="pet-bar"><div class="pet-bar-fill" style="width:${v}%;background:${col}"></div></div></div>`).join('');
  $('#gachaShelf').innerHTML = p.accessories.length
    ? p.accessories.map(a=>`<div class="gacha-item ${p.activeAcc===a?'active':''}" data-acc="${a}">${a}</div>`).join('')
    : '<p class="muted" style="font-size:12px">No accessories yet — try a pull! ✨</p>';
}
function syncPetMood() {
  const p=getPet(); const moods=DB.get(K.moods,{});
  const happy=['Happy','Amazing','Excited','Adoring','Romantic','Celebratory','Energetic','Playful'];
  let boost=0;
  if (moods.luke?.date===todayStr() && happy.includes(moods.luke.mood)) boost+=5;
  if (moods.sophie?.date===todayStr() && happy.includes(moods.sophie.mood)) boost+=5;
  if (boost){ p.happiness=Math.min(100,p.happiness+boost); savePet(p); }
}
function addCoins(n){ const p=getPet(); p.coins+=n; savePet(p); }
$('.pet-actions') && $('.pet-actions').addEventListener('click', e => {
  const btn=e.target.closest('[data-care]'); if(!btn) return;
  const p=getPet(); const sprite=$('#petSprite');
  switch(btn.dataset.care){
    case 'feed': p.hunger=Math.max(0,p.hunger-25); p.happiness=Math.min(100,p.happiness+8); sprite.classList.add('wag'); break;
    case 'bathe': p.cleanliness=Math.min(100,p.cleanliness+30); break;
    case 'play': p.energy=Math.max(0,p.energy-10); p.happiness=Math.min(100,p.happiness+12); sprite.classList.add('wag'); break;
    case 'sleep': p.energy=Math.min(100,p.energy+35); break;
  }
  p.coins+=1; savePet(p); renderPet();
  setTimeout(()=>sprite.classList.remove('wag'),1300);
});
const GACHA=['🎀','🎩','👑','🧣','🕶️','🦴','🌟','🎗️','💎','🧢'];
$('#gachaPull').addEventListener('click', () => {
  const p=getPet();
  if (p.coins<10){ toast('Need 10 🪙 — earn from games & streaks!'); return; }
  p.coins-=10;
  const prize=GACHA[Math.floor(Math.random()*GACHA.length)];
  if (!p.accessories.includes(prize)) p.accessories.push(prize);
  p.activeAcc=prize; savePet(p); renderPet(); confetti();
  toast(`✨ You got ${prize}!`);
  logActivity(`🎁 Pulled ${prize} from gacha`);
});
$('#gachaShelf').addEventListener('click', e => {
  const it=e.target.closest('[data-acc]'); if(!it) return;
  const p=getPet(); p.activeAcc = p.activeAcc===it.dataset.acc?null:it.dataset.acc;
  savePet(p); renderPet();
});

/* ===================================================================
   DATE IDEAS
   =================================================================== */
const DATE_SEED = [
  ["Virtual Movie Night","Watch the same movie at the same time and text reactions.","Virtual"],
  ["Cook the Same Recipe","Pick one recipe and cook it together on video call.","Food"],
  ["Online Game Night","Play your favorite games in this app or online.","Virtual"],
  ["Future Trip Planning","Plan a dream trip together, pick dates and places.","Adventure"],
  ["Sunset Sync","Watch the sunset together over video.","Intimate"],
  ["Read the Same Book","Start a two-person book club.","Creative"],
  ["Virtual Museum Tour","Explore a museum's online gallery together.","Creative"],
  ["Long-Distance Picnic","Both set up a picnic and eat 'together'.","Food"],
  ["Stargazing Call","Find constellations together at night.","Intimate"],
  ["Draw Each Other","Use the draw feature and reveal at once.","Creative"],
  ["Cocktail/Mocktail Hour","Make matching drinks and toast.","Food"],
  ["Workout Together","Do the same workout over video.","Adventure"],
  ["Playlist Swap","Make each other a playlist and listen together.","Creative"],
  ["Virtual Coffee Date","Morning coffee on video like a real café.","Food"],
  ["Truth or Dare","Long-distance edition over call.","Intimate"],
  ["Bake-Off","Bake the same thing, judge each other's.","Food"],
  ["Watch the Sunrise","Wake early and share the first light.","Intimate"],
  ["Virtual Game Show","Quiz each other with trivia.","Virtual"],
  ["Plan Your Future Home","Design your dream house together.","Creative"],
  ["Care Package Swap","Mail each other a surprise box.","Adventure"],
  ["Online Escape Room","Solve a digital escape room together.","Virtual"],
  ["Memory Lane Night","Look through old photos together.","Intimate"],
  ["Learn a Dance","Follow a tutorial on video.","Creative"],
  ["Write Love Letters","Write and read them aloud.","Intimate"],
  ["Virtual Travel Show","Watch a travel doc 'together'.","Virtual"],
  ["Same Takeout Night","Order the same cuisine.","Food"],
  ["Paint & Sip","Paint together with drinks.","Creative"],
  ["Plan a Surprise","Each plans a small surprise for the other.","Intimate"],
  ["Board Game by Mail","Play a game across distance.","Adventure"],
  ["Karaoke Call","Sing duets over video.","Creative"],
  ["Vision Board Night","Make vision boards together.","Creative"],
  ["Recipe Roulette","Random recipe, both cook it.","Food"],
  ["Constellation Quiz","Test astronomy knowledge.","Virtual"],
  ["Documentary Date","Pick a doc and discuss.","Virtual"],
  ["DIY Craft Night","Make matching crafts.","Creative"],
  ["Future Bucket List","Build a shared bucket list.","Adventure"],
  ["Dream Vacation Quiz","Quiz each other's travel dreams.","Adventure"],
  ["Sunset Photo Challenge","Both shoot the sky, compare.","Creative"],
  ["Midnight Snack Date","Late-night snack on call.","Food"],
  ["Story Building","Write a story one line at a time.","Creative"],
  ["Virtual Concert","Stream a live show together.","Virtual"],
  ["Compliment Battle","Take turns; sweetest wins.","Intimate"],
  ["Cookbook Challenge","Pick a cuisine for the month.","Food"],
  ["Plan Anniversary","Dream up your next anniversary.","Intimate"],
  ["Photo Scavenger Hunt","Find and photograph a list of things.","Adventure"],
  ["Language Lesson","Teach each other phrases.","Creative"],
  ["Movie Marathon","Pick a trilogy for the weekend.","Virtual"],
  ["Coffee Shop Hop","Visit local cafés, video in.","Food"],
  ["Build a Playlist Story","Songs that tell your story.","Creative"],
  ["Goodnight Routine","Create a nightly ritual together.","Intimate"]
];
function getDates() {
  let d = DB.get(K.dates, null);
  if (!d) { d = DATE_SEED.map((x,i)=>({id:i+1, title:x[0], desc:x[1], cat:x[2], done:false})); DB.set(K.dates, d); }
  return d;
}
let dateFilter='All';
const DATE_CATS=['All','Virtual','Food','Adventure','Creative','Intimate'];
function renderDates() {
  const dates=getDates();
  $('#dateFilters').innerHTML = DATE_CATS.map(c=>
    `<button class="filter-chip ${dateFilter===c?'active':''}" data-cat="${c}">${c}</button>`).join('');
  const filtered = dateFilter==='All'?dates:dates.filter(d=>d.cat===dateFilter);
  $('#dateList').innerHTML = filtered.map(d=>`
    <div class="date-card ${d.done?'done':''}">
      <h4>${escapeHtml(d.title)}</h4>
      <p>${escapeHtml(d.desc)}</p>
      <div class="d-foot"><span class="tag">${d.cat}</span>
      <button class="pill-btn" data-done="${d.id}">${d.done?'✓ Done':'Mark Done'}</button></div>
    </div>`).join('');
}
$('#dateFilters').addEventListener('click', e => {
  const chip=e.target.closest('[data-cat]'); if(!chip) return;
  dateFilter=chip.dataset.cat; renderDates();
});
$('#dateList').addEventListener('click', e => {
  const b=e.target.closest('[data-done]'); if(!b) return;
  const dates=getDates(); const d=dates.find(x=>x.id==b.dataset.done);
  d.done=!d.done; DB.set(K.dates,dates); renderDates();
  if (d.done) logActivity(`💡 Marked date done: ${d.title}`);
});
$('#randomDate').addEventListener('click', () => {
  const dates=getDates().filter(d=>!d.done);
  if (!dates.length){ toast('All dates done! Add more 💕'); return; }
  const d=dates[Math.floor(Math.random()*dates.length)];
  openModal(`<h3>🎲 ${escapeHtml(d.title)}</h3>
    <p style="font-size:14px;line-height:1.5">${escapeHtml(d.desc)}</p>
    <span class="tag">${d.cat}</span>
    <div class="modal-actions"><button class="pill-btn" data-close>Love it 💕</button></div>`);
});
$('#addDate').addEventListener('click', () => {
  openModal(`<h3>＋ Add Date Idea</h3>
    <input type="text" id="ndTitle" placeholder="Title" />
    <input type="text" id="ndDesc" placeholder="Description" />
    <select id="ndCat">${DATE_CATS.slice(1).map(c=>`<option>${c}</option>`).join('')}</select>
    <div class="modal-actions"><button class="pill-btn ghost" data-close>Cancel</button>
    <button class="pill-btn" id="ndSave">Add</button></div>`);
  $('#ndSave').addEventListener('click', () => {
    const t=$('#ndTitle').value.trim(); if(!t){toast('Add a title');return;}
    const dates=getDates();
    dates.unshift({id:now(), title:t, desc:$('#ndDesc').value.trim(), cat:$('#ndCat').value, done:false});
    DB.set(K.dates,dates); closeModal(); renderDates();
  });
});

/* ===================================================================
   DRAW
   =================================================================== */
let drawCtx, drawing=false, drawTool='pen', drawColor='#D4A5A5', drawStamp=null, drawInit=false;
function initDrawCanvas() {
  const canvas=$('#drawCanvas');
  if (!drawInit) {
    const rect=canvas.getBoundingClientRect();
    canvas.width=rect.width; canvas.height=340;
    drawCtx=canvas.getContext('2d');
    drawCtx.fillStyle='#fff'; drawCtx.fillRect(0,0,canvas.width,canvas.height);
    drawCtx.lineCap='round'; drawCtx.lineJoin='round';
    bindDrawEvents(canvas);
    drawInit=true;
  }
  renderDrawGallery();
}
function pos(canvas,e){
  const r=canvas.getBoundingClientRect();
  const x=(e.touches?e.touches[0].clientX:e.clientX)-r.left;
  const y=(e.touches?e.touches[0].clientY:e.clientY)-r.top;
  return {x,y};
}
function bindDrawEvents(canvas) {
  const start=e=>{ e.preventDefault();
    if (drawStamp){
      const {x,y}=pos(canvas,e);
      // Center the emoji on the tap point so it renders fully (no clipping).
      drawCtx.save();
      drawCtx.fillStyle='#000';            // reset (eraser may have left white)
      drawCtx.textAlign='center';
      drawCtx.textBaseline='middle';
      drawCtx.font='40px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",serif';
      drawCtx.fillText(drawStamp, x, y);
      drawCtx.restore();
      return;
    }
    drawing=true; const {x,y}=pos(canvas,e); drawCtx.beginPath(); drawCtx.moveTo(x,y);
  };
  const move=e=>{ if(!drawing||drawStamp) return; e.preventDefault();
    const {x,y}=pos(canvas,e);
    if (drawTool==='eraser'){ drawCtx.strokeStyle='#fff'; drawCtx.lineWidth=20; }
    else { drawCtx.strokeStyle=drawColor; drawCtx.lineWidth=drawTool==='brush'?8:3; }
    drawCtx.lineTo(x,y); drawCtx.stroke();
  };
  const end=()=>{ drawing=false; };
  canvas.addEventListener('mousedown',start); canvas.addEventListener('mousemove',move);
  canvas.addEventListener('mouseup',end); canvas.addEventListener('mouseleave',end);
  canvas.addEventListener('touchstart',start,{passive:false});
  canvas.addEventListener('touchmove',move,{passive:false});
  canvas.addEventListener('touchend',end);
}
$('#drawTools').addEventListener('click', e => {
  const tb=e.target.closest('.tool-btn'); if(!tb) return;
  if (tb.id==='drawClear'){ drawCtx.fillStyle='#fff'; drawCtx.fillRect(0,0,$('#drawCanvas').width,$('#drawCanvas').height); return; }
  if (tb.dataset.stamp){ drawStamp=tb.dataset.stamp; $$('.tool-btn').forEach(b=>b.classList.remove('active')); tb.classList.add('active'); return; }
  if (tb.dataset.tool){ drawTool=tb.dataset.tool; drawStamp=null; $$('.tool-btn').forEach(b=>b.classList.remove('active')); tb.classList.add('active'); }
});
$('#drawColor').addEventListener('input', e => { drawColor=e.target.value; });
$('#drawClear').addEventListener('click', () => {
  drawCtx.fillStyle='#fff'; drawCtx.fillRect(0,0,$('#drawCanvas').width,$('#drawCanvas').height);
});
function renderDrawTurn() {
  // Drawing syncs via the shared gallery (saved drawings appear for both on refresh).
  // This refreshes the gallery; identity bar handled inline on the draw page if present.
  if (typeof renderDrawGallery === 'function') renderDrawGallery();
}
function saveDrawing(forWho) {
  const url=$('#drawCanvas').toDataURL('image/png');
  const arr=DB.get(K.drawings, []);
  arr.unshift({ id:now(), img:url, for:forWho, from: deviceWho()||null, t:now() });
  DB.set(K.drawings, arr.slice(0,40));
  bumpStreak('draw'); renderDrawGallery();
  logActivity(`🎨 Drew something for ${forWho}`);
  toast(`Saved for ${forWho}! 🎨`);
}
$('#saveForLuke').addEventListener('click', ()=>saveDrawing(HIS()));
$('#saveForSophie').addEventListener('click', ()=>saveDrawing(HER()));
$('#exportDraw').addEventListener('click', () => {
  const a=document.createElement('a'); a.href=$('#drawCanvas').toDataURL('image/png');
  a.download='our-corner-drawing.png'; a.click();
});
function renderDrawGallery() {
  const arr=DB.get(K.drawings, []);
  $('#drawGallery').innerHTML = arr.map(d=>
    `<div class="dg-wrap"><img src="${d.img}" data-dg="${d.id}"><span class="dg-label">for ${d.for}</span></div>`).join('');
}
$('#drawGallery').addEventListener('click', e => {
  const im=e.target.closest('[data-dg]'); if(!im) return;
  openLightbox([{img:im.src, caption:''}],0);
});

/* ===================================================================
   PHOTO GALLERY
   =================================================================== */
function renderGallery() {
  const photos=DB.get(K.photos, []);
  const grid=$('#photoGrid');
  if (!photos.length){ grid.innerHTML='<p class="empty-inline" style="grid-column:1/-1;text-align:center">No photos yet 🖼️</p>'; return; }
  grid.innerHTML = photos.map((p,i)=>
    `<div class="ph-wrap"><img src="${p.img}" data-ph="${i}">${p.fav?'<span class="ph-fav">❤️</span>':''}</div>`).join('');
}
$('#addPhoto').addEventListener('click', ()=>$('#galleryInput').click());
$('#galleryInput').addEventListener('change', e => {
  const f=e.target.files[0]; if(!f) return;
  compressImage(f,900,url=>{
    const photos=DB.get(K.photos,[]);
    photos.unshift({ img:url, caption:'', fav:false, t:now() });
    DB.set(K.photos,photos); renderGallery();
    logActivity('🖼️ Added a photo to the gallery');
    toast('Photo added! 🖼️');
  });
});
$('#photoGrid').addEventListener('click', e => {
  const im=e.target.closest('[data-ph]'); if(!im) return;
  const photos=DB.get(K.photos,[]);
  openLightbox(photos.map(p=>({img:p.img,caption:p.caption})), +im.dataset.ph, +im.dataset.ph);
});

/* ===================================================================
   STATS
   =================================================================== */
function getStartDate() {
  let s=DB.get(K.start,null);
  if (!s){ s=todayStr(); DB.set(K.start,s); }
  return s;
}
function renderStats() {
  const days=Math.max(1,Math.floor((Date.now()-new Date(getStartDate()))/86400000)+1);
  const msgs=DB.get(K.messages,[]).length;
  const entries=DB.get(K.diary,[]).length;
  const g=DB.get(K.games,{});
  const gamesPlayed=DB.get(K.activity,[]).filter(a=>/Won a|game/.test(a.text)).length;
  const pet=getPet();
  const stats=[
    [days,'Days together 💖'], [msgs,'Love letters sent'],
    [entries,'Diary chapters'], [gamesPlayed,'Game nights'],
    [pet.happiness+'%','Puppy happiness'], [pet.coins,'Love coins 🪙']
  ];
  $('#statsGrid').innerHTML = stats.map(([n,l])=>
    `<div class="stat-card"><div class="stat-num">${n}</div><div class="stat-label">${l}</div></div>`).join('');
  drawMoodChart();
}
function drawMoodChart() {
  const canvas=$('#moodChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const w=canvas.width=canvas.offsetWidth, h=canvas.height;
  ctx.clearRect(0,0,w,h);
  const hist=DB.get('ourCorner_moodHist',[]);
  const positivity={Amazing:10,Happy:9,Excited:9,Adoring:9,Romantic:9,Grateful:8,Celebratory:9,Energetic:8,Playful:8,Optimistic:8,Confident:7,Peaceful:7,Relaxed:7,Content:7,Chill:6,Cuddly:8,Flirty:7,Passionate:8,Inspired:8,Silly:7,Goofy:7,Cute:7,Neutral:5,Tired:4,Lonely:3,Sad:2,Stressed:3,Anxious:3,Frustrated:3,Overwhelmed:2,Angry:2,'Fired Up':7};
  const pts=hist.slice(-14).map(x=>positivity[x.mood]??5);
  if (pts.length<2){ ctx.fillStyle='#9a9088'; ctx.font='13px Open Sans'; ctx.fillText('Track moods to see trends 💕',10,h/2); return; }
  const max=10,min=0;
  ctx.strokeStyle='#D4A5A5'; ctx.lineWidth=2; ctx.beginPath();
  pts.forEach((v,i)=>{ const x=(i/(pts.length-1))*(w-20)+10; const y=h-((v-min)/(max-min))*(h-20)-10;
    i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
  ctx.stroke();
  ctx.fillStyle='#C8B8E8';
  pts.forEach((v,i)=>{ const x=(i/(pts.length-1))*(w-20)+10; const y=h-((v-min)/(max-min))*(h-20)-10;
    ctx.beginPath(); ctx.arc(x,y,3,0,7); ctx.fill(); });
}

/* ===================================================================
   PRAYER
   =================================================================== */
const SCRIPTURES = [
  "Love is patient, love is kind. — 1 Corinthians 13:4",
  "Above all, love each other deeply. — 1 Peter 4:8",
  "Two are better than one. — Ecclesiastes 4:9",
  "Let all that you do be done in love. — 1 Corinthians 16:14",
  "Be completely humble and gentle; be patient, bearing with one another in love. — Ephesians 4:2",
  "Many waters cannot quench love. — Song of Solomon 8:7",
  "And now these three remain: faith, hope and love. — 1 Corinthians 13:13",
  "A friend loves at all times. — Proverbs 17:17",
  "Hatred stirs up conflict, but love covers all wrongs. — Proverbs 10:12",
  "Let us love one another, for love comes from God. — 1 John 4:7",
  "Bear with each other and forgive one another. — Colossians 3:13",
  "Do everything in love. — 1 Corinthians 16:14",
  "Place me like a seal over your heart. — Song of Solomon 8:6",
  "He who finds love finds a good thing. — Proverbs 18:22",
  "Encourage one another and build each other up. — 1 Thessalonians 5:11"
];
function getPrayers(){ return DB.get(K.prayers, []); }
function renderPrayer() {
  const day=Math.floor(Date.now()/86400000)%SCRIPTURES.length;
  $('#scripture').textContent = SCRIPTURES[day];
  const s=getStreaks();
  $('#prayerStreak').textContent = s.pray?.count || 0;
  $('#prayedToday').checked = s.pray?.last === todayStr();
  const prayers=getPrayers();
  $('#prayerList').innerHTML = prayers.length
    ? prayers.map(p=>`<div class="prayer-item ${p.answered?'answered':''}">
        <input type="checkbox" data-pr="${p.id}" ${p.answered?'checked':''}>
        <span class="pr-text">${escapeHtml(p.text)}</span>
        <button class="pr-del" data-prd="${p.id}">✕</button></div>`).join('')
    : '<p class="muted" style="font-size:13px">No prayer requests yet 🙏</p>';
}
$('#prayedToday').addEventListener('change', e => {
  if (e.target.checked){ bumpStreak('pray'); logActivity('🙏 Prayed together today'); toast('🙏 Logged — beautiful'); }
  renderPrayer();
});
$('#addPrayer').addEventListener('click', () => {
  openModal(`<h3>🙏 New Prayer Request</h3>
    <input type="text" id="prText" placeholder="What are you praying for?" />
    <div class="modal-actions"><button class="pill-btn ghost" data-close>Cancel</button>
    <button class="pill-btn" id="prSave">Add</button></div>`);
  $('#prSave').addEventListener('click', () => {
    const t=$('#prText').value.trim(); if(!t){toast('Write a request');return;}
    const p=getPrayers(); p.unshift({id:now(),text:t,answered:false});
    DB.set(K.prayers,p); closeModal(); renderPrayer();
  });
});
$('#prayerList').addEventListener('click', e => {
  const chk=e.target.closest('[data-pr]'); const del=e.target.closest('[data-prd]');
  if (chk){ const p=getPrayers(); const it=p.find(x=>x.id==chk.dataset.pr); it.answered=!it.answered; DB.set(K.prayers,p); renderPrayer();
    if (it.answered) toast('🙌 Answered prayer!'); }
  if (del){ DB.set(K.prayers, getPrayers().filter(x=>x.id!=del.dataset.prd)); renderPrayer(); }
});

/* ===================================================================
   LOVE MAP
   =================================================================== */
function renderMap() {
  const s=getSettings();
  $('#lukeCity').value=s.lukeCity||'';
  $('#sophieCity').value=s.sophieCity||'';
  if (s.lukeCity && s.sophieCity)
    $('#distanceText').textContent = `🦂 ${s.lukeCity}  ···  🌸 ${s.sophieCity} — together in heart 💞`;
  else $('#distanceText').textContent = 'Set your cities below 💞';
}
$('#saveCities').addEventListener('click', () => {
  const s=getSettings();
  s.lukeCity=$('#lukeCity').value.trim(); s.sophieCity=$('#sophieCity').value.trim();
  saveSettings(s); renderMap(); toast('Locations saved 🗺️');
});

/* ===================================================================
   SETTINGS
   =================================================================== */
function renderSettingsPage() {
  const s=getSettings();
  $('#setPetName').value=s.petName;
  $('#setLukeAvatar').value=s.lukeAvatar;
  $('#setSophieAvatar').value=s.sophieAvatar;
  $('#setNotify').checked=s.notify;
}
$('#saveSettings').addEventListener('click', () => {
  const s=getSettings();
  s.petName=$('#setPetName').value.trim()||'Our Puppy';
  s.lukeAvatar=$('#setLukeAvatar').value.trim()||'🦂';
  s.sophieAvatar=$('#setSophieAvatar').value.trim()||'🌸';
  saveSettings(s);
  const p=getPet(); p.name=s.petName; savePet(p);
  $('#msgWho').textContent = msgWho==='luke'?s.lukeAvatar:s.sophieAvatar;
  toast('Settings saved ⚙️');
});
$('#setNotify').addEventListener('change', async e => {
  const s=getSettings();
  if (e.target.checked && 'Notification' in window) {
    const perm=await Notification.requestPermission();
    s.notify = perm==='granted';
    if (!s.notify){ e.target.checked=false; toast('Notifications blocked'); }
    else toast('Reminders on 🔔');
  } else s.notify=false;
  saveSettings(s);
});
$('#exportData').addEventListener('click', () => {
  const dump={};
  Object.values(K).forEach(k=>{ const v=localStorage.getItem(k); if(v) dump[k]=v; });
  ['ourCorner_moodHist','ourCorner_wyr'].forEach(k=>{ const v=localStorage.getItem(k); if(v) dump[k]=v; });
  const blob=new Blob([JSON.stringify(dump,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='our-corner-backup.json'; a.click();
  toast('Backup downloaded ⬆️');
});
$('#importDataBtn').addEventListener('click', ()=>$('#importDataInput').click());
$('#importDataInput').addEventListener('change', e => {
  const f=e.target.files[0]; if(!f) return;
  const reader=new FileReader();
  reader.onload=()=>{ try { const data=JSON.parse(reader.result);
    Object.entries(data).forEach(([k,v])=>localStorage.setItem(k,v));
    toast('Data imported! Reloading…'); setTimeout(()=>location.reload(),1000);
  } catch { toast('Invalid backup file'); } };
  reader.readAsText(f);
});
$('#resetData').addEventListener('click', () => {
  if (confirm('Erase ALL data? This cannot be undone.')) {
    Object.keys(localStorage).filter(k=>k.startsWith('ourCorner_')).forEach(k=>localStorage.removeItem(k));
    toast('Everything reset'); setTimeout(()=>location.reload(),800);
  }
});

/* ===================================================================
   MODAL / LIGHTBOX / CONFETTI / IMAGE COMPRESSION
   =================================================================== */
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalOverlay').hidden = false;
}
function closeModal() { $('#modalOverlay').hidden = true; $('#modal').innerHTML=''; }
$('#modalOverlay').addEventListener('click', e => {
  if (e.target.id==='modalOverlay' || e.target.closest('[data-close]')) closeModal();
});

let lbImages=[], lbIndex=0, lbPhotoIdx=null;
function openLightbox(images, index, photoIdx=null) {
  lbImages=images; lbIndex=index; lbPhotoIdx=photoIdx;
  $('#lightbox').hidden=false; showLb();
}
function showLb() {
  const im=lbImages[lbIndex]; if(!im) return;
  $('#lbImg').src=im.img;
  $('#lbCaption').textContent=im.caption||'';
  $('#lbPrev').style.display = lbImages.length>1?'block':'none';
  $('#lbNext').style.display = lbImages.length>1?'block':'none';
}
$('#lbPrev').addEventListener('click', ()=>{ lbIndex=(lbIndex-1+lbImages.length)%lbImages.length; showLb(); });
$('#lbNext').addEventListener('click', ()=>{ lbIndex=(lbIndex+1)%lbImages.length; showLb(); });
$('#lbClose').addEventListener('click', ()=>{ $('#lightbox').hidden=true; });
$('#lightbox').addEventListener('click', e=>{ if(e.target.id==='lightbox') $('#lightbox').hidden=true; });

function confetti() {
  const canvas=$('#confettiCanvas');
  canvas.width=innerWidth; canvas.height=innerHeight;
  const ctx=canvas.getContext('2d');
  const colors=['#D4A5A5','#C8B8E8','#B8C5B6','#e8b96a','#fff'];
  const parts=Array.from({length:120},()=>({
    x:Math.random()*canvas.width, y:-20-Math.random()*canvas.height*0.3,
    vx:(Math.random()-0.5)*4, vy:Math.random()*4+2,
    s:Math.random()*8+4, c:colors[Math.floor(Math.random()*colors.length)],
    rot:Math.random()*360, vr:(Math.random()-0.5)*10
  }));
  let frames=0;
  (function anim(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    parts.forEach(p=>{ p.x+=p.vx; p.y+=p.vy; p.vy+=0.08; p.rot+=p.vr;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot*Math.PI/180);
      ctx.fillStyle=p.c; ctx.fillRect(-p.s/2,-p.s/2,p.s,p.s); ctx.restore();
    });
    frames++;
    if (frames<150) requestAnimationFrame(anim);
    else ctx.clearRect(0,0,canvas.width,canvas.height);
  })();
}

function compressImage(file, maxDim, cb) {
  const reader=new FileReader();
  reader.onload=e=>{
    const img=new Image();
    img.onload=()=>{
      let {width,height}=img;
      if (width>height && width>maxDim){ height=height*maxDim/width; width=maxDim; }
      else if (height>maxDim){ width=width*maxDim/height; height=maxDim; }
      const canvas=document.createElement('canvas');
      canvas.width=width; canvas.height=height;
      canvas.getContext('2d').drawImage(img,0,0,width,height);
      cb(canvas.toDataURL('image/jpeg',0.8));
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ===================================================================
   NIGHT MODE
   =================================================================== */
$('#nightToggle').addEventListener('click', () => {
  const s=getSettings(); s.night=!s.night; saveSettings(s);
  document.body.classList.toggle('night', s.night);
  $('#nightToggle').textContent = s.night?'☀️':'🌙';
});

/* ===================================================================
   NOTIFICATIONS (simple in-session reminder)
   =================================================================== */
function scheduleReminders() {
  const s=getSettings();
  if (!s.notify || !('Notification' in window) || Notification.permission!=='granted') return;
  // gentle reminder once per session after 30 min idle-ish
  setTimeout(()=>{
    try { new Notification('Our Corner 💖', { body:'Answer today\'s question & check on your puppy! 🐶' }); }
    catch {}
  }, 30*60*1000);
}

/* ===================================================================
   INIT
   =================================================================== */
function init() {
  const s=getSettings();
  document.body.classList.toggle('night', s.night);
  $('#nightToggle').textContent = s.night?'☀️':'🌙';
  $('#msgWho').textContent = s.lukeAvatar;
  getStartDate();
  // seed first diary entry
  if (!DB.get(K.diary, []).length) {
    DB.set(K.diary, [{ id:now(), t:now(),
      title:'Day 1 of Our Corner',
      body:`${HIS()} & ${HER()} start their digital love journey 💖`,
      tags:['firstday'], photos:[] }]);
  }
  getDates();
  renderDashboard();
  scheduleReminders();
  // live countdown refresh
  setInterval(()=>{ if ($('#page-home').classList.contains('active')) renderCountdowns(); }, 60000);
  /* service worker registered by shell */
}
/* v3: boot handled by shell after couple login (init->enterCoupleApp) */
window.enterCoupleApp = init;/* ===================================================================
   OUR CORNER v2 — admin.js
   Admin login + dashboard + account create/edit/reset/delete/stats.
   All data access via Store/Auth (swap-safe).
   =================================================================== */
'use strict';

const CATEGORIES = ['daily','romance','sexual','deep','funny','faith','adventure'];
const CAT_LABEL = { daily:'Daily', romance:'Romance', sexual:'Sexual', deep:'Deep',
                    funny:'Funny', faith:'Faith', adventure:'Adventure' };

const Admin = {
  page: 1, perPage: 10, search: '', filter: 'all',

  async showLogin() {
    showScreen('adminLogin');
    const cred = await Auth.ensureAdmin();
    const hint = $('#adminHint');
    if (hint) hint.hidden = !cred.mustChange;
  },

  async doLogin() {
    const u = $('#adminUser').value.trim();
    const p = $('#adminPass').value;
    if (await Auth.adminLogin(u, p)) {
      $('#adminPass').value = '';
      await this.dashboard();
    } else {
      toast('Wrong admin username or password');
    }
  },

  async dashboard() {
    showScreen('adminDash');
    await this.renderAccounts();
    const cred = await Auth.ensureAdmin();
    if (cred.mustChange) toast('Default admin in use — change the password in Settings!');
  },

  async renderAccounts() {
    const all = await Store.allAccounts();
    let rows = all.slice();
    if (this.filter !== 'all') rows = rows.filter(a => a.status === this.filter);
    if (this.search) {
      const q = this.search.toLowerCase();
      rows = rows.filter(a =>
        (a.username||'').toLowerCase().includes(q) ||
        (a.displayName||'').toLowerCase().includes(q) ||
        (a.hisName||'').toLowerCase().includes(q) ||
        (a.herName||'').toLowerCase().includes(q));
    }
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / this.perPage));
    if (this.page > pages) this.page = pages;
    const slice = rows.slice((this.page-1)*this.perPage, this.page*this.perPage);

    // totals
    $('#adminTotalAccounts').textContent = all.filter(a=>a.status==='active').length;
    let usedMB = 0;
    for (const a of all) usedMB += await Store.storageUsedMB(a.accountId);
    $('#adminTotalStorage').textContent = usedMB.toFixed(2) + ' MB';

    const body = $('#acctRows');
    if (!slice.length) {
      body.innerHTML = `<tr><td colspan="7" class="muted center">No accounts. Click “Create New Account”.</td></tr>`;
    } else {
      body.innerHTML = slice.map(a => `
        <tr>
          <td>${escapeHtml(a.displayName)}</td>
          <td>${escapeHtml(a.hisName)}</td>
          <td>${escapeHtml(a.herName)}</td>
          <td>${escapeHtml(a.username)}</td>
          <td>${new Date(a.createdAt).toLocaleDateString()}</td>
          <td><span class="badge ${a.status}">${a.status}</span></td>
          <td class="actions">
            <button data-aedit="${a.accountId}" title="Edit">✏️</button>
            <button data-apass="${a.accountId}" title="Reset password">🔑</button>
            <button data-astats="${a.accountId}" title="View stats">📊</button>
            <button data-aexport="${a.accountId}" title="Export data">⬇️</button>
            <button data-adel="${a.accountId}" title="Delete">🗑️</button>
          </td>
        </tr>`).join('');
    }
    $('#acctPageInfo').textContent = `Page ${this.page} / ${pages} · ${total} result${total!==1?'s':''}`;
    $('#acctPrev').disabled = this.page <= 1;
    $('#acctNext').disabled = this.page >= pages;
  },

  /* ---------- create ---------- */
  createModal() {
    openModal(`
      <h3>Create New Account</h3>
      <div class="grid2">
        <label>His Name*<input id="cHis" type="text"></label>
        <label>Her Name*<input id="cHer" type="text"></label>
      </div>
      <label>Account Display Name*<input id="cDisplay" type="text" placeholder="e.g. Alex & Sam"></label>
      <div class="grid2">
        <label>Username*<input id="cUser" type="text" autocapitalize="off"></label>
        <label>Email (optional)<input id="cEmail" type="email"></label>
      </div>
      <div class="grid2">
        <label>Password* (min 6)<input id="cPass" type="password"></label>
        <label>Confirm Password*<input id="cPass2" type="password"></label>
      </div>
      <label>Storage Quota (MB)<input id="cQuota" type="number" value="500" min="50"></label>
      <fieldset class="cats"><legend>Categories Enabled</legend>
        ${CATEGORIES.map(c=>`<label class="ck"><input type="checkbox" class="cCat" value="${c}" checked> ${CAT_LABEL[c]}</label>`).join('')}
      </fieldset>
      <div class="modal-actions">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" id="cCreate">Create Account</button>
      </div>
    `);
    $('#cCreate').onclick = () => this.createSubmit();
  },

  async createSubmit() {
    const his = $('#cHis').value.trim(), her = $('#cHer').value.trim();
    const display = $('#cDisplay').value.trim(), user = $('#cUser').value.trim();
    const pass = $('#cPass').value, pass2 = $('#cPass2').value;
    const email = $('#cEmail').value.trim();
    const quota = Math.max(50, +$('#cQuota').value || 500);
    const cats = $$('.cCat').filter(x=>x.checked).map(x=>x.value);
    if (!his || !her || !display || !user) return toast('Fill all required fields');
    if (pass.length < 6) return toast('Password must be at least 6 characters');
    if (pass !== pass2) return toast('Passwords do not match');
    const accts = await Store.allAccounts();
    if (accts.some(a => a.username.toLowerCase() === user.toLowerCase()))
      return toast('That username is taken');

    const acct = {
      accountId: uid('acct'), hisName: his, herName: her, displayName: display,
      username: user, passwordHash: await sha256(pass), email,
      storageQuota: quota, categoriesEnabled: cats.length?cats:CATEGORIES.slice(),
      createdAt: new Date().toISOString(), status: 'active', lastLogin: null
    };
    await Store.putAccount(acct);
    // seed that account's starter data
    await Store.use(acct.accountId);
    seedAccount(acct);
    await Store.flushNow();

    closeModal();
    openModal(`
      <h3>✅ Account Created</h3>
      <p>Share these credentials with the couple. The password is shown only once.</p>
      <div class="cred-box">
        <div><span>Username</span><b>${escapeHtml(user)}</b></div>
        <div><span>Password</span><b>${escapeHtml(pass)}</b></div>
      </div>
      <div class="modal-actions"><button class="btn primary" data-close>Done</button></div>
    `);
    this.renderAccounts();
  },

  /* ---------- edit ---------- */
  async editModal(id) {
    const a = (await Store.allAccounts()).find(x=>x.accountId===id); if (!a) return;
    openModal(`
      <h3>Edit Account</h3>
      <div class="grid2">
        <label>His Name<input id="eHis" value="${escapeHtml(a.hisName)}"></label>
        <label>Her Name<input id="eHer" value="${escapeHtml(a.herName)}"></label>
      </div>
      <label>Display Name<input id="eDisplay" value="${escapeHtml(a.displayName)}"></label>
      <label>Email<input id="eEmail" value="${escapeHtml(a.email||'')}"></label>
      <label>Storage Quota (MB)<input id="eQuota" type="number" value="${a.storageQuota}"></label>
      <fieldset class="cats"><legend>Categories Enabled</legend>
        ${CATEGORIES.map(c=>`<label class="ck"><input type="checkbox" class="eCat" value="${c}" ${a.categoriesEnabled.includes(c)?'checked':''}> ${CAT_LABEL[c]}</label>`).join('')}
      </fieldset>
      <div class="modal-actions">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" id="eSave">Save Changes</button>
      </div>
    `);
    $('#eSave').onclick = async () => {
      a.hisName = $('#eHis').value.trim() || a.hisName;
      a.herName = $('#eHer').value.trim() || a.herName;
      a.displayName = $('#eDisplay').value.trim() || a.displayName;
      a.email = $('#eEmail').value.trim();
      a.storageQuota = +$('#eQuota').value || a.storageQuota;
      a.categoriesEnabled = $$('.eCat').filter(x=>x.checked).map(x=>x.value);
      await Store.putAccount(a);
      closeModal(); toast('Account updated'); this.renderAccounts();
    };
  },

  /* ---------- reset password ---------- */
  async passModal(id) {
    const a = (await Store.allAccounts()).find(x=>x.accountId===id); if (!a) return;
    openModal(`
      <h3>Reset Password</h3>
      <label>Username<input value="${escapeHtml(a.username)}" readonly></label>
      <label>New Password (min 6)<input id="rPass" type="password"></label>
      <label>Confirm New Password<input id="rPass2" type="password"></label>
      <div class="modal-actions">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" id="rSave">Reset Password</button>
      </div>
    `);
    $('#rSave').onclick = async () => {
      const p = $('#rPass').value, p2 = $('#rPass2').value;
      if (p.length < 6) return toast('Min 6 characters');
      if (p !== p2) return toast('Passwords do not match');
      a.passwordHash = await sha256(p);
      await Store.putAccount(a);
      closeModal(); toast('Password reset');
    };
  },

  /* ---------- delete ---------- */
  async delModal(id) {
    const a = (await Store.allAccounts()).find(x=>x.accountId===id); if (!a) return;
    openModal(`
      <h3>Delete Account</h3>
      <p>Delete <b>${escapeHtml(a.displayName)}</b> (@${escapeHtml(a.username)}) and ALL its data? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn danger" id="dDel">Delete Permanently</button>
      </div>
    `);
    $('#dDel').onclick = async () => {
      await Store.deleteAccountHard(id);
      closeModal(); toast('Account deleted'); this.renderAccounts();
    };
  },

  /* ---------- stats ---------- */
  async statsModal(id) {
    const a = (await Store.allAccounts()).find(x=>x.accountId===id); if (!a) return;
    await Store.use(id);
    const msgs = Store.get('messages', []).length;
    const diary = Store.get('diary', []).length;
    const qa = Object.keys(Store.get('questionAnswers', {})).length;
    const usedMB = await Store.storageUsedMB(id);
    openModal(`
      <h3>${escapeHtml(a.displayName)} — Stats</h3>
      <div class="stat-mini-grid">
        <div><b>${msgs}</b><span>Messages</span></div>
        <div><b>${diary}</b><span>Diary entries</span></div>
        <div><b>${qa}</b><span>Questions answered</span></div>
        <div><b>${usedMB}</b><span>MB used / ${a.storageQuota}MB</span></div>
        <div><b>${a.lastLogin?new Date(a.lastLogin).toLocaleDateString():'never'}</b><span>Last login</span></div>
        <div><b>${a.categoriesEnabled.length}</b><span>Categories</span></div>
      </div>
      <div class="modal-actions"><button class="btn primary" data-close>Close</button></div>
    `);
  },

  async exportAccount(id) {
    const a = (await Store.allAccounts()).find(x=>x.accountId===id); if (!a) return;
    const data = await Store.adapter.loadAccount(id);
    const out = { account: { ...a, passwordHash: '[redacted]' }, data };
    downloadJSON(out, `our-corner-${a.username}.json`);
    toast('Exported');
  },

  bindOnce() {
    $('#adminLoginBtn').onclick = () => this.doLogin();
    $('#toCoupleLogin').onclick = (e) => { e.preventDefault(); Couple.showLogin(); };
    $('#adminCreateBtn').onclick = () => this.createModal();
    $('#acctSearch').oninput = (e) => { this.search = e.target.value; this.page=1; this.renderAccounts(); };
    $('#acctFilter').onchange = (e) => { this.filter = e.target.value; this.page=1; this.renderAccounts(); };
    $('#acctPrev').onclick = () => { if(this.page>1){this.page--; this.renderAccounts();} };
    $('#acctNext').onclick = () => { this.page++; this.renderAccounts(); };
    $('#adminLogout').onclick = () => { Auth.logout(); Couple.showLogin(); };
    $('#adminNavAccounts').onclick = () => switchAdminView('accounts');
    $('#adminNavStats').onclick = () => switchAdminView('stats');
    $('#adminNavSettings').onclick = () => switchAdminView('settings');
    $('#adminPassChange').onclick = async () => {
      const p = $('#adminNewPass').value;
      if (p.length < 6) return toast('Min 6 characters');
      await Auth.setAdminPassword(p); $('#adminNewPass').value='';
      toast('Admin password changed');
    };
    // delegated row actions
    $('#acctRows').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.aedit) this.editModal(b.dataset.aedit);
      else if (b.dataset.apass) this.passModal(b.dataset.apass);
      else if (b.dataset.adel) this.delModal(b.dataset.adel);
      else if (b.dataset.astats) this.statsModal(b.dataset.astats);
      else if (b.dataset.aexport) this.exportAccount(b.dataset.aexport);
    });
  }
};

function switchAdminView(which) {
  ['accounts','stats','settings'].forEach(v => {
    const el = $('#adminView_'+v); if (el) el.hidden = (v !== which);
    const nav = $('#adminNav'+v[0].toUpperCase()+v.slice(1)); if (nav) nav.classList.toggle('on', v===which);
  });
  if (which==='stats') Admin.renderAdminStats && Admin.renderAdminStats();
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
/* ===================================================================
   OUR CORNER v3 — shell.js (part 3 of the bundle)
   Couple login + screen switching + per-account seed + boot.
   Loads AFTER core.js and admin.js, and AFTER v3_features.js in the
   bundle so it can call enterCoupleApp() (v1 init) and v1 helpers.
   =================================================================== */
'use strict';

/* global app state used by v1 feature code via window.App */
window.App = window.App || { account: null, current: 'home' };

/* screen switcher between the four top-level screens */
function showScreen(id){
  ['adminLogin','adminDash','coupleLogin','coupleApp'].forEach(s=>{
    const el = document.getElementById('screen_'+s);
    if (el) el.hidden = (s !== id);
  });
}

/* admin.js calls downloadJSON; v1 didn't define it */
function downloadJSON(obj, filename){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

/* per-account seed run at account creation (admin) — sets name-bearing
   defaults; v1's init() lazily seeds diary/dates/startDate on first entry. */
function seedAccount(acct){
  Store.set('settings', {
    petName:'Our Puppy',
    lukeAvatar:'🦂', sophieAvatar:'🌸',
    notify:false, night:false, lukeCity:'', sophieCity:''
  });
  Store.set('startDate', new Date().toISOString().slice(0,10));
}

/* ---------- Couple login ---------- */
const Couple = {
  showLogin(){
    showScreen('coupleLogin');
    const sess = Auth.session();
    if (sess && sess.role === 'couple') this.resume(sess.accountId);
  },
  async doLogin(){
    const u = document.getElementById('coupleUser').value.trim();
    const p = document.getElementById('couplePass').value;
    const remember = document.getElementById('rememberMe').checked;
    const acct = await Auth.coupleLogin(u, p, remember);
    if (!acct) return toast('Wrong username or password');
    document.getElementById('couplePass').value = '';
    await this.enter(acct);
  },
  async resume(accountId){
    const acct = (await Store.allAccounts()).find(a => a.accountId===accountId && a.status==='active');
    if (acct) await this.enter(acct); else Auth.logout();
  },
  async enter(acct){
    App.account = acct;
    await Store.use(acct.accountId);
    showScreen('coupleApp');
    // v1's init() seeds + renders the dashboard (now name-aware via HIS()/HER())
    window.enterCoupleApp();
    toast(`Welcome back, ${acct.hisName} & ${acct.herName}! 💖`);
  },
  bindOnce(){
    document.getElementById('coupleLoginBtn').onclick = () => this.doLogin();
    document.getElementById('toAdminLogin').onclick = (e)=>{ e.preventDefault(); Admin.showLogin(); };
    document.getElementById('forgotPass').onclick = (e)=>{ e.preventDefault(); toast('Contact admin to reset your password'); };
    document.getElementById('couplePass').addEventListener('keydown', e=>{ if(e.key==='Enter') this.doLogin(); });
  }
};

/* ---------- Logout hook: v1 settings page has its own logout? add one ---------- */
window.coupleLogout = async function(){
  await Store.flushNow(); Auth.logout(); App.account=null; Couple.showLogin();
};

/* ---------- Boot ---------- */
async function boot(){
  await Store.init();
  Admin.bindOnce();
  Couple.bindOnce();

  const sess = Auth.session();
  if (sess && sess.role==='couple') Couple.resume(sess.accountId);
  else if (sess && sess.role==='admin') Admin.dashboard();
  else Couple.showLogin();

  if (navigator.serviceWorker){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', boot);
else boot();