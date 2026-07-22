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

const { app, BrowserWindow, shell, Menu, nativeImage, ipcMain } = require('electron');
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
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
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
  ]);
}
