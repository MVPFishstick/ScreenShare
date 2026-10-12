const { contextBridge, ipcRenderer } = require('electron');

function signalConfig() {
  const arg = process.argv.find((a) => a.startsWith('--nebula-signal='));
  if (!arg) return null;
  try {
    const url = new URL(arg.slice('--nebula-signal='.length));
    const secure = url.protocol === 'https:';
    return {
      host: url.hostname,
      port: Number(url.port) || (secure ? 443 : 80),
      path: url.pathname || '/',
      secure,
    };
  } catch (_) {
    return null;
  }
}

contextBridge.exposeInMainWorld('nebula', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id, name, audio) => ipcRenderer.invoke('sources:select', id, name, audio),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  onWindowState: (cb) => ipcRenderer.on('window:state', (_e, state) => cb(state)),
  platform: process.platform,
  signal: signalConfig(),
});
