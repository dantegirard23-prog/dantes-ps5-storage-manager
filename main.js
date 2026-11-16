const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');

// Store the local login hash in Electron's per-user application data folder.
process.env.DANTE_STORAGE_USER_DATA = app.getPath('userData');
// Start the local FTP bridge and use its assigned free port.
const server = require(path.join(__dirname, 'server.js'));
let mainWindow;

app.whenReady().then(async () => {
  try {
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const url = 'http://127.0.0.1:' + server.address().port;
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 650,
      autoHideMenuBar: true,
      backgroundColor: '#07110b',
      icon: path.join(__dirname, 'toxic-codes.ico'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    await mainWindow.loadURL(url);
  } catch (error) {
    dialog.showErrorBox('PS5 Storage Manager', error.message);
    app.quit();
  }
});

app.on('before-quit', () => {
  try { server.close(); } catch (_) {}
});
app.on('window-all-closed', () => app.quit());
