// Helix desktop shell.
//
// This is a thin native wrapper around the live Helix web app. It embeds no
// product code and holds no secrets — it just loads https://helix.neonapps.co
// in a native window and layers on the things a browser tab can't do: a Dock /
// taskbar unread badge, real OS notifications, "open external links in the
// system browser", persisted window size, and silent auto-updates of the shell
// itself. Because the window points at the live site, every Helix product
// change ships instantly with zero app update; electron-updater only matters
// when THIS shell changes (Electron version, native behaviour below).

const { app, BrowserWindow, shell, Menu, nativeImage, ipcMain, session, systemPreferences, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// The site the shell wraps. Overridable so `npm run dev` can point at a local
// Next server (HELIX_URL=http://localhost:3000).
const HELIX_URL = process.env.HELIX_URL || 'https://helix.neonapps.co';
const HELIX_HOST = new URL(HELIX_URL).host;

// Where we remember window bounds between launches.
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { width: 1280, height: 860 };
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(win.getBounds()));
  } catch {
    /* best-effort only */
  }
}

let mainWindow = null;

function createWindow() {
  const state = readWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 600,
    backgroundColor: '#0b0b0f',
    title: 'Helix',
    icon: path.join(__dirname, 'assets/icon.png'),
    // Native macOS traffic-light inset so the app doesn't look like a browser.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.loadURL(HELIX_URL);

  // Persist size/position.
  ['resize', 'move', 'close'].forEach((evt) =>
    mainWindow.on(evt, () => saveWindowState(mainWindow))
  );

  // Open target=_blank and any off-Helix navigation in the user's real browser
  // instead of trapping it inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Slack-style unread badge: if the page title carries a "(3) …" count, mirror
  // it onto the Dock / taskbar. Zero web-app changes required — but the web app
  // can also drive it explicitly via window.helix.setBadge() (see preload).
  mainWindow.on('page-title-updated', (_e, title) => {
    const match = /\((\d+)\)/.exec(title || '');
    setBadge(match ? parseInt(match[1], 10) : 0);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function isExternal(url) {
  try {
    return new URL(url).host !== HELIX_HOST;
  } catch {
    return false;
  }
}


// Grant the Helix page the mic (and notifications) so the WebRTC softphone can
// place/answer calls. Electron denies media permission by default for loaded
// content; without this getUserMedia just fails and calls never connect.
//
// This shell ONLY ever loads Helix (off-Helix navigation opens in the system
// browser — see setWindowOpenHandler / will-navigate), so we grant the softphone
// capabilities outright. Both handlers answer SYNCHRONOUSLY: an async request
// handler, or a check handler that denies on an origin mismatch, was letting
// getUserMedia fail even when macOS had already allowed the mic. The macOS TCC
// prompt itself is handled eagerly at startup via askForMediaAccess().
function enableMediaPermissions() {
  const GRANT = new Set(['media', 'microphone', 'audioCapture', 'notifications']);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANT.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => GRANT.has(permission));
}

function setBadge(count) {
  if (process.platform === 'darwin') {
    app.dock.setBadge(count > 0 ? String(count) : '');
  } else if (process.platform === 'win32' && mainWindow) {
    // Windows has no numeric taskbar badge; show a small overlay dot instead.
    if (count > 0) {
      const dot = nativeImage.createFromDataURL(
        'data:image/svg+xml;base64,' +
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#ef4444"/></svg>'
          ).toString('base64')
      );
      mainWindow.setOverlayIcon(dot, `${count} unread`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  }
}
// Let the web app drive the badge explicitly via window.helix.setBadge(n).
ipcMain.on('helix:set-badge', (_e, count) => setBadge(Number(count) || 0));

// ---- Auto-update (shell only) --------------------------------------------
// Checks the public release feed on launch and every 6 hours, downloads in the
// background, and installs on the next quit. Fails silently in dev / unsigned.
function initAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
}

// Manual "Check for Updates…" from the app menu. Unlike the silent background
// check, this gives feedback: up-to-date, downloading, or ready-to-restart.
let updateCheckInProgress = false;
function checkForUpdatesInteractive() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      message: 'Updates are only available in the installed app.',
      detail: `You’re running Helix ${app.getVersion()} in development.`,
    });
    return;
  }
  if (updateCheckInProgress) return;
  updateCheckInProgress = true;

  function cleanup() {
    updateCheckInProgress = false;
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('update-downloaded', onDownloaded);
    autoUpdater.removeListener('error', onError);
  }
  function onAvailable(info) {
    dialog.showMessageBox({
      type: 'info',
      message: 'Downloading update…',
      detail: `Helix ${info && info.version ? info.version : ''} is downloading. You’ll be asked to restart when it’s ready.`,
    });
  }
  function onNotAvailable() {
    cleanup();
    dialog.showMessageBox({
      type: 'info',
      message: 'You’re up to date.',
      detail: `Helix ${app.getVersion()} is the latest version.`,
    });
  }
  function onDownloaded(info) {
    cleanup();
    dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: 'Update ready',
        detail: `Helix ${info && info.version ? info.version : ''} has been downloaded. Restart to install.`,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  }
  function onError(err) {
    cleanup();
    dialog.showMessageBox({
      type: 'error',
      message: 'Update check failed',
      detail: String((err && err.message) || err || 'Unknown error'),
    });
  }

  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', onAvailable);
  autoUpdater.on('update-not-available', onNotAvailable);
  autoUpdater.on('update-downloaded', onDownloaded);
  autoUpdater.on('error', onError);
  autoUpdater.checkForUpdates().catch(onError);
}

// ---- App lifecycle --------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    enableMediaPermissions();
    // macOS: obtain the OS mic grant up front (registers the app under System
    // Settings → Privacy → Microphone). No-op/instant once already granted.
    if (process.platform === 'darwin') {
      systemPreferences.askForMediaAccess('microphone').catch(() => {});
    }
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    initAutoUpdates();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention: stay resident until Cmd+Q.
    if (process.platform !== 'darwin') app.quit();
  });
}

// Minimal native menu: keeps Cmd+C/V/Z, reload, zoom, devtools, quit working.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const checkForUpdatesItem = { label: 'Check for Updates…', click: () => checkForUpdatesInteractive() };
  return Menu.buildFromTemplate([
    // Custom app menu (macOS) so we can add "Check for Updates…" next to About.
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            checkForUpdatesItem,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    // Windows/Linux have no app menu, so surface updates under Help.
    { role: 'help', submenu: [checkForUpdatesItem] },
  ]);
}
