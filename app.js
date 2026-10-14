/* ClearScan — 画面とデータの制御 */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = '') => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATS = [
  { id: 'doc', label: '書類', color: 'var(--sky)', icon: 'file', opts: { mode: 'auto', shadow: true, finger: true, clean: true } },
  { id: 'book', label: '書籍', color: 'var(--orange)', icon: 'book', opts: { mode: 'auto', shadow: true, finger: true, clean: true } },
  { id: 'receipt', label: '領収書', color: 'var(--green)', icon: 'receipt', opts: { mode: 'auto', shadow: true, finger: true, clean: true } },
  { id: 'id', label: '身分証', color: 'var(--purple)', icon: 'idcard', opts: { mode: 'photo', shadow: false, finger: true, clean: false } },
  { id: 'note', label: 'メモ', color: 'var(--pink)', icon: 'note', opts: { mode: 'color', shadow: true, finger: true, clean: true } },
  { id: 'other', label: 'その他', color: 'var(--teal)', icon: 'shapes', opts: { mode: 'color', shadow: true, finger: false, clean: false } },
];
const catOf = (id) => CATS.find((c) => c.id === id) || CATS[0];
const MODES = [
  { id: 'auto', label: '自動補正' }, { id: 'color', label: 'カラー' }, { id: 'gray', label: 'グレー' },
  { id: 'bw', label: '白黒' }, { id: 'photo', label: '写真' }, { id: 'original', label: '補正なし' },
];

// ---------------- 設定 ----------------
const DEFAULTS = {
  autoCapture: true, category: 'doc', quality: '0.85', maxSide: '2400',
  autoOCR: true, ocrLang: 'jpn+eng', vertical: false,
  driveClientId: '', driveFolder: 'ClearScan', driveFolderId: '', theme: 'auto', exportFormat: 'pdf',
};
const S = (() => {
  let v = {};
  try { v = JSON.parse(localStorage.getItem('clearscan-settings') || '{}'); } catch (_) { v = {}; }
  return { ...DEFAULTS, ...v };
})();
function saveSettings() { try { localStorage.setItem('clearscan-settings', JSON.stringify(S)); } catch (_) { /* 保存できなくても動作は続ける */ } }
function applyTheme() {
  if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', S.theme);
}
applyTheme();

// ---------------- データベース ----------------
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('clearscan', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('docs', { keyPath: 'id' });
        d.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (st, k) => run(st, 'readonly', (s) => s.get(k)),
    put: (st, v) => run(st, 'readwrite', (s) => s.put(v)),
    del: (st, k) => run(st, 'readwrite', (s) => s.delete(k)),
    all: (st) => run(st, 'readonly', (s) => s.getAll()),
  };
})();

// ---------------- 画像ユーティリティ ----------------
function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toBlob(canvas, q) { return new Promise((res) => canvas.toBlob(res, 'image/jpeg', q)); }
function drawScaled(src, sw, sh, maxSide) {
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = canvasOf(Math.round(sw * s), Math.round(sh * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
async function makeThumb(canvas) {
  const t = drawScaled(canvas, canvas.width, canvas.height, 420);
  return toBlob(t, 0.8);
}
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
function detectOn(canvas) {
  const small = drawScaled(canvas, canvas.width, canvas.height, 300);
  const data = small.getContext('2d').getImageData(0, 0, small.width, small.height);
  const r = Imaging.detectQuad(data);
  return r ? r.corners : null;
}

// オブジェクトURLのキャッシュ
const URLS = new Map();
function blobURL(key, blob) {
  const prev = URLS.get(key);
  if (prev && prev.blob === blob) return prev.url;
  if (prev) URL.revokeObjectURL(prev.url);
  const url = URL.createObjectURL(blob);
  URLS.set(key, { blob, url });
  return url;
}

// ---------------- 画像処理キュー(ワーカー) ----------------
const Proc = {
  worker: null, seq: 0, waits: new Map(), queue: [], busy: false, listeners: new Set(), idleWaiters: [],
  init() {
    this.worker = new Worker('worker.js');
    this.worker.onmessage = (e) => { const w = this.waits.get(e.data.id); if (w) { this.waits.delete(e.data.id); e.data.ok ? w.res(e.data) : w.rej(new Error(e.data.error)); } };
  },
  call(imgData, corners, opts, maxSide, part) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.worker.postMessage({ id, width: imgData.width, height: imgData.height, buffer: imgData.data.buffer, corners, opts, maxSide, part }, [imgData.data.buffer]);
    });
  },
  enqueue(pageId) {
    if (!this.queue.includes(pageId)) this.queue.push(pageId);
    this.pump();
  },
  pending(pageId) { return this.queue.includes(pageId) || this.current === pageId; },
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const id = this.queue.shift();
      this.current = id;
      try { await processPage(id); } catch (err) { console.error(err); }
      this.current = null;
      this.listeners.forEach((fn) => fn(id));
    }
    this.busy = false;
    this.idleWaiters.splice(0).forEach((r) => r());
  },
  idle() { return this.busy || this.queue.length ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve(); },
};

async function processPage(pageId) {
  const page = await DB.get('pages', pageId);
  if (!page) return;
  const img = await loadImage(page.original);
  const src = drawScaled(img, img.naturalWidth, img.naturalHeight, 3200);
  const data = src.getContext('2d').getImageData(0, 0, src.width, src.height);
  const opts = { ...page.opts, split: !!page.splitWith };
  const r = await Proc.call(data, page.corners, opts, Number(S.maxSide), page.part || 0);
  let out = canvasOf(r.width, r.height);
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
  const rot = ((page.rotation || 0) % 360 + 360) % 360;
  if (rot) {
    const rc = rot % 180 ? canvasOf(out.height, out.width) : canvasOf(out.width, out.height);
    const ctx = rc.getContext('2d');
    ctx.translate(rc.width / 2, rc.height / 2); ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(out, -out.width / 2, -out.height / 2);
    out = rc;
  }
  const fresh = await DB.get('pages', pageId);
  if (!fresh) return;
  fresh.processed = await toBlob(out, Number(S.quality));
  fresh.thumb = await makeThumb(out);
  fresh.pw = out.width; fresh.ph = out.height;
  fresh.status = 'done';
  // 画像が変わったら文字認識はやり直し(手で直したテキストは残す)
  if (fresh.ocr && !fresh.ocr.edited) fresh.ocr = null;
  await DB.put('pages', fresh);
  await refreshDocCover(fresh.docId);
  if (S.autoOCR && !fresh.ocr) OCR.enqueue(pageId);
}

