// Bridge for the top bar (toolbar.html) only. The Helix page itself uses
// preload.js. Exposes two calls and nothing else: send a button action to the
// main process, drive find-in-page, and receive the page's navigation state.
// offline.html reuses it for its "Try again" button (the 'retry' action).
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set(['back', 'forward', 'reload', 'copy', 'feedback', 'retry']);

contextBridge.exposeInMainWorld('helixBar', {
  send: (action) => {
    if (ACTIONS.has(action)) ipcRenderer.send('toolbar:action', action);
  },
  find: (q) => ipcRenderer.send('toolbar:find', {
    text: String((q && q.text) || ''),
    forward: !(q && q.forward === false),
    findNext: !!(q && q.findNext),
  }),
  findClose: () => ipcRenderer.send('toolbar:find-close'),
  onState: (cb) => {
    ipcRenderer.on('toolbar:state', (_e, state) => cb(state));
    ipcRenderer.send('toolbar:ready');
  },
});
