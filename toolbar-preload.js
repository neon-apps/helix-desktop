// Bridge for the top bar (toolbar.html) only. The Helix page itself uses
// preload.js. Exposes two calls and nothing else: send a button action to the
// main process, and receive the page's navigation state.
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set(['back', 'forward', 'reload', 'copy', 'feedback']);

contextBridge.exposeInMainWorld('helixBar', {
  send: (action) => {
    if (ACTIONS.has(action)) ipcRenderer.send('toolbar:action', action);
  },
  onState: (cb) => {
    ipcRenderer.on('toolbar:state', (_e, state) => cb(state));
    ipcRenderer.send('toolbar:ready');
  },
});