// ---------------- 文字認識 ----------------
// 文字認識エンジン(tesseract.js 5.1.1)と認識データはアプリと一緒に配信する(外部CDNに頼らない)
const TESS_DIR = new URL('vendor/tesseract/', location.href).href;
const TESS_URL = TESS_DIR + 'tesseract.min.js';
const OCR = {
  worker: null, lang: '', queue: [], busy: false, current: null, progress: 0, status: '', listeners: new Set(),
  notify() { this.listeners.forEach((fn) => fn()); },
  enqueue(pageId) { if (!this.queue.includes(pageId) && this.current !== pageId) this.queue.push(pageId); this.pump(); this.notify(); },
  pending(pageId) { return this.queue.includes(pageId) || this.current === pageId; },
  async loadLib() {
    if (window.Tesseract) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = TESS_URL; s.onload = res; s.onerror = () => rej(new Error('文字認識エンジンを読み込めませんでした'));
      document.head.appendChild(s);
    });
  },
  async getWorker() {
    const lang = S.vertical ? S.ocrLang.replace('jpn', 'jpn_vert') : S.ocrLang;
    if (this.worker && this.lang === lang) return this.worker;
    if (this.worker) { await this.worker.terminate(); this.worker = null; }
    await this.loadLib();
    this.status = '認識データを準備中…'; this.notify();
    this.worker = await Tesseract.createWorker(lang, 1, {
      workerPath: TESS_DIR + 'worker.min.js',
      corePath: TESS_DIR + 'core',
      langPath: TESS_DIR + 'lang',
      workerBlobURL: false,
      logger: (m) => {
        if (m.status === 'recognizing text') { this.progress = m.progress; this.status = '文字を認識中…'; }
        else if (/loading|initializ/.test(m.status)) { this.progress = m.progress || 0; this.status = '認識データを準備中…'; }
        this.notify();
      },
    });
    if (S.vertical) await this.worker.setParameters({ tessedit_pageseg_mode: '5' });
    this.lang = lang;
    return this.worker;
  },
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      // 撮影中はカメラを優先し、文字認識は後回しにする
      while (state.screen === 'camera') await sleep(600);
      const id = this.queue.shift();
      this.current = id; this.progress = 0; this.notify();
      try {
        const page = await DB.get('pages', id);
        if (page && page.processed) {
          const w = await this.getWorker();
          const { data } = await w.recognize(page.processed);
          const fresh = await DB.get('pages', id);
          if (fresh) {
            const W = fresh.pw || 1, H = fresh.ph || 1;
            const lines = (data.lines || [])
              .filter((l) => l.confidence > 35 && l.text.trim())
              .map((l) => ({ t: cleanText(l.text), b: [l.bbox.x0 / W, l.bbox.y0 / H, l.bbox.x1 / W, l.bbox.y1 / H] }));
            fresh.ocr = { text: lines.map((l) => l.t).join('\n'), lines, at: Date.now(), edited: false };
            await DB.put('pages', fresh);
            await refreshDocText(fresh.docId);
          }
        }
      } catch (err) {
        console.error(err);
        toast(err.message || '文字認識に失敗しました', true);
        this.queue.length = 0;
      }
      this.current = null; this.notify();
    }
    this.busy = false; this.status = ''; this.notify();
  },
};
// 日本語の文字間に入る余分な空白を取り除く
function cleanText(s) {
  // Tesseract は円記号を \ と読むことがある
  let t = s.replace(/[ \t]+\n/g, '\n').replace(/\\(?=\s?\d)/g, '¥').trim();
  for (let i = 0; i < 2; i++) t = t.replace(/([^\x00-\x7F]) +([^\x00-\x7F])/g, '$1$2');
  return t;
}

