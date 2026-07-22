// Runs in an isolated world with access to a small, safe bridge only.
// The web app can feature-detect `window.helix` to know it's running inside
// the desktop shell and, optionally, drive the Dock/taskbar badge itself.
// Nothing here exposes Node or the filesystem to page code.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helix', {
  isDesktop: true,
  platform: process.platform,
  setBadge: (count) => ipcRenderer.send('helix:set-badge', count),
});
