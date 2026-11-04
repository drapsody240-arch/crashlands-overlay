// The only things the overlay's page can ask the app for.
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch) => (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };
contextBridge.exposeInMainWorld('overlay', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (p) => ipcRenderer.invoke('settings:set', p),
  signIn: () => ipcRenderer.invoke('auth:signIn'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  toggleDash: (open) => ipcRenderer.invoke('dash:toggle', open),
  showSite: (visible) => ipcRenderer.invoke('dash:site', visible),
  quit: () => ipcRenderer.invoke('app:quit'),
  version: () => ipcRenderer.invoke('app:version'),
  mapImage: () => ipcRenderer.invoke('map:image'),
  voiceTicket: () => ipcRenderer.invoke('voice:ticket'),
  dashTab: (t) => ipcRenderer.invoke('dash:tab', t),
  staffGet: () => ipcRenderer.invoke('staff:get'),
  staffAction: (a) => ipcRenderer.invoke('staff:action', a),
  staffTickets: () => ipcRenderer.invoke('staff:tickets'),
  staffTicket: (a) => ipcRenderer.invoke('staff:ticket', a),
  mouseIgnore: (ignore) => ipcRenderer.send('mouse:ignore', ignore),
  onLive: on('live'), onNote: on('note'), onAuth: on('auth'), onDash: on('dash'), onState: on('state'), onLiveStatus: on('live-status'), onVoiceMute: on('voice-mute'), onVoicePtt: on('voice-ptt'), onDashRect: on('dash-rect'), onStaff: on('staff'),
});
