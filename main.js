// Albion Overlay — Electron main process.
// Creates a transparent, frameless, always-on-top window that covers the chosen
// monitor. Clicks pass through to the game except over UI panels (the renderer
// toggles click-through on hover via IPC). No injection into the game process.

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execFile } = require('child_process');

let win = null;
let radarProc = null;

// --- Radar engine (vendored, neutral-branded) managed as a child process ---
// Dev usa vendor/radar; empaquetado usa resources/radar. Mismo binario en ambos.
const OPENRADAR_CWD = app.isPackaged
  ? path.join(process.resourcesPath, 'radar')
  : path.join(__dirname, 'vendor', 'radar');
const OPENRADAR_EXE = path.join(OPENRADAR_CWD, 'candelaa-radar.exe');

function localIPv4() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name]) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

function radarUp(cb) {
  const req = http.get('http://localhost:5001', { timeout: 1500 }, (res) => { res.destroy(); cb(true); });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

function ensureRadar() {
  radarUp((up) => {
    if (up) return; // ya hay un OpenRadar corriendo: no duplicar
    const ip = localIPv4();
    const args = ip ? ['-ip', ip] : [];
    try {
      radarProc = spawn(OPENRADAR_EXE, args, { cwd: OPENRADAR_CWD, windowsHide: true, stdio: 'ignore' });
      radarProc.on('error', (e) => console.error('[overlay] OpenRadar no pudo arrancar:', e.message));
    } catch (e) { console.error('[overlay] spawn OpenRadar:', e.message); }
  });
}

function stopRadar() {
  if (radarProc && radarProc.pid) {
    try { execFile('taskkill', ['/pid', String(radarProc.pid), '/t', '/f']); } catch (_) {}
    radarProc = null;
  }
}

function targetDisplay(displayId) {
  const displays = screen.getAllDisplays();
  if (displayId != null) {
    const d = displays.find((d) => d.id === displayId);
    if (d) return d;
  }
  return screen.getPrimaryDisplay();
}

function createWindow() {
  const d = screen.getPrimaryDisplay();
  const { x, y, width, height } = d.bounds;

  win = new BrowserWindow({
    x, y, width, height,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Sit above normal windows (works over borderless-windowed games, not exclusive fullscreen).
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  // Default: let clicks fall through to the game; renderer re-enables over panels.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  ensureRadar();   // levanta OpenRadar por debajo si no está corriendo
  createWindow();
  // Atajo global para alternar el modo "pasar clics al juego" (funciona aunque
  // el overlay esté ignorando el ratón).
  globalShortcut.register('CommandOrControl+Alt+O', () => {
    if (win) win.webContents.send('toggle-passthrough');
  });
  // Auto-update desde GitHub Releases (solo en la app empaquetada).
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      const send = (s) => { if (win && !win.isDestroyed()) win.webContents.send('update-status', s); };
      autoUpdater.on('update-available', (info) => send({ state: 'downloading', percent: 0, version: info && info.version }));
      autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
      autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info && info.version }));
      autoUpdater.on('error', (err) => send({ state: 'error', message: String((err && err.message) || err) }));
      autoUpdater.checkForUpdates().catch(() => {});
      // Re-chequea cada 6 h por si la sesión queda abierta mucho tiempo.
      setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
    } catch (e) { console.error('[overlay] autoUpdater:', e.message); }
  }
});

// Instalación explícita del update descargado (botón "Reiniciar para actualizar").
ipcMain.on('install-update', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall(); } catch (e) { console.error('[overlay] quitAndInstall:', e.message); }
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopRadar(); });

app.on('window-all-closed', () => app.quit());

// --- IPC bridge ---
ipcMain.on('set-ignore', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.handle('get-displays', () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `Monitor ${i + 1}${d.id === primaryId ? ' (principal)' : ''}  ·  ${d.size.width}×${d.size.height}`,
  }));
});

ipcMain.on('set-display', (_e, displayId) => {
  if (!win) return;
  const d = targetDisplay(displayId);
  win.setBounds(d.bounds);
});

ipcMain.on('quit', () => app.quit());

ipcMain.handle('get-version', () => app.getVersion());

// --- Mercado (Albion Online Data Project, Europa) ---
const fs = require('fs');
const https = require('https');

ipcMain.handle('items-index', () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'items-es.json'), 'utf8')); }
  catch (_) { return []; }
});

