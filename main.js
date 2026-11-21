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

const { app, BrowserWindow, WebContentsView, shell, Menu, nativeImage, ipcMain, session, systemPreferences, dialog, clipboard } = require('electron');
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
// The Helix web app. It lives in its own view below the top bar, so the
// window's own webContents only ever shows toolbar.html.
let pageView = null;

// Height of the native top bar (toolbar.html). The macOS traffic lights are
// centred inside it via trafficLightPosition.
const TOOLBAR_HEIGHT = 40;

function createWindow() {
  const state = readWindowState();
  const isMac = process.platform === 'darwin';

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
    // macOS: no title bar; the traffic lights sit inside our own top bar
    // instead of floating over the page.
    titleBarStyle: isMac ? 'hidden' : 'default',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 13 } } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'toolbar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'toolbar.html'), { query: { platform: process.platform } });
  // The window title follows the Helix page, not toolbar.html.
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  pageView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  pageView.setBackgroundColor('#0b0b0f');
  mainWindow.contentView.addChildView(pageView);
  layoutPage();
  mainWindow.on('resize', layoutPage);
  ['enter-full-screen', 'leave-full-screen'].forEach((evt) =>
    mainWindow.on(evt, () => { layoutPage(); pushToolbarState(); })
  );

  const page = pageView.webContents;
  page.loadURL(HELIX_URL);
  page.once('did-finish-load', () => page.focus());

  // Persist size/position.
  ['resize', 'move', 'close'].forEach((evt) =>
    mainWindow.on(evt, () => saveWindowState(mainWindow))
  );

  // Open target=_blank and any off-Helix navigation in the user's real browser
  // instead of trapping it inside the app window.
  page.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  page.on('will-navigate', (event, url) => {
    if (isExternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Slack-style unread badge: if the page title carries a "(3) …" count, mirror
  // it onto the Dock / taskbar. Zero web-app changes required — but the web app
  // can also drive it explicitly via window.helix.setBadge() (see preload).
  page.on('page-title-updated', (_e, title) => {
    const match = /\((\d+)\)/.exec(title || '');
    setBadge(match ? parseInt(match[1], 10) : 0);
    if (mainWindow) mainWindow.setTitle(title || 'Helix');
    pushToolbarState();
  });

  // Keep the top bar's back/forward/loading state in step with the page.
  ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading'].forEach((evt) =>
    page.on(evt, () => pushToolbarState())
  );
  page.on('did-finish-load', () => syncToolbarBackground());
  page.on('did-navigate-in-page', () => syncToolbarBackground());

  // Mouse back/forward buttons (Windows/Linux) and three-finger swipes (macOS).
  mainWindow.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') runAction('back');
    if (cmd === 'browser-forward') runAction('forward');
  });
  mainWindow.on('swipe', (_e, dir) => {
    if (dir === 'left') runAction('back');
    if (dir === 'right') runAction('forward');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    pageView = null;
  });
}

function layoutPage() {
  if (!mainWindow || !pageView) return;
  const [width, height] = mainWindow.getContentSize();
  pageView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}

function navHistory(wc) {
  // navigationHistory is the current API; canGoBack() is the older fallback.
  const h = wc.navigationHistory;
  return {
    canGoBack: h ? h.canGoBack() : wc.canGoBack(),
    canGoForward: h ? h.canGoForward() : wc.canGoForward(),
    goBack: () => (h ? h.goBack() : wc.goBack()),
    goForward: () => (h ? h.goForward() : wc.goForward()),
  };
}

let toolbarBackground = null;

function pushToolbarState(extra) {
  if (!mainWindow || !pageView || mainWindow.isDestroyed()) return;
  const page = pageView.webContents;
  const nav = navHistory(page);
  mainWindow.webContents.send('toolbar:state', {
    canGoBack: nav.canGoBack,
    canGoForward: nav.canGoForward,
    loading: page.isLoading(),
    title: page.getTitle(),
    fullscreen: mainWindow.isFullScreen(),
    background: toolbarBackground,
    ...extra,
  });
}

// Read the page's background colour so the bar matches the active Helix theme.
function syncToolbarBackground() {
  if (!pageView) return;
  pageView.webContents
    .executeJavaScript('getComputedStyle(document.body).backgroundColor', false)
    .then((bg) => {
      if (typeof bg === 'string' && bg) {
        toolbarBackground = bg;
        pushToolbarState();
      }
    })
    .catch(() => {});
}

function runAction(action) {
  if (!pageView) return;
  const page = pageView.webContents;
  const nav = navHistory(page);
  switch (action) {
    case 'back':
      if (nav.canGoBack) nav.goBack();
      break;
    case 'forward':
      if (nav.canGoForward) nav.goForward();
      break;
    case 'reload':
      page.reload();
      break;
    case 'copy':
      clipboard.writeText(page.getURL());
      pushToolbarState({ copied: true });
      break;
    case 'feedback':
      // The web app's feedback panel listens for this event (OPEN_FEEDBACK_EVENT
      // in components/use-desktop-shell.ts).
      page
        .executeJavaScript("window.dispatchEvent(new CustomEvent('helix:open-feedback'))", true)
        .catch(() => {});
      break;
    default:
      return;
  }
  // Hand keyboard focus back to the page after a toolbar click.
  page.focus();
}

ipcMain.on('toolbar:action', (e, action) => {
  if (!mainWindow || e.sender !== mainWindow.webContents) return;
  runAction(action);
});
ipcMain.on('toolbar:ready', (e) => {
  if (!mainWindow || e.sender !== mainWindow.webContents) return;
  pushToolbarState();
});

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

// Synchronous version lookup for the preload bridge (window.helix.version).
ipcMain.on('helix:get-version', (e) => { e.returnValue = app.getVersion(); });

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

function setZoom(delta, reset) {
  if (!pageView) return;
  const page = pageView.webContents;
  page.setZoomLevel(reset ? 0 : page.getZoomLevel() + delta);
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
      // Explicit handlers instead of roles: roles act on the focused
      // webContents, which may be the top bar rather than the Helix page.
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => runAction('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => runAction('forward') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => runAction('reload') },
        { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => pageView && pageView.webContents.reloadIgnoringCache() },
        { label: 'Copy Page Link', accelerator: 'Shift+CmdOrCtrl+L', click: () => runAction('copy') },
        { label: 'Toggle Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => pageView && pageView.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0, true) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => setZoom(0.5) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: () => setZoom(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoom(-0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    // Windows/Linux have no app menu, so surface updates under Help.
    { role: 'help', submenu: [checkForUpdatesItem] },
  ]);
}
