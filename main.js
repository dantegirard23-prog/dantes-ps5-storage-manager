
const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Keep login data in the user's existing application data folder.
process.env.DANTE_STORAGE_USER_DATA = app.getPath('userData');

// Start the local PS5 FTP bridge.
const server = require(path.join(__dirname, 'server.js'));

let mainWindow;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;

// Tell the user when an update is downloaded.
autoUpdater.on('update-downloaded', async (info) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Dante PS5 Storage Manager Update',
    message: 'Version ' + info.version + ' is ready!',
    detail: 'Restart the app to install the update.',
    buttons: ['Restart and Install', 'Later'],
    defaultId: 0,
    cancelId: 1
  });

  if (result.response === 0) {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on('error', (error) => {
  console.error('Update error:', error);
});

app.whenReady().then(async () => {
  try {
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }

    const url = 'http://127.0.0.1:' + server.address().port;

    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 650,
      autoHideMenuBar: true,
      backgroundColor: '#07110b',
      icon: path.join(__dirname, 'toxic-codes.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    await mainWindow.loadURL(url);

    // Only packaged Windows installations check GitHub Releases.
    if (app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(error => {
          console.error('Could not check for updates:', error);
        });
      }, 5000);
    }

  } catch (error) {
    dialog.showErrorBox('PS5 Storage Manager', error.message);
    app.quit();
  }
});

app.on('before-quit', () => {
  try {
    server.close();
  } catch (_) {}
});

app.on('window-all-closed', () => {
  app.quit();
});

