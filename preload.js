// Runs in an isolated world with access to a small, safe bridge only.
// The web app can feature-detect `window.helix` to know it's running inside
// the desktop shell and, optionally, drive the Dock/taskbar badge itself.
// Nothing here exposes Node or the filesystem to page code.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helix', {
  isDesktop: true,
  platform: process.platform,
  // App shell version (e.g. "1.0.4") so the web UI can show it + tell users when
  // to update. Resolved synchronously at load from the main process.
  version: ipcRenderer.sendSync('helix:get-version'),
  setBadge: (count) => ipcRenderer.send('helix:set-badge', count),
  // True from v1.0.5: the shell draws its own top bar with back/forward,
  // refresh, copy link and feedback, so the web app hides its floating
  // options button.
  toolbar: true,
  // Bring the window to the front (v1.0.7+), e.g. when a notification is
  // clicked while Helix is in the background or minimized.
  focus: () => ipcRenderer.send('helix:focus'),
});