// ---------------- ドキュメント操作 ----------------
function fmtDate(t) {
  const d = new Date(t), now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今日 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function defaultTitle(cat) {
  const d = new Date();
  return `${catOf(cat).label} ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}
async function createDoc(category) {
  const doc = { id: uid(), title: defaultTitle(category), category, createdAt: Date.now(), updatedAt: Date.now(), pageIds: [], cover: null, text: '' };
  await DB.put('docs', doc);
  return doc;
}
async function touchDoc(id, fn) {
  const doc = await DB.get('docs', id);
  if (!doc) return null;
  fn && fn(doc);
  doc.updatedAt = Date.now();
  await DB.put('docs', doc);
  return doc;
}
async function refreshDocCover(docId) {
  const doc = await DB.get('docs', docId);
  if (!doc || !doc.pageIds.length) return;
  const first = await DB.get('pages', doc.pageIds[0]);
  if (first && first.thumb && doc.cover !== first.thumb) { doc.cover = first.thumb; await DB.put('docs', doc); }
}
async function refreshDocText(docId) {
  const doc = await DB.get('docs', docId);
  if (!doc) return;
  const texts = [];
  for (const pid of doc.pageIds) { const p = await DB.get('pages', pid); if (p && p.ocr) texts.push(p.ocr.text); }
  doc.text = texts.join('\n\n');
  await DB.put('docs', doc);
}

/* 1枚の元画像からページを作る(見開き分割なら2ページ) */
async function addCapture(docId, blob, corners, opts, split) {
  const base = { docId, original: blob, corners: corners || FULL, opts: { ...opts }, rotation: 0, processed: null, thumb: null, status: 'pending', ocr: null, createdAt: Date.now() };
  const pages = [];
  if (split) {
    const a = { ...base, id: uid(), part: 0 }, b = { ...base, id: uid(), part: 1 };
    a.splitWith = b.id; b.splitWith = a.id;
    pages.push(a, b);
  } else pages.push({ ...base, id: uid(), part: 0 });
  for (const p of pages) await DB.put('pages', p);
  await touchDoc(docId, (d) => d.pageIds.push(...pages.map((p) => p.id)));
  pages.forEach((p) => Proc.enqueue(p.id));
  return pages;
}

async function deleteDoc(docId) {
  const doc = await DB.get('docs', docId);
  if (!doc) return;
  for (const pid of doc.pageIds) await DB.del('pages', pid);
  await DB.del('docs', docId);
}

async function importFiles(files, docId) {
  if (!files.length) return null;
  toast(`${files.length}件を読み込み中…`);
  // 先に全ファイルを画像として読めるか確かめ、読めたものだけを取り込む
  const ok = [];
  let skipped = 0;
  for (const f of files) {
    try {
      if (f.type && !f.type.startsWith('image/')) throw new Error('not image');
      const img = await loadImage(f);
      const c = drawScaled(img, img.naturalWidth, img.naturalHeight, 3200);
      ok.push({ blob: await toBlob(c, 0.92), corners: detectOn(c) || FULL });
    } catch (_) { skipped++; }
  }
  if (!ok.length) {
    toast(files.length > 1 ? '読み込める画像がありませんでした(PDFなどは非対応です)' : 'このファイルは読み込めません(画像のみ対応・PDFなどは非対応です)', true);
    return null;
  }
  let doc = docId ? await DB.get('docs', docId) : null;
  if (!doc) doc = await createDoc(S.category);
  const cat = catOf(doc.category);
  for (const p of ok) await addCapture(doc.id, p.blob, p.corners, cat.opts, false);
  if (skipped) toast(`${skipped}件は画像ではないため読み込みませんでした`, true);
  return doc.id;
}

// ---------------- 画面遷移 ----------------
const state = { screen: 'library', docId: null, pageId: null, tab: 'pages', filter: 'all', query: '' };
function go(screen, params = {}, replace = false) {
  Object.assign(state, params, { screen });
  const snap = { screen: state.screen, docId: state.docId, pageId: state.pageId };
  history[replace ? 'replaceState' : 'pushState'](snap, '');
  render();
}
function back() {
  if (history.state && history.state.screen !== 'library' && history.length > 1) history.back();
  else go('library', {}, true);
}
window.addEventListener('popstate', (e) => {
  const s = e.state || { screen: 'library' };
  Object.assign(state, s);
  render();
});

let currentScreen = null;
function render() {
  if (currentScreen === 'camera' && state.screen !== 'camera') Cam.stop();
  if (currentScreen === 'edit' && state.screen !== 'edit') Editor.leave();
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === state.screen));
  const changed = currentScreen !== state.screen;
  currentScreen = state.screen;
  if (changed) window.scrollTo(0, 0);
  ({ library: renderLibrary, camera: () => Cam.start(state.docId), doc: renderDoc, edit: () => Editor.open(state.pageId), settings: renderSettings }[state.screen] || renderLibrary)();
}
$$('[data-back]').forEach((b) => b.addEventListener('click', back));

// ---------------- トースト ----------------
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.classList.toggle('err', !!err);
  $('use', t).setAttribute('href', err ? '#i-alert' : '#i-check-circle');
  $('span', t).textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4200 : 2400);
}

// ---------------- ライブラリ ----------------
const norm = (s) => (s || '').normalize('NFKC').toLowerCase();
function snippet(text, q) {
  const t = text.replace(/\s+/g, ' ');
  const i = norm(t).indexOf(q);
  if (i < 0) return '';
  const start = Math.max(0, i - 18);
  const part = t.slice(start, i + q.length + 50);
  return (start > 0 ? '…' : '') + highlight(part, q);
}
function highlight(text, q) {
  if (!q) return esc(text);
  const n = norm(text);
  let out = '', pos = 0, i;
  // NFKC で長さが変わらない範囲を前提に、正規化文字列で位置を探す
  if (n.length !== text.length) return esc(text);
  while ((i = n.indexOf(q, pos)) >= 0) {
    out += esc(text.slice(pos, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>';
    pos = i + q.length;
  }
  return out + esc(text.slice(pos));
}

async function renderLibrary() {
  const docs = (await DB.all('docs')).sort((a, b) => b.updatedAt - a.updatedAt);
  $('#libCount').textContent = docs.length ? `${docs.length}件のドキュメント` : '';
  $('#libFilters').innerHTML = [`<button class="chip ${state.filter === 'all' ? 'on' : ''}" data-f="all">すべて</button>`]
    .concat(CATS.map((c) => `<button class="chip ${state.filter === c.id ? 'on' : ''}" data-f="${c.id}"><span class="dot" style="background:${c.color}"></span>${c.label}</button>`)).join('');
  const q = norm($('#libSearch').value.trim());
  const list = docs.filter((d) => (state.filter === 'all' || d.category === state.filter) && (!q || norm(d.title).includes(q) || norm(d.text).includes(q)));
  const el = $('#libList');
  if (!docs.length) {
    el.innerHTML = `<div class="empty">
      <div class="stickers">
        <div class="sticker" style="background:var(--sky);--rot:-8deg">${icon('file')}</div>
        <div class="sticker" style="background:var(--orange);--rot:4deg">${icon('book')}</div>
        <div class="sticker" style="background:var(--green);--rot:-3deg">${icon('receipt')}</div>
        <div class="sticker" style="background:var(--purple);--rot:7deg">${icon('idcard')}</div>
      </div>
      <h2 class="h2">最初の1枚をスキャン</h2>
      <p>書類・書籍・領収書・身分証・メモ。影や指の映り込みを自動で消して、文字まで検索できるPDFにします。</p>
    </div>`;
    return;
  }
  if (!list.length) { el.innerHTML = `<div class="empty"><h2 class="h2">見つかりません</h2><p>別のことばで検索してみてください。</p></div>`; return; }
  el.innerHTML = `<div class="grid">${list.map((d, i) => {
    const c = catOf(d.category);
    const cover = d.cover ? `<img src="${blobURL('cover:' + d.id, d.cover)}" alt="">` : `<div class="stack"><div class="spinner"></div></div>`;
    const snip = q && !norm(d.title).includes(q) ? `<div class="snip">${snippet(d.text, q)}</div>` : '';
    return `<button class="doc-card" data-id="${d.id}" style="animation-delay:${Math.min(i, 10) * 30}ms">
      <div class="thumb">${cover}<div class="pages"><span class="badge">${d.pageIds.length}ページ</span></div></div>
      <div class="name">${highlight(d.title, q)}</div>
      <div class="meta"><span class="dot" style="background:${c.color}"></span>${c.label} · ${fmtDate(d.updatedAt)}</div>${snip}
    </button>`;
  }).join('')}</div>`;
}
$('#libFilters').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) { state.filter = b.dataset.f; renderLibrary(); } });
$('#libSearch').addEventListener('input', () => renderLibrary());
$('#libList').addEventListener('click', (e) => { const c = e.target.closest('.doc-card'); if (c) go('doc', { docId: c.dataset.id, tab: 'pages' }); });
$('#scanBtn').addEventListener('click', () => go('camera', { docId: null }));
$('#openSettings').addEventListener('click', () => go('settings'));
let importTarget = null;
$('#importBtn').addEventListener('click', () => { importTarget = null; $('#fileInput').click(); });
$('#fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const target = importTarget;
  const id = await importFiles(files, target);
  if (!id) return;
  if (state.screen === 'doc' && state.docId === id) renderDoc();
  else go('doc', { docId: id, tab: 'pages' }, state.screen === 'camera');
});

// ---------------- カメラ ----------------
const Cam = {
  stream: null, track: null, running: false, timer: 0, quad: null, stableCount: 0, armed: true, moved: true,
  prevGray: null, docId: null, count: 0, cat: S.category, split: false, busy: false, torch: false,
  async start(docId) {
    this.docId = docId; this.count = 0; this.quad = null; this.armed = true; this.moved = true; this.stableCount = 0;
    if (docId) { const d = await DB.get('docs', docId); if (d) this.cat = d.category; }
    else this.cat = S.category;
    this.renderCats(); this.renderAuto(); this.updateThumb(null);
    $('#camMsg').classList.remove('show');
    this.status('カメラを起動中…');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      if (state.screen !== 'camera') { this.stop(); return; }
      const v = $('#camVideo');
      v.srcObject = this.stream;
      await v.play().catch(() => {});
      this.track = this.stream.getVideoTracks()[0];
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      $('#camTorch').hidden = !caps.torch;
      this.running = true;
      this.loop();
    } catch (err) {
      const msg = location.protocol !== 'https:' && location.hostname !== 'localhost'
        ? 'カメラを使うには https で開く必要があります。'
        : 'カメラを使えませんでした。設定でカメラへのアクセスを許可するか、写真から読み込んでください。';
      $('#camMsgText').textContent = msg;
      $('#camMsg').classList.add('show');
      this.status('カメラなし');
    }
  },
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null;
    const v = $('#camVideo'); v.srcObject = null;
    const c = $('#camOverlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  },
  status(t) { $('#camStatus').textContent = t; },
  renderCats() {
    $('#camCats').innerHTML = CATS.map((c) => `<button data-c="${c.id}" class="${c.id === this.cat ? 'on' : ''}">${c.label}</button>`).join('');
    $('#camSplit').hidden = this.cat !== 'book';
    $('#camSplit').classList.toggle('on', this.split);
  },
  renderAuto() {
    $('#camAuto').classList.toggle('on', !!S.autoCapture);
    $('#camShutter').classList.toggle('auto', !!S.autoCapture);
  },
  frameGray(v) {
    const c = this._small || (this._small = canvasOf(1, 1));
    const s = 260 / Math.max(v.videoWidth, v.videoHeight);
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  },
  loop() {
    if (!this.running) return;
    const v = $('#camVideo');
    if (v.videoWidth) {
      const t0 = performance.now();
      const frame = this.frameGray(v);
      // 動き量(ページめくり検出)
      const g = new Uint8Array(frame.width * frame.height);
      for (let i = 0; i < g.length; i++) g[i] = frame.data[i * 4 + 1];
      let motion = 0;
      if (this.prevGray && this.prevGray.length === g.length) {
        let s = 0; for (let i = 0; i < g.length; i += 3) s += Math.abs(g[i] - this.prevGray[i]);
        motion = s / (g.length / 3);
      }
      this.prevGray = g;
      if (motion > 9) this.moved = true;

      const r = Imaging.detectQuad(frame);
      if (r) {
        const q = r.corners;
        if (this.quad) {
          const d = Math.max(...q.map((p, i) => Math.hypot(p[0] - this.quad[i][0], p[1] - this.quad[i][1])));
          this.stableCount = d < 0.025 && motion < 6 ? this.stableCount + 1 : 0;
          this.quad = q.map((p, i) => [this.quad[i][0] * 0.4 + p[0] * 0.6, this.quad[i][1] * 0.4 + p[1] * 0.6]);
        } else { this.quad = q; this.stableCount = 0; }
        this.lost = 0;
      } else {
        this.lost = (this.lost || 0) + 1;
        if (this.lost > 2) { this.quad = null; this.stableCount = 0; this.moved = true; }
      }
      this.draw();
      if (!this.busy) {
        if (!this.quad) this.status('書類を画面に入れてください');
        else if (S.autoCapture && !(this.armed && this.moved)) this.status('次のページへ');
        else if (S.autoCapture) this.status(this.stableCount >= 2 ? '撮影します' : 'そのまま動かさないで');
        else this.status('シャッターを押してください');
      }
      if (S.autoCapture && this.quad && this.armed && this.moved && this.stableCount >= 3 && !this.busy) this.capture(true);
      this.timer = setTimeout(() => this.loop(), Math.max(60, 180 - (performance.now() - t0)));
    } else {
      this.timer = setTimeout(() => this.loop(), 120);
    }
  },
  draw() {
    const v = $('#camVideo'), c = $('#camOverlay');
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (c.width !== Math.round(cw * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!this.quad || !v.videoWidth) return;
    const s = Math.max(cw / v.videoWidth, ch / v.videoHeight);
    const dx = (cw - v.videoWidth * s) / 2, dy = (ch - v.videoHeight * s) / 2;
    const pts = this.quad.map(([x, y]) => [x * v.videoWidth * s + dx, y * v.videoHeight * s + dy]);
    const ready = this.stableCount >= 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = ready ? 'rgba(35,131,226,.28)' : 'rgba(35,131,226,.16)';
    ctx.fill();
    ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.strokeStyle = ready ? '#2383e2' : 'rgba(255,255,255,.9)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); });
  },
  async capture(auto) {
    const v = $('#camVideo');
    if (!v.videoWidth || this.busy) return;
    this.busy = true;
    try {
      const fl = $('#camFlash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      if (navigator.vibrate) navigator.vibrate(15);
      const c = drawScaled(v, v.videoWidth, v.videoHeight, 3200);
      const corners = this.quad ? this.quad.map((p) => [...p]) : (detectOn(c) || FULL);
      const blob = await toBlob(c, 0.92);
      if (!this.docId) this.docId = (await createDoc(this.cat)).id;
      const pages = await addCapture(this.docId, blob, corners, catOf(this.cat).opts, this.cat === 'book' && this.split);
      this.count += pages.length;
      this.updateThumb(c);
      this.status(auto ? '撮影しました ・ 次のページへ' : '撮影しました');
      this.armed = false; this.moved = false; this.stableCount = 0;
      // 少し待ってから次の自動撮影を受け付ける
      setTimeout(() => { this.armed = true; }, 900);
    } catch (err) {
      toast(err.message || '撮影に失敗しました', true);
    }
    this.busy = false;
  },
  updateThumb(canvas) {
    const t = $('#camThumb');
    $('b', t).textContent = this.count;
    t.classList.toggle('show', this.count > 0);
    $('#camDone').classList.toggle('show', this.count > 0);
    if (canvas) {
      const small = drawScaled(canvas, canvas.width, canvas.height, 160);
      $('img', t).src = small.toDataURL('image/jpeg', 0.7);
      t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
    }
  },
  finish() {
    if (this.docId && this.count) go('doc', { docId: this.docId, tab: 'pages' }, true);
    else back();
  },
};
$('#camCats').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  Cam.cat = b.dataset.c; S.category = Cam.cat; saveSettings();
  if (Cam.docId) await touchDoc(Cam.docId, (d) => { d.category = Cam.cat; });
  Cam.renderCats();
});
$('#camSplit').addEventListener('click', () => { Cam.split = !Cam.split; Cam.renderCats(); });
$('#camAuto').addEventListener('click', () => { S.autoCapture = !S.autoCapture; saveSettings(); Cam.renderAuto(); toast(S.autoCapture ? '自動撮影をオンにしました' : '自動撮影をオフにしました'); });
$('#camTorch').addEventListener('click', async () => {
  if (!Cam.track) return;
  Cam.torch = !Cam.torch;
  try { await Cam.track.applyConstraints({ advanced: [{ torch: Cam.torch }] }); } catch (_) { Cam.torch = false; }
  $('#camTorch').classList.toggle('on', Cam.torch);
});
$('#camShutter').addEventListener('click', () => Cam.capture(false));
$('#camDone').addEventListener('click', () => Cam.finish());
$('#camThumb').addEventListener('click', () => Cam.finish());
$('#camClose').addEventListener('click', () => Cam.finish());
$('#camImport').addEventListener('click', () => { importTarget = Cam.docId; $('#fileInput').click(); });

// ---------------- ドキュメント画面 ----------------
let docRenderToken = 0;
async function renderDoc() {
  const token = ++docRenderToken;
  const doc = await DB.get('docs', state.docId);
  if (!doc) { go('library', {}, true); return; }
  const pages = [];
  for (const id of doc.pageIds) { const p = await DB.get('pages', id); if (p) pages.push(p); }
  if (token !== docRenderToken) return;
  const c = catOf(doc.category);
  if (document.activeElement !== $('#docTitle')) $('#docTitle').value = doc.title;
  const cs = $('#docCat');
  $('.dot', cs).style.background = c.color;
  $('span:nth-child(2)', cs).textContent = c.label;
  $('select', cs).innerHTML = CATS.map((x) => `<option value="${x.id}" ${x.id === doc.category ? 'selected' : ''}>${x.label}</option>`).join('');
  $('#docInfo').textContent = `${pages.length}ページ · ${fmtDate(doc.createdAt)}`;
  $$('#docTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  $('#docPages').hidden = state.tab !== 'pages';
  $('#docText').hidden = state.tab !== 'text';
  if (state.tab === 'pages') {
    $('#docPages').innerHTML = pages.map((p, i) => {
      const img = p.thumb ? `<img src="${blobURL('thumb:' + p.id, p.thumb)}" alt="">` : `<div class="stack"><div class="spinner"></div></div>`;
      let tag = '';
      if (p.ocr) tag = `<span class="ocr-tag done">${icon('check', 'sm')}文字認識済み</span>`;
      else if (OCR.pending(p.id)) tag = `<span class="ocr-tag"><span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span>認識中</span>`;
      return `<button class="page-card" data-id="${p.id}"><div class="thumb">${img}</div><div class="num"><span>${i + 1}</span>${tag}</div></button>`;
    }).join('') + `<button class="add-card" id="addPage"><div>${icon('camera', 'lg')}ページを追加</div></button>`;
  } else renderDocText(doc, pages);
}
async function renderDocText(doc, pages) {
  const box = $('#docText');
  const q = norm((box.querySelector('#textQuery') || {}).value || '');
  const hasText = pages.some((p) => p.ocr && p.ocr.text);
  const running = pages.some((p) => OCR.pending(p.id));
  if (!hasText) {
    box.innerHTML = `<div class="card text-empty">${running
      ? `<div class="ocr-progress" style="justify-content:center"><span class="spinner"></span><span id="ocrStatus">${OCR.status || '文字を認識中…'}</span></div>`
      : `まだ文字認識されていません。<br><button class="btn-primary" id="runOCR">${icon('text')}文字を認識する</button>`}</div>`;
    return;
  }
  if (!box.querySelector('#textQuery')) {
    box.innerHTML = `<div class="text-tools">
        <label class="search">${icon('search', 'sm')}<input id="textQuery" type="search" placeholder="このドキュメント内を検索" autocomplete="off"></label>
        <button class="btn-utility" id="copyAll">${icon('copy', 'sm')}コピー</button>
      </div><div id="textPages"></div>`;
  }
  $('#textPages').innerHTML = pages.map((p, i) => {
    const t = p.ocr ? p.ocr.text : '';
    const status = p.ocr ? (p.ocr.edited ? '編集済み' : '') : (OCR.pending(p.id) ? '認識中…' : '未認識');
    const body = q ? `<div class="hl">${highlight(t, q) || '<span class="caption">(なし)</span>'}</div>`
      : `<textarea data-id="${p.id}" placeholder="テキストなし">${esc(t)}</textarea>`;
    return `<div class="card text-page"><div class="eyebrow"><span>ページ ${i + 1}</span><span>${status}</span></div>${body}</div>`;
  }).join('') + (running ? '' : `<div style="text-align:center;padding:4px 0 8px"><button class="btn-utility" id="rerunOCR">${icon('rotate', 'sm')}文字認識をやり直す</button></div>`);
  if (q) {
    const n = pages.reduce((a, p) => a + (p.ocr ? (norm(p.ocr.text).split(q).length - 1) : 0), 0);
    $('#textPages').insertAdjacentHTML('afterbegin', `<div class="caption" style="margin:-4px 2px 10px">${n}件ヒット</div>`);
  }
}
$('#docTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { state.tab = b.dataset.tab; $('#docText').innerHTML = ''; renderDoc(); } });
$('#docPages').addEventListener('click', (e) => {
  if (e.target.closest('#addPage')) { go('camera', { docId: state.docId }); return; }
  const c = e.target.closest('.page-card'); if (c) go('edit', { pageId: c.dataset.id });
});
$('#docTitle').addEventListener('change', async (e) => {
  const v = e.target.value.trim(); if (!v) return;
  await touchDoc(state.docId, (d) => { d.title = v; });
});
$('#docTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('#docCat select').addEventListener('change', async (e) => { await touchDoc(state.docId, (d) => { d.category = e.target.value; }); renderDoc(); });
$('#docDelete').addEventListener('click', async () => {
  if (!confirm('このドキュメントを削除しますか?\n(元に戻せません)')) return;
  await deleteDoc(state.docId);
  toast('削除しました');
  go('library', {}, true);
});
$('#docText').addEventListener('click', async (e) => {
  if (e.target.closest('#runOCR') || e.target.closest('#rerunOCR')) {
    const doc = await DB.get('docs', state.docId);
    const redo = !!e.target.closest('#rerunOCR');
    if (redo && !confirm('手で編集したテキストも上書きされます。やり直しますか?')) return;
    for (const id of doc.pageIds) {
      if (redo) { const p = await DB.get('pages', id); if (p) { p.ocr = null; await DB.put('pages', p); } }
      OCR.enqueue(id);
    }
    $('#docText').innerHTML = '';
    renderDoc();
  }
  if (e.target.closest('#copyAll')) {
    const doc = await DB.get('docs', state.docId);
    try { await navigator.clipboard.writeText(doc.text || ''); toast('テキストをコピーしました'); } catch (_) { toast('コピーできませんでした', true); }
  }
});
$('#docText').addEventListener('input', (e) => {
  if (e.target.id === 'textQuery') { renderDoc(); return; }
  const ta = e.target.closest('textarea[data-id]'); if (!ta) return;
  clearTimeout(ta._t);
  ta._t = setTimeout(async () => {
    const p = await DB.get('pages', ta.dataset.id); if (!p) return;
    p.ocr = { ...(p.ocr || { lines: [] }), text: ta.value, edited: true, at: Date.now() };
    await DB.put('pages', p);
    await refreshDocText(p.docId);
  }, 400);
});
// 処理・認識の進み具合を画面に反映
let liveTimer;
function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    if (state.screen === 'doc') {
      const st = $('#ocrStatus');
      if (st && OCR.current) st.textContent = `${OCR.status || '文字を認識中…'} ${Math.round(OCR.progress * 100)}%`;
      if (!document.activeElement || document.activeElement.tagName !== 'TEXTAREA') renderDoc();
    } else if (state.screen === 'library') renderLibrary();
  }, 250);
}
Proc.listeners.add(scheduleLive);
let lastOcrCurrent = null;
OCR.listeners.add(() => {
  const st = $('#ocrStatus');
  if (st && OCR.current) st.textContent = `${OCR.status || '文字を認識中…'} ${Math.round(OCR.progress * 100)}%`;
  if (OCR.current !== lastOcrCurrent) { lastOcrCurrent = OCR.current; scheduleLive(); }
});

// ---------------- ページ編集 ----------------
const Editor = {
  page: null, tab: 'enhance', corners: null, img: null, dirty: false,
  async open(pageId) {
    const page = await DB.get('pages', pageId);
    if (!page) { back(); return; }
    this.page = page; this.tab = 'enhance'; this.corners = page.corners.map((p) => [...p]);
    const doc = await DB.get('docs', page.docId);
    const idx = doc ? doc.pageIds.indexOf(page.id) : 0;
    $('#editTitle').textContent = `ページ ${idx + 1} / ${doc ? doc.pageIds.length : 1}`;
    $('#splitRow').hidden = !(doc && doc.category === 'book') && !page.splitWith;
    this.syncControls();
    this.showTab();
  },
  leave() { $('#cropSvg').hidden = true; },
  // 画像をステージに収まる大きさにする(切り抜き枠を画像にぴったり重ねるため)
  fit() {
    const img = $('#editImg'), st = $('#stage');
    if (!img.naturalWidth) return;
    const aw = st.clientWidth - 40, ah = st.clientHeight - 24;
    const s = Math.min(aw / img.naturalWidth, ah / img.naturalHeight);
    img.style.width = Math.round(img.naturalWidth * s) + 'px';
    img.style.height = Math.round(img.naturalHeight * s) + 'px';
  },
  async setImg(url) {
    const img = $('#editImg');
    if (img.getAttribute('src') !== url) { img.src = url; await img.decode().catch(() => {}); }
    this.fit();
  },
  syncControls() {
    const o = this.page.opts;
    $('#modeChips').innerHTML = MODES.map((m) => `<button class="chip ${o.mode === m.id ? 'on' : ''}" data-m="${m.id}">${m.label}</button>`).join('');
    $('#optShadow').checked = !!o.shadow; $('#optFinger').checked = !!o.finger; $('#optClean').checked = !!o.clean;
    $('#optSplit').checked = !!this.page.splitWith;
    const disabled = o.mode === 'original';
    ['#optShadow', '#optFinger', '#optClean'].forEach((s) => { $(s).disabled = disabled; $(s).closest('.toggle-row').style.opacity = disabled ? .45 : 1; });
  },
  async showTab() {
    $$('#editTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    $('#editPanel').classList.toggle('crop-mode', this.tab === 'crop');
    if (this.tab === 'crop') {
      await this.setImg(blobURL('orig:' + this.page.id, this.page.original));
      $('#cropSvg').hidden = false;
      this.drawCrop();
    } else {
      $('#cropSvg').hidden = true;
      this.showProcessed();
    }
  },
  showProcessed() {
    const busy = Proc.pending(this.page.id) || !this.page.processed;
    $('#editBusy').classList.toggle('show', busy);
    this.setImg(this.page.processed ? blobURL('proc:' + this.page.id, this.page.processed) : blobURL('orig:' + this.page.id, this.page.original));
  },
  drawCrop() {
    const svg = $('#cropSvg'), img = $('#editImg');
    const w = img.clientWidth, h = img.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const pts = this.corners.map(([x, y]) => [x * w, y * h]);
    svg.innerHTML = `<polygon points="${pts.map((p) => p.join(',')).join(' ')}"/>` +
      pts.map(([x, y], i) => `<circle class="hit" data-i="${i}" cx="${x}" cy="${y}" r="24"/><circle class="h" data-i="${i}" cx="${x}" cy="${y}" r="9" pointer-events="none"/>`).join('');
  },
  async save(reprocess = true) {
    await DB.put('pages', this.page);
    if (this.page.splitWith) {
      const sib = await DB.get('pages', this.page.splitWith);
      if (sib) { sib.corners = this.page.corners; sib.opts = { ...this.page.opts }; await DB.put('pages', sib); if (reprocess) Proc.enqueue(sib.id); }
    }
    await touchDoc(this.page.docId);
    if (reprocess) { Proc.enqueue(this.page.id); this.showProcessed(); }
  },
  async reload() {
    const p = await DB.get('pages', this.page.id);
    if (p) { this.page = p; if (this.tab === 'enhance') this.showProcessed(); }
  },
};
Proc.listeners.add((id) => { if (state.screen === 'edit' && Editor.page && Editor.page.id === id) Editor.reload(); });
$('#editTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]'); if (!b || b.dataset.tab === Editor.tab) return;
  if (Editor.tab === 'crop' && Editor.dirty) applyCrop();
  Editor.tab = b.dataset.tab; Editor.showTab();
});
$('#modeChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  Editor.page.opts.mode = b.dataset.m;
  Editor.syncControls(); Editor.save();
});
[['#optShadow', 'shadow'], ['#optFinger', 'finger'], ['#optClean', 'clean']].forEach(([sel, key]) => {
  $(sel).addEventListener('change', (e) => { Editor.page.opts[key] = e.target.checked; Editor.save(); });
});
$('#optSplit').addEventListener('change', async (e) => {
  const p = Editor.page;
  const doc = await DB.get('docs', p.docId);
  if (e.target.checked && !p.splitWith) {
    const sib = { ...p, id: uid(), part: 1, processed: null, thumb: null, status: 'pending', ocr: null };
    p.part = 0; p.splitWith = sib.id; sib.splitWith = p.id;
    await DB.put('pages', sib);
    doc.pageIds.splice(doc.pageIds.indexOf(p.id) + 1, 0, sib.id);
    await DB.put('docs', doc);
    Proc.enqueue(sib.id);
  } else if (!e.target.checked && p.splitWith) {
    const sibId = p.splitWith;
    await DB.del('pages', sibId);
    doc.pageIds = doc.pageIds.filter((x) => x !== sibId);
    await DB.put('docs', doc);
    p.splitWith = null; p.part = 0;
  }
  await Editor.save();
  Editor.open(p.id);
});
$('#editRotate').addEventListener('click', () => { Editor.page.rotation = ((Editor.page.rotation || 0) + 90) % 360; Editor.save(); });
async function movePage(delta) {
  const doc = await DB.get('docs', Editor.page.docId);
  const i = doc.pageIds.indexOf(Editor.page.id), j = i + delta;
  if (j < 0 || j >= doc.pageIds.length) return;
  [doc.pageIds[i], doc.pageIds[j]] = [doc.pageIds[j], doc.pageIds[i]];
  await DB.put('docs', doc);
  await refreshDocCover(doc.id); await refreshDocText(doc.id);
  $('#editTitle').textContent = `ページ ${j + 1} / ${doc.pageIds.length}`;
  toast(`${j + 1}ページ目に移動しました`);
}
$('#editMoveL').addEventListener('click', () => movePage(-1));
$('#editMoveR').addEventListener('click', () => movePage(1));
$('#editDelete').addEventListener('click', async () => {
  if (!confirm('このページを削除しますか?')) return;
  const p = Editor.page;
  const doc = await DB.get('docs', p.docId);
  if (p.splitWith) { const sib = await DB.get('pages', p.splitWith); if (sib) { sib.splitWith = null; await DB.put('pages', sib); Proc.enqueue(sib.id); } }
  await DB.del('pages', p.id);
  doc.pageIds = doc.pageIds.filter((x) => x !== p.id);
  if (!doc.pageIds.length) { await DB.del('docs', doc.id); toast('ドキュメントを削除しました'); go('library', {}, true); return; }
  await DB.put('docs', doc);
  doc.cover = null; await DB.put('docs', doc); await refreshDocCover(doc.id); await refreshDocText(doc.id);
  back();
});
// 四隅のドラッグ
(() => {
  const svg = $('#cropSvg');
  let drag = -1;
  svg.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('[data-i]');
    if (!t) return;
    drag = Number(t.dataset.i); svg.setPointerCapture(e.pointerId); e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const r = $('#editImg').getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    Editor.corners[drag] = [x, y]; Editor.dirty = true;
    Editor.drawCrop();
  });
  const end = () => { drag = -1; };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
})();
async function applyCrop() {
  Editor.page.corners = Editor.corners.map((p) => [...p]);
  Editor.dirty = false;
  await Editor.save();
}
$('#cropApply').addEventListener('click', async () => { await applyCrop(); Editor.tab = 'enhance'; Editor.showTab(); });
$('#cropFull').addEventListener('click', () => { Editor.corners = FULL.map((p) => [...p]); Editor.dirty = true; Editor.drawCrop(); });
$('#cropAuto').addEventListener('click', async () => {
  const img = await loadImage(Editor.page.original);
  const c = drawScaled(img, img.naturalWidth, img.naturalHeight, 900);
  const r = detectOn(c);
  if (!r) { toast('枠を見つけられませんでした', true); return; }
  Editor.corners = r; Editor.dirty = true; Editor.drawCrop();
});
window.addEventListener('resize', () => { if (state.screen === 'edit') { Editor.fit(); if (Editor.tab === 'crop') Editor.drawCrop(); } });

// ---------------- 書き出し ----------------
const Export = {
  fmt: S.exportFormat, files: null,
  async open() {
    const doc = await DB.get('docs', state.docId);
    this.files = null;
    $('#exportSub').textContent = `${doc.title} · ${doc.pageIds.length}ページ`;
    $$('#formats .fmt').forEach((b) => b.classList.toggle('on', b.dataset.fmt === this.fmt));
    $('#exportStep1').hidden = false; $('#exportStep2').hidden = true;
    $('#exportMake').disabled = false; $('#exportMake').textContent = 'ファイルを作成';
    $('#exportNote').innerHTML = S.driveClientId ? `保存先: Google Drive「${esc(S.driveFolder || 'ClearScan')}」フォルダ` : 'Drive に直接保存するには <a href="#" id="toDriveSettings">設定で連携</a> してください。共有メニューからDriveアプリにも保存できます。';
    $('#exportDrive').hidden = !S.driveClientId;
    $('#exportScrim').classList.add('show');
    if (S.driveClientId) Drive.loadGIS().catch(() => {});
  },
  close() { $('#exportScrim').classList.remove('show'); },
  async make() {
    const btn = $('#exportMake');
    btn.disabled = true;
    try {
      btn.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>画像を仕上げ中…';
      await Proc.idle();
      const doc = await DB.get('docs', state.docId);
      const pages = [];
      for (const id of doc.pageIds) { const p = await DB.get('pages', id); if (p && p.processed) pages.push(p); }
      if (!pages.length) throw new Error('ページがありません');
      const base = (doc.title || 'scan').replace(/[\\/:*?"<>|]+/g, '_');
      if (this.fmt !== 'jpg' && pages.some((p) => !p.ocr)) {
        btn.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>文字を認識中…';
        pages.filter((p) => !p.ocr).forEach((p) => OCR.enqueue(p.id));
        while (pages.some((p) => OCR.pending(p.id))) await sleep(300);
        for (let i = 0; i < pages.length; i++) pages[i] = await DB.get('pages', pages[i].id);
      }
      if (this.fmt === 'pdf') {
        const list = [];
        for (const p of pages) list.push({ jpeg: new Uint8Array(await p.processed.arrayBuffer()), width: p.pw, height: p.ph, lines: p.ocr && !p.ocr.edited ? p.ocr.lines : textAsLines(p) });
        this.files = [new File([PDF.build(list, doc.title)], `${base}.pdf`, { type: 'application/pdf' })];
      } else if (this.fmt === 'jpg') {
        this.files = pages.map((p, i) => new File([p.processed], pages.length > 1 ? `${base}_${String(i + 1).padStart(2, '0')}.jpg` : `${base}.jpg`, { type: 'image/jpeg' }));
      } else {
        const txt = pages.map((p, i) => (pages.length > 1 ? `--- ${i + 1} ---\n` : '') + ((p.ocr && p.ocr.text) || '')).join('\n\n');
        this.files = [new File([txt], `${base}.txt`, { type: 'text/plain;charset=utf-8' })];
      }
      const size = this.files.reduce((a, f) => a + f.size, 0);
      $('#readyName').textContent = this.files.length > 1 ? `${this.files[0].name} ほか${this.files.length - 1}件` : this.files[0].name;
      $('#readySize').textContent = size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
      $('#exportStep1').hidden = true; $('#exportStep2').hidden = false;
    } catch (err) {
      toast(err.message || '作成に失敗しました', true);
      btn.disabled = false; btn.textContent = 'ファイルを作成';
    }
  },
  async share() {
    const files = this.files; if (!files) return;
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: files[0].name }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f); a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    toast('ダウンロードしました');
  },
  async drive() {
    const files = this.files; if (!files) return;
    const btn = $('#exportDrive');
    try {
      await Drive.authorize(S.driveClientId); // タップ直後に呼ぶ(ポップアップ)
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Drive に保存中…';
      const folder = S.driveFolder || 'ClearScan';
      const id = await Drive.ensureFolder(folder, S.driveFolderId);
      if (id !== S.driveFolderId) { S.driveFolderId = id; saveSettings(); }
      for (const f of files) await Drive.upload(f, f.name, id);
      toast(`Google Drive「${folder}」に保存しました`);
      this.close();
    } catch (err) {
      toast(err.message || 'Drive に保存できませんでした', true);
    }
    btn.disabled = false; btn.innerHTML = `${icon('cloud')}Google Drive に保存`;
  },
};
// 手で直したテキストは位置が分からないので、ページ上部に行ごとに置いて検索だけできるようにする
function textAsLines(p) {
  const t = (p.ocr && p.ocr.text) || '';
  const ls = t.split('\n').filter((s) => s.trim());
  const n = Math.max(ls.length, 1), h = Math.min(0.03, 0.9 / n);
  return ls.map((s, i) => ({ t: s, b: [0.05, 0.05 + i * h, 0.95, 0.05 + (i + 1) * h] }));
}
$('#exportBtn').addEventListener('click', () => Export.open());
$('#exportScrim').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) Export.close();
  if (e.target.id === 'toDriveSettings') { e.preventDefault(); Export.close(); go('settings'); }
});
$('#formats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fmt]'); if (!b) return;
  Export.fmt = b.dataset.fmt; S.exportFormat = Export.fmt; saveSettings();
  Export.files = null;
  $$('#formats .fmt').forEach((x) => x.classList.toggle('on', x === b));
  $('#exportStep1').hidden = false; $('#exportStep2').hidden = true;
  $('#exportMake').disabled = false; $('#exportMake').textContent = 'ファイルを作成';
});
$('#exportMake').addEventListener('click', () => Export.make());
$('#exportShare').addEventListener('click', () => Export.share());
$('#exportDrive').addEventListener('click', () => Export.drive());

// ---------------- 設定 ----------------
async function renderSettings() {
  $$('[data-set]').forEach((el) => {
    const k = el.dataset.set;
    if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k];
  });
  $('#originHint').textContent = location.origin;
  $('#driveState').innerHTML = S.driveClientId ? (Drive.hasToken() ? '<b style="color:var(--green)">接続済み</b>' : 'クライアントID 設定済み') : '<span class="caption">未設定</span>';
  try {
    const est = await navigator.storage.estimate();
    $('#storageInfo').textContent = `${(est.usage / 1048576).toFixed(1)} MB 使用中`;
  } catch (_) { $('#storageInfo').textContent = '不明'; }
}
$('#settings').addEventListener('change', (e) => {
  const el = e.target.closest('[data-set]'); if (!el) return;
  const k = el.dataset.set;
  S[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
  if (k === 'driveFolder') S.driveFolderId = '';
  saveSettings();
  if (k === 'theme') applyTheme();
  if (k === 'driveClientId' && S.driveClientId) Drive.loadGIS().catch(() => {});
  renderSettings();
});
$('#driveTest').addEventListener('click', async () => {
  if (!S.driveClientId) { toast('先にクライアント ID を入力してください', true); return; }
  try {
    await Drive.loadGIS();
    await Drive.authorize(S.driveClientId);
    const id = await Drive.ensureFolder(S.driveFolder || 'ClearScan', S.driveFolderId);
    S.driveFolderId = id; saveSettings();
    toast(`接続できました(フォルダ「${S.driveFolder || 'ClearScan'}」)`);
  } catch (err) { toast(err.message, true); }
  renderSettings();
});

// ---------------- 起動 ----------------
(async function boot() {
  Proc.init();
  // 前回の処理が途中だったページを再開
  const pages = await DB.all('pages');
  pages.filter((p) => p.status !== 'done').forEach((p) => Proc.enqueue(p.id));
  history.replaceState({ screen: 'library' }, '');
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
