// Safe bridge between the renderer (UI) and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  setDisplay: (id) => ipcRenderer.send('set-display', id),
  quit: () => ipcRenderer.send('quit'),
  onTogglePassthrough: (cb) => ipcRenderer.on('toggle-passthrough', () => cb()),
  itemsIndex: () => ipcRenderer.invoke('items-index'),
  marketPrices: (itemId) => ipcRenderer.invoke('market-prices', itemId),
  recipesIndex: () => ipcRenderer.invoke('recipes-index'),
  craftPrices: (ids, location) => ipcRenderer.invoke('craft-prices', ids, location),
  scanPrices: (ids, locations) => ipcRenderer.invoke('scan-prices', ids, locations),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  installUpdate: () => ipcRenderer.send('install-update'),
});
