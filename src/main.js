const { app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, shell } = require('electron');
const path = require('path');

let mainWindow = null;
// The source the user picked in our custom picker; consumed by the
// display-media handler when the renderer calls getDisplayMedia().
let pendingSelection = null;

// Optional self-hosted PeerJS signaling server, e.g.
//   NEBULA_SIGNAL_URL=https://signal.example.com:443/peerjs
// When unset the free public PeerJS cloud server is used.
const signalArg = process.env.NEBULA_SIGNAL_URL ? [`--nebula-signal=${process.env.NEBULA_SIGNAL_URL}`] : [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0612',
    title: 'Nebula Share',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: signalArg,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', 'normal'));

  // Open external links in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const selection = pendingSelection;
    pendingSelection = null;
    if (!selection) {
      callback(null);
      return;
    }
    const streams = { video: { id: selection.sourceId, name: selection.name } };
    // Loopback (system audio) capture is supported on Windows only.
    if (selection.audio && process.platform === 'win32') streams.audio = 'loopback';
    callback(streams);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => s.name && !(s.id.startsWith('window:') && s.name === 'Nebula Share'))
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('sources:select', (_e, sourceId, name, audio) => {
  pendingSelection = { sourceId: String(sourceId), name: String(name || ''), audio: !!audio };
  return true;
});

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});

ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());
