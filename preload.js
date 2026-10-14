const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  onState: cb => ipcRenderer.on('state', (_, s) => cb(s)),
  open: u => ipcRenderer.send('open', u),
  setTf: t => ipcRenderer.send('tf', t),
  backtest: o => ipcRenderer.invoke('backtest', o),
  dbStats: () => ipcRenderer.invoke('dbstats'),
  sync: d => ipcRenderer.invoke('sync', d),
  wf: () => ipcRenderer.invoke('wf'),
  diag: () => ipcRenderer.invoke('diag'),
  scanSync: d => ipcRenderer.invoke('scan-sync', d),
  scan: () => ipcRenderer.invoke('scan'),
  tokRep: () => ipcRenderer.invoke('tokrep'),
  onProg: cb => ipcRenderer.on('prog', (_, p) => cb(p))
});