const CITIES = ['Caerleon', 'Bridgewatch', 'Lymhurst', 'Martlock', 'Thetford', 'FortSterling', 'Brecilien', 'Black Market'];
function fetchPrices(idStr, locations) {
  return new Promise((resolve) => {
    const url = `https://europe.albion-online-data.com/api/v2/stats/prices/${idStr}.json?locations=${locations}&qualities=1`;
    https.get(url, { timeout: 15000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve([]); } });
    }).on('error', () => resolve([])).on('timeout', function () { this.destroy(); resolve([]); });
  });
}
// Mercado: ahora va por el backend (gateado por token), no directo a la API pública.
ipcMain.handle('market-prices', async (_e, itemId) => {
  const r = await apiCall('/api/market', { method: 'POST', token: readStoredToken(), body: { itemId } });
  return (r.data && r.data.rows) || [];
});

ipcMain.handle('recipes-index', () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'items-recipes.json'), 'utf8')); }
  catch (_) { return {}; }
});
// Crafteo: precios por el backend (gateado por token).
ipcMain.handle('craft-prices', async (_e, ids, locations) => {
  const r = await apiCall('/api/craft-prices', { method: 'POST', token: readStoredToken(), body: { ids: ids || [], locations } });
  return (r.data && r.data.rows) || [];
});

// Escáner: precios por el backend (paginado en servidor, gateado por token).
ipcMain.handle('scan-prices', async (_e, ids, locations) => {
  const r = await apiCall('/api/scan-prices', { method: 'POST', token: readStoredToken(), body: { ids: ids || [], locations } });
  return (r.data && r.data.rows) || [];
});

// --- Candelaa backend: token auth + admin -------------------------------
const API_BASE = process.env.CANDELAA_API || 'https://api.candelaa.dently.es';
const tokenFile = () => path.join(app.getPath('userData'), 'token.json');
function readStoredToken() { try { return JSON.parse(fs.readFileSync(tokenFile(), 'utf8')).token || null; } catch (_) { return null; } }
function writeStoredToken(t) { try { fs.writeFileSync(tokenFile(), JSON.stringify({ token: t })); } catch (_) {} }
function clearStoredToken() { try { fs.unlinkSync(tokenFile()); } catch (_) {} }

async function apiCall(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers['x-candelaa-token'] = token;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API_BASE + pathname, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, ok: res.ok, data };
}

ipcMain.handle('get-token', () => readStoredToken());
ipcMain.handle('clear-token', () => { clearStoredToken(); return true; });

// Verifica el token (el dado o el guardado). Si vale, lo persiste.
ipcMain.handle('auth-verify', async (_e, token) => {
  const t = (token || readStoredToken() || '').trim();
  if (!t) return { valid: false, reason: 'no_token' };
  try {
    const r = await apiCall('/auth/verify', { method: 'POST', token: t });
    if (r.ok && r.data && r.data.valid) { writeStoredToken(t); return { valid: true, name: r.data.name, is_admin: !!r.data.is_admin }; }
    return { valid: false, reason: (r.data && r.data.error) || ('http_' + r.status) };
  } catch (e) { return { valid: false, reason: 'network', message: e.message }; }
});

// admin (usa el token guardado, el backend exige is_admin)
ipcMain.handle('admin-list', async () => (await apiCall('/admin/tokens', { token: readStoredToken() })).data);
ipcMain.handle('admin-issue', async (_e, name, note) => (await apiCall('/admin/tokens', { method: 'POST', token: readStoredToken(), body: { name, note } })).data);
ipcMain.handle('admin-action', async (_e, target, action) => {
  const token = readStoredToken();
  if (action === 'delete') return (await apiCall('/admin/tokens/' + encodeURIComponent(target), { method: 'DELETE', token })).data;
  return (await apiCall('/admin/tokens/' + encodeURIComponent(target) + '/' + action, { method: 'POST', token })).data;
});

// --- Npcap: detectar y (vía gratis) descargar + lanzar instalador oficial ---
ipcMain.handle('npcap-status', () => {
  try { return fs.existsSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'Npcap')); } catch (_) { return false; }
});
ipcMain.handle('npcap-install', async () => {
  const url = 'https://npcap.com/dist/npcap-1.84.exe';
  const tmp = path.join(app.getPath('temp'), 'npcap-installer.exe');
  const download = (u, depth = 0) => new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too_many_redirects'));
    https.get(u, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(download(res.headers.location, depth + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http_' + res.statusCode)); }
      const file = fs.createWriteStream(tmp);
      res.pipe(file); file.on('finish', () => file.close(() => resolve(tmp)));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
  try {
    const exe = await download(url);
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); // su propio UAC
    return { launched: true };
  } catch (e) { return { launched: false, error: e.message, url }; }
});
