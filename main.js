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

// --- OpenRadar (radar engine) managed as a child process ---
// En desarrollo usa la copia local; empaquetado usa la incluida en resources/openradar.
const OPENRADAR_CWD = app.isPackaged
  ? path.join(process.resourcesPath, 'openradar')
  : 'D:\\OpenRadar';
const OPENRADAR_EXE = path.join(OPENRADAR_CWD, 'OpenRadar-windows-amd64.exe');

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
      autoUpdater.on('update-downloaded', () => {
        if (win) win.webContents.send('update-ready');
      });
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      // Re-chequea cada 6 h por si la sesión queda abierta mucho tiempo.
      setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
    } catch (e) { console.error('[overlay] autoUpdater:', e.message); }
  }
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
ipcMain.handle('market-prices', (_e, itemId) => fetchPrices(encodeURIComponent(itemId), CITIES.join(',')));

ipcMain.handle('recipes-index', () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'items-recipes.json'), 'utf8')); }
  catch (_) { return {}; }
});
ipcMain.handle('craft-prices', (_e, ids, locations) => {
  const idStr = (ids || []).slice(0, 120).map(encodeURIComponent).join(',');
  if (!idStr) return [];
  const loc = Array.isArray(locations) ? locations.map(encodeURIComponent).join(',') : encodeURIComponent(locations || 'Caerleon');
  return fetchPrices(idStr, loc);
});

// Escáner: consulta MUCHOS ids paginando de 100 en 100 (secuencial, evita rate-limit)
ipcMain.handle('scan-prices', async (_e, ids, locations) => {
  const loc = (Array.isArray(locations) ? locations : [locations]).map(encodeURIComponent).join(',');
  const out = [];
  const list = ids || [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100).map(encodeURIComponent).join(',');
    const rows = await fetchPrices(chunk, loc);
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
});
