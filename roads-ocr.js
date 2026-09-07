// Lee el nombre del mapa de Caminos bajo el cursor: captura la pantalla alrededor del ratón,
// pasa el recorte por OCR y lo empareja con los 400 nombres de data/roads.json. El destino de
// un portal solo lo pinta el juego en el tooltip (no viaja en ningún paquete), así que esta es
// la única vía para saber a dónde lleva sin cruzarlo.
const { app, screen, desktopCapturer, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

const HOTKEY = 'CommandOrControl+Alt+R';
const CROP_W = 1200, CROP_H = 500, CROP_LEFT = 600, CROP_UP = 120;
const MAX_SCORE = 0.3;

let worker = null;
let workerP = null;
let busy = false;
let roads = null;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
const unpacked = (p) => p.replace(/app\.asar([\/])/, 'app.asar.unpacked$1');
const langDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'ocr') : path.join(__dirname, 'data', 'ocr'));

function loadRoads() {
  if (roads) return roads;
  try {
    const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'roads.json'), 'utf8'));
    roads = Object.keys(db).map((id) => ({ id, name: db[id].n, key: norm(db[id].n) }));
  } catch (_) { roads = []; }
  return roads;
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Los nombres de Caminos son dos palabras con guion (Qiitun-Qiitun). Se prueban los pares
// con guion que el OCR haya leído y, por si se comió el guion, cada par de palabras seguidas.
function bestOf(cands) {
  let best = null;
  for (const c of cands) {
    const k = norm(c);
    if (k.length < 6) continue;
    for (const r of loadRoads()) {
      const score = lev(k, r.key) / Math.max(k.length, r.key.length);
      if (!best || score < best.score || (score === best.score && r.key.length > best.keyLen)) best = { id: r.id, name: r.name, score, raw: c, keyLen: r.key.length };
    }
  }
  return best && best.score <= MAX_SCORE ? { id: best.id, name: best.name, score: best.score, raw: best.raw } : null;
}
function matchRoad(text) {
  const hyphenated = text.match(/[A-Za-z]{3,}(?:\s?[-–—]\s?[A-Za-z0-9]{1,})+/g) || [];
  const withHyphen = bestOf(hyphenated);
  if (withHyphen) return withHyphen;
  const words = text.match(/[A-Za-z0-9]{2,}/g) || [];
  const joined = [];
  for (let i = 0; i + 1 < words.length; i++) {
    joined.push(words[i] + words[i + 1]);
    if (i + 2 < words.length) joined.push(words[i] + words[i + 1] + words[i + 2]);
  }
  return bestOf(joined);
}

function getWorker() {
  if (worker) return Promise.resolve(worker);
  if (!workerP) {
    workerP = (async () => {
      const { createWorker } = require('tesseract.js');
      const workerPath = unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js'));
      const w = await createWorker('eng', 1, { workerPath, langPath: langDir(), gzip: false, cacheMethod: 'none', logger: () => {} });
      await w.setParameters({ thresholding_method: '1' });
      worker = w;
      return w;
    })().catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}

async function captureAroundCursor() {
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const sf = disp.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) },
  });
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  if (!src) throw new Error('no screen source');
  const img = src.thumbnail;
  const sz = img.getSize();
  const cx = Math.round((pt.x - disp.bounds.x) * sf), cy = Math.round((pt.y - disp.bounds.y) * sf);
  const x = Math.min(Math.max(0, cx - CROP_LEFT), sz.width - 1);
  const y = Math.min(Math.max(0, cy - CROP_UP), sz.height - 1);
  return img.crop({ x, y, width: Math.min(CROP_W, sz.width - x), height: Math.min(CROP_H, sz.height - y) }).toPNG();
}

async function readPortalUnderCursor() {
  const [png, w] = await Promise.all([captureAroundCursor(), getWorker()]);
  const { data } = await w.recognize(png);
  const text = (data && data.text) || '';
  return { text, match: matchRoad(text) };
}

function register(send) {
  globalShortcut.register(HOTKEY, async () => {
    if (busy) return;
    busy = true;
    send({ state: 'busy' });
    try {
      const { text, match } = await readPortalUnderCursor();
      if (match) send({ state: 'done', id: match.id, name: match.name, raw: match.raw, score: match.score });
      else send({ state: 'none', text: text.replace(/\s+/g, ' ').trim().slice(0, 120) });
    } catch (e) {
      console.error('[roads-ocr]', e && e.message);
      send({ state: 'error', message: String((e && e.message) || e) });
    } finally { busy = false; }
  });
}

function terminate() {
  const w = worker; worker = null; workerP = null;
  if (w) w.terminate().catch(() => {});
}

module.exports = { register, terminate, matchRoad, HOTKEY };
