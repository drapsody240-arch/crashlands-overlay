// CrashLands Overlay (the owner, 2026-10-22): our own overlay for The Isle. A transparent window over the game shows a
// HUD (health, stamina, food, water), a minimap (you and your friends only, never anyone else) and notifications;
// the dashboard key (F8 by default) opens the player website inside it (garage, shop, cases, Battle Pass...).
// Everything talks to players.crashlands.online only. Safe by design:
//  - nothing is injected into the game; it only reads which window is in front and where the game's window is
//  - no keyboard hook: just the one dashboard hotkey, registered with Windows
//  - updates come from our website and are installed only if signed with our own key (update-public-key.pem)
//  - no remote off switch
const { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, screen, shell, safeStorage, Tray, Menu, session, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SITE = 'https://players.crashlands.online';
const PARTITION = 'persist:crashlands';
app.setAppUserModelId('online.crashlands.overlay');
const LINUX = process.platform === 'linux';
// Linux: run as an X11 app (on KDE/Wayland through XWayland), like Proton games, so it can find and sit over the game.
if (LINUX) app.commandLine.appendSwitch('ozone-platform', 'x11');

// ---- settings (the sign-in token is encrypted with Windows' own per-user protection) ----
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { token: null, steam: null, hotkey: 'F8', opacity: 1, hud: true, minimap: true, mapSize: 240, mapZoom: 3, notes: true, hudCorner: 'top-left', mapCorner: 'bottom-right', layout: null, dashSize: 62,
  voice: true, voiceMuted: false, voiceSensitivity: 0.02, voiceVolume: 1, voiceMuteKey: 'F9', micId: '', voiceMode: 'open', voicePttKey: 'Mouse5' };
function readSettings() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')); } catch {}
  const out = { ...DEFAULTS, ...s };
  if (typeof out.token === 'string' && out.token.startsWith('enc:')) { try { out.token = safeStorage.decryptString(Buffer.from(out.token.slice(4), 'base64')); } catch { out.token = null; } }
  return out;
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  const disk = { ...next, token: next.token && safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(next.token).toString('base64')}` : next.token };
  fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true });
  fs.writeFileSync(SETTINGS(), JSON.stringify(disk, null, 2));
  return next;
}
const publicSettings = () => { const s = readSettings(); return { ...s, token: undefined, signedIn: !!s.token }; };

// ---- windows ----
let win = null, dash = null, tray = null, dashOpen = false, gameBounds = null, gameHwnd = null, lastScan = 0;
const send = (ch, data) => { try { if (win && !win.isDestroyed()) win.webContents.send(ch, data); } catch { /* page reloading or closing */ } };
function createWindow() {
  const d = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    ...d, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, fullscreenable: false, focusable: true, show: false, title: 'CrashLands Overlay',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, devTools: !app.isPackaged, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { win.showInactive(); keyboard(dashOpen); });
  win.on('closed', () => { win = null; });
}
// The player website in the dashboard, signed in with the overlay's session (as the site's own cookie).
async function openDash() {
  const s = readSettings();
  if (!s.token) { dashOpen = true; win.setIgnoreMouseEvents(false); win.focus(); keyboard(true); send('dash', { open: true, needSignIn: true }); return; }
  const ses = session.fromPartition(PARTITION);
  await ses.cookies.set({ url: SITE, name: 'isle_sid', value: s.token, secure: true, httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 90 }).catch(() => {});
  if (!dash) {
    dash = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    dash.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    // Only our own site inside the dashboard; anything else opens in the normal browser.
    dash.webContents.on('will-navigate', async (e, url) => {
      // The site's own "Sign in" inside the overlay: the overlay is signed in already, so the dashboard just
      // reloads with its session (instead of going off to Steam).
      if (url.startsWith(`${SITE}/auth/login`)) {
        e.preventDefault();
        const t = readSettings().token;
        if (t) await session.fromPartition(PARTITION).cookies.set({ url: SITE, name: 'isle_sid', value: t, secure: true, httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 90 }).catch(() => {});
        dash.webContents.loadURL(`${SITE}/#/overview`);
        return;
      }
      if (!url.startsWith(SITE)) { e.preventDefault(); shell.openExternal(url); }
    });
    dash.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && (input.key === 'Escape' || input.key === s.hotkey)) { e.preventDefault(); toggleDash(false); } });
    dash.webContents.loadURL(`${SITE}/#/overview`);
    win.contentView.addChildView(dash);
  }
  layoutDash();
  dashOpen = true; siteAllowed = true;
  applyTab();
  track(); // the dashboard gets the whole screen at once
  win.setIgnoreMouseEvents(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.focus();
  keyboard(true);
  send('dash', { open: true });
}
function layoutDash() {
  if (!dash || !win) return;
  // The website panel: dashSize % of the width (and a bit more of the height), centred; the page puts its bar on top.
  const f = Math.max(0.4, Math.min(0.9, (Number(readSettings().dashSize) || 62) / 100));
  const b = win.getContentBounds(), w = Math.round(b.width * f), h = Math.round(b.height * Math.min(0.9, f + 0.12));
  const r = { x: Math.round((b.width - w) / 2), y: Math.round((b.height - h) / 2) + 17, width: w, height: h - 17 };
  dash.setBounds(r);
  if (adminView) adminView.setBounds(r);
  send('dash-rect', r);
}
function toggleDash(open = !dashOpen) {
  if (open) return openDash();
  dashOpen = false;
  if (dash) dash.setVisible(false);
  if (adminView) adminView.setVisible(false);
  if (win) { win.setIgnoreMouseEvents(true, { forward: true }); win.blur(); keyboard(false, true); }
  send('dash', { open: false });
}

// ---- staff (the owner, 2026-10-22): an Admin tab and staff tools, only after the server says this account is staff ----
// The overlay's session is swapped for an admin session by the admin panel itself (it checks staff the same way as a
// Steam sign-in, and on every request after). Quick actions go through the admin panel with that session, so the
// staff member's own permissions apply and everything is logged under their name.
const ADMIN = 'https://admin.crashlands.online', ADMIN_PART = 'persist:crashlands-admin';
let staffInfo = null, adminToken = null, adminView = null, tab = 'site', siteAllowed = true;
async function checkStaff() {
  const { token } = readSettings();
  const was = !!staffInfo;
  staffInfo = null; adminToken = null;
  if (token) {
    try {
      const r = await (await fetch(`${SITE}/api/overlay/staff`, { headers: { Authorization: `Bearer ${token}` } })).json();
      if (r.staff) {
        const b = await (await fetch(`${ADMIN}/auth/overlay-bridge`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json();
        if (b.token) {
          adminToken = b.token; staffInfo = { role: r.role };
          await session.fromPartition(ADMIN_PART).cookies.set({ url: ADMIN, name: b.cookie || 'isle_admin', value: b.token, secure: true, httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + (b.maxAge || 43200) }).catch(() => {});
        }
      }
    } catch { /* offline: tried again later */ }
  }
  if (!staffInfo && (adminView || tab !== 'site')) { if (adminView) { adminView.setVisible(false); win?.contentView.removeChildView(adminView); adminView = null; } tab = 'site'; applyTab(); }
  send('staff', staffInfo ? { staff: true, role: staffInfo.role } : { staff: false });
  if (!was && staffInfo) send('note', { text: `🛡️ Staff tools are on (${staffInfo.role}): Admin and Staff tabs in the dashboard.`, kind: 'staff' });
}
function ensureAdminView() {
  if (adminView || !adminToken || !win) return;
  adminView = new WebContentsView({ webPreferences: { partition: ADMIN_PART, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  adminView.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  adminView.webContents.on('will-navigate', async (e, url) => {
    if (url.startsWith(`${ADMIN}/auth/login`)) { e.preventDefault(); await checkStaff(); if (adminView) adminView.webContents.loadURL(`${ADMIN}/`); return; }
    if (!url.startsWith(ADMIN)) { e.preventDefault(); shell.openExternal(url); }
  });
  adminView.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && (input.key === 'Escape' || input.key === readSettings().hotkey)) { e.preventDefault(); toggleDash(false); } });
  adminView.webContents.loadURL(`${ADMIN}/`);
  win.contentView.addChildView(adminView);
  adminView.setVisible(false);
  layoutDash();
}
// Which view shows in the dashboard: the player website, the admin panel, or neither (the overlay's own staff tools).
function applyTab() {
  if (dash) dash.setVisible(dashOpen && siteAllowed && tab === 'site');
  if (adminView) adminView.setVisible(dashOpen && siteAllowed && tab === 'admin');
  if (dashOpen) (tab === 'admin' ? adminView : dash)?.webContents.focus();
}
async function adminApi(p, body, method = 'POST') {
  if (!adminToken) return { error: 'Staff tools aren\'t available.' };
  const go = () => fetch(`${ADMIN}${p}`, method === 'GET' ? { headers: { Cookie: `isle_admin=${adminToken}` } }
    : { method: 'POST', headers: { Cookie: `isle_admin=${adminToken}`, 'x-panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    let r = await go();
    if (r.status === 401) { await checkStaff(); if (!adminToken) return { error: 'You are no longer staff.' }; r = await go(); }
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.error || `HTTP ${r.status}` };
  } catch (e) { return { error: e.message }; }
}
setInterval(() => { if (readSettings().token) checkStaff(); }, 6 * 3600000); // admin sessions last 12 hours
function registerHotkey() {
  globalShortcut.unregisterAll();
  const s = readSettings(), key = s.hotkey || 'F8';
  try { if (!globalShortcut.register(key, () => toggleDash())) send('note', { text: `The key ${key} is taken by another program: pick another in Settings.`, kind: 'warn' }); } catch { /* bad key name */ }
  // Voice mute: a press toggles it.
  if (s.voiceMuteKey) try { globalShortcut.register(s.voiceMuteKey, () => send('voice-mute', {})); } catch { /* bad key name */ }
  // Push to talk (the owner, 2026-10-22): a global shortcut only sees presses, so the one chosen key's held state is
  // read every 25 ms (native.vkOf/keyDown) and each change is sent to the page.
  pttVk = s.voiceMode === 'ptt' ? (native()?.vkOf(s.voicePttKey) || 0) : 0;
  if (s.voiceMode === 'ptt' && !pttVk) send('note', { text: `"${s.voicePttKey}" isn't a key the overlay knows: try a letter, F1-F24, Mouse4, Mouse5 or CapsLock.`, kind: 'warn' });
}
let pttVk = 0, pttDown = false;
setInterval(() => {
  const down = pttVk ? !!native()?.keyDown(pttVk) : false;
  if (down !== pttDown) { pttDown = down; send('voice-ptt', { down }); }
}, 25);

// Shown only while the game (or the overlay itself) is in front, on the game's screen.
let nat = null;
function native() { if (nat === null) { try { nat = require(LINUX ? './native-linux.cjs' : './native.cjs'); } catch { nat = false; } } return nat || null; }
const bootUntil = Date.now() + 5000;
function track() {
  if (!win || win.isDestroyed()) return;
  const n = native();
  let front = false;
  try {
    if (n) {
      if (gameHwnd && !n.IsWindow(gameHwnd)) gameHwnd = null;
      if (!gameHwnd && Date.now() - lastScan > 3000) { lastScan = Date.now(); gameHwnd = n.findGame(); }
      if (gameHwnd) { const b = n.boundsOf(gameHwnd); if (b && b.width > 0) gameBounds = b; }
      const fg = n.GetForegroundWindow();
      front = !!fg && ((gameHwnd && n.same(fg, gameHwnd)) || n.pidOf(fg) === process.pid);
    } else front = true;
  } catch { front = true; }
  const show = front || dashOpen || Date.now() < bootUntil;
  if (show) {
    // Fitted to the game's drawing area: the whole screen in fullscreen and windowed fullscreen, just inside the
    // game's window in windowed mode (so the HUD sits in the game's corners). Windows gives physical pixels;
    // Electron places windows in scaled units (display scaling 125%, 150%...).
    let area = null;
    try { const c = n && gameHwnd && n.clientBounds(gameHwnd); if (c && c.width > 200 && c.height > 150) area = toDip(c); } catch {}
    const disp = area ? screen.getDisplayMatching(area).bounds : screen.getPrimaryDisplay().bounds;
    // The dashboard always gets the whole screen; the HUD the game's area (or the screen when the game covers it).
    const covers = area && area.width >= disp.width - 2 && area.height >= disp.height - 2;
    const want = dashOpen || !area || covers ? disp : area;
    const cur = win.getBounds();
    if (Math.abs(cur.x - want.x) > 1 || Math.abs(cur.y - want.y) > 1 || Math.abs(cur.width - want.width) > 1 || Math.abs(cur.height - want.height) > 1) { win.setBounds(want); layoutDash(); }
    if (!win.isVisible()) { win.showInactive(); keyboard(dashOpen); }
    // Games push themselves to the front (more so in windowed fullscreen), so "on top" is claimed again every second.
    if (Date.now() - lastTop > 1000) { lastTop = Date.now(); win.setAlwaysOnTop(true, 'screen-saver', 1); win.moveTop(); }
  } else if (win.isVisible()) win.hide();
  // Exclusive fullscreen: nothing can be drawn over it (short of injecting into the game, which we never do).
  // Told once per session, by a Windows notification (it shows when they alt-tab) and on the overlay.
  try {
    const excl = !!(n && front && gameHwnd && n.exclusiveFullscreen());
    if (excl && !warnedFullscreen) {
      warnedFullscreen = true;
      const text = 'The Isle is in exclusive Fullscreen, so the overlay can\'t show over it. In the game: Settings → Video → Window Mode → Windowed Fullscreen. Voice chat still works.';
      send('note', { text, kind: 'warn' });
      if (Notification.isSupported()) new Notification({ title: 'CrashLands Overlay', body: text, silent: true }).show();
    }
    send('state', { game: !!gameHwnd, front, exclusive: excl });
  } catch { send('state', { game: !!gameHwnd, front }); }
}
let lastTop = 0, warnedFullscreen = false;
// Linux: the window manager would give the overlay the keyboard (and list it in alt-tab) like any window, so it's told
// not to: the game keeps the keyboard unless the dashboard is open. Closing the dashboard hands the keyboard back to
// the game. (Windows: the overlay never takes it, nothing to do.)
function keyboard(on, giveBack = false) {
  if (!LINUX || !win || win.isDestroyed()) return;
  const n = native();
  try {
    n?.setPassive(win.getNativeWindowHandle(), !on);
    if (on) n?.activate(win.getNativeWindowHandle());
    else if (giveBack && gameHwnd) n?.activate(gameHwnd);
  } catch { /* not X11 */ }
}
// Screen pixels -> Electron's scaled units. X11 pixels are physical: divided by the display's scaling.
function toDip(r) {
  if (!LINUX) return screen.screenToDipRect(null, r);
  const k = screen.getPrimaryDisplay().scaleFactor || 1;
  return { x: Math.round(r.x / k), y: Math.round(r.y / k), width: Math.round(r.width / k), height: Math.round(r.height / k) };
}

// ---- sign-in (a code bound on the website after Steam sign-in; see panel/overlay.js) ----
let signing = null;
async function signIn() {
  const code = crypto.randomBytes(24).toString('hex');
  signing = code;
  shell.openExternal(`${SITE}/auth/overlay?c=${code}`);
  send('auth', { pending: true });
  for (let i = 0; i < 300 && signing === code; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await (await fetch(`${SITE}/api/overlay/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
      if (r.token) { writeSettings({ token: r.token, steam: r.steam }); signing = null; send('auth', { signedIn: true }); connectLive(); checkStaff(); return; }
      if (r.error) break;
    } catch { /* offline: keep trying */ }
  }
  if (signing === code) { signing = null; send('auth', { signedIn: false, failed: true }); }
}
async function signOut() {
  writeSettings({ token: null, steam: null });
  await session.fromPartition(PARTITION).clearStorageData({ storages: ['cookies'] }).catch(() => {});
  await session.fromPartition(ADMIN_PART).clearStorageData({ storages: ['cookies'] }).catch(() => {});
  stopLive(); toggleDash(false); send('auth', { signedIn: false });
  checkStaff(); // no session now: the Admin and Staff tabs go
}

// ---- live (server-sent events: the HUD, the minimap, notifications) ----
let liveAbort = null, liveWait = 2000;
async function connectLive() {
  stopLive();
  const { token } = readSettings();
  if (!token) return;
  const ctl = new AbortController(); liveAbort = ctl;
  try {
    const res = await fetch(`${SITE}/api/overlay/live`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: ctl.signal });
    if (res.status === 401) { writeSettings({ token: null }); send('auth', { signedIn: false, expired: true }); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    send('live-status', { connected: true }); liveWait = 2000;
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        for (const line of chunk.split('\n')) { if (line.startsWith('event: ')) ev = line.slice(7); else if (line.startsWith('data: ')) data += line.slice(6); }
        if (!data) continue;
        try { const d = JSON.parse(data); if (ev === 'live') send('live', d); else if (ev === 'note') send('note', d); } catch {}
      }
    }
  } catch { /* dropped */ }
  if (liveAbort !== ctl) return; // stopped on purpose
  send('live-status', { connected: false });
  setTimeout(() => { if (liveAbort === ctl) connectLive(); }, liveWait);
  liveWait = Math.min(liveWait * 2, 30000);
}
function stopLive() { if (liveAbort) { const c = liveAbort; liveAbort = null; c.abort(); } }

// ---- updates: from our website, installed only if signed with our key ----
function initUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  const KEY = fs.readFileSync(path.join(__dirname, '..', 'update-public-key.pem'), 'utf8');
  // Linux (AppImage): electron-updater has no signature hook there, so nothing is downloaded: the player is told
  // there's an update and gets it from the website.
  if (LINUX) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', (i) => send('note', { text: `Overlay update ${i.version} is out: download it from the Overlay page on the website.`, kind: 'info' }));
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Instead of a paid Windows signing certificate: our own signature (made on the server with the private key).
  autoUpdater.verifyUpdateCodeSignature = async (_publishers, file) => {
    try {
      const sig = await (await fetch(`${SITE}/overlay/download/${encodeURIComponent(path.basename(file))}.sig`)).text();
      const ok = crypto.verify(null, fs.readFileSync(file), KEY, Buffer.from(sig.trim(), 'base64'));
      return ok ? null : 'The update is not signed by CrashLands.';
    } catch (e) { return `Could not check the update's signature: ${e.message}`; }
  };
  autoUpdater.on('update-downloaded', (i) => send('note', { text: `Overlay update ${i.version} is ready: it installs when you close the overlay.`, kind: 'info' }));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

// ---- the renderer's requests ----
ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = {};
  for (const k of ['hotkey', 'opacity', 'hud', 'minimap', 'mapSize', 'mapZoom', 'notes', 'hudCorner', 'mapCorner', 'layout', 'dashSize', 'voice', 'voiceMuted', 'voiceSensitivity', 'voiceVolume', 'voiceMuteKey', 'micId', 'staffRadar', 'voiceMode', 'voicePttKey']) if (patch && k in patch) allowed[k] = patch[k];
  const s = writeSettings(allowed);
  if ('hotkey' in allowed || 'voiceMuteKey' in allowed || 'voiceMode' in allowed || 'voicePttKey' in allowed) registerHotkey();
  if ('dashSize' in allowed) layoutDash();
  if (win) win.setOpacity(Math.max(0.3, Math.min(1, Number(s.opacity) || 1)));
  return publicSettings();
});
ipcMain.handle('auth:signIn', () => { signIn(); return true; });
ipcMain.handle('auth:signOut', () => signOut());
ipcMain.handle('dash:toggle', (_e, open) => toggleDash(open));
ipcMain.handle('app:quit', () => app.quit());
// A short-lived ticket for the voice server (asked with the overlay's session; the session itself never reaches the page).
ipcMain.handle('voice:ticket', async () => {
  const { token } = readSettings();
  if (!token) return { error: 'Sign in first.' };
  try { const r = await fetch(`${SITE}/api/voice/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }); return await r.json(); } catch (e) { return { error: e.message }; }
});
// The website hidden while the overlay's own Settings are open (it would cover them).
ipcMain.handle('dash:site', (_e, visible) => { siteAllowed = !!visible; applyTab(); });
// Staff: which dashboard tab, the staff info, and quick actions (through the admin panel).
ipcMain.handle('dash:tab', (_e, t) => { if (!['site', 'admin', 'staff'].includes(t) || (t !== 'site' && !staffInfo)) return tab; tab = t; if (t === 'admin') ensureAdminView(); siteAllowed = true; applyTab(); return tab; });
ipcMain.handle('staff:get', () => (staffInfo ? { staff: true, role: staffInfo.role } : { staff: false }));
// Staff tickets: the open tickets with their messages, and reply / claim / close (through the admin panel).
ipcMain.handle('staff:tickets', () => (staffInfo ? adminApi('/api/stafftickets', null, 'GET') : { tickets: [] }));
ipcMain.handle('staff:ticket', (_e, a) => {
  if (!staffInfo || !a || !['reply', 'claim', 'close'].includes(a.act)) return { error: 'Not available.' };
  return adminApi(`/api/stafftickets/${a.act}`, { channelId: String(a.channelId || ''), text: String(a.text || '').slice(0, 1800), reason: String(a.reason || '').slice(0, 300) });
});
ipcMain.handle('staff:action', async (_e, a) => {
  if (!staffInfo || !a || !/^\d{17}$/.test(String(a.steamId || ''))) return { error: 'Not available.' };
  const id = String(a.steamId);
  if (a.action === 'goto') return adminApi('/api/players/goto', { steamId: id });
  if (a.action === 'bring') return adminApi('/api/players/bring', { steamId: id });
  if (a.action === 'heal') return adminApi('/api/players/setstats', { steamId: id, values: { health: 10000000 } });
  if (a.action === 'slay') return adminApi('/api/players/slay', { steamId: id });
  if (a.action === 'message') return adminApi('/api/cmd', { action: 'dm', steamId: id, message: String(a.text || '').slice(0, 200) });
  return { error: 'Unknown action.' };
});
ipcMain.handle('app:version', () => app.getVersion());
let mapCache = null;
ipcMain.handle('map:image', async () => {
  if (mapCache) return mapCache;
  try { const r = await fetch(`${SITE}/map/image`); if (!r.ok) return null; mapCache = `data:image/jpeg;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`; return mapCache; } catch { return null; }
});
ipcMain.on('mouse:ignore', (_e, ignore) => { if (win && !dashOpen) win.setIgnoreMouseEvents(!!ignore, { forward: true }); });

// ---- start ----
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => toggleDash(true));
  app.whenReady().then(() => {
    // The microphone, for proximity voice: only our own overlay page may use it.
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && !!win && wc === win.webContents));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && !!win && wc === win.webContents);
    createWindow();
    // Linux, started with --diag: what the overlay sees every 5 seconds (windows, which is in front, the game), printed
    // and saved to diag.txt in the overlay's settings folder, for helping a player whose game isn't found.
    if (LINUX && process.argv.includes('--diag')) {
      const file = path.join(app.getPath('userData'), 'diag.txt');
      console.log(`CrashLands Overlay diagnostics: also saved to ${file}`);
      setInterval(() => {
        let d; try { d = native()?.diag() || { error: 'native module not loaded' }; } catch (e) { d = { error: e.message }; }
        const line = `${new Date().toISOString()} ${JSON.stringify({ ...d, gameFound: !!gameHwnd, dashOpen })}`;
        console.log(line); try { fs.appendFileSync(file, line + '\n'); } catch { /* read-only */ }
      }, 5000);
    }
    try {
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, LINUX ? 'icon.png' : 'icon.ico')));
      tray.setToolTip('CrashLands Overlay');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open the dashboard', click: () => toggleDash(true) }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]));
      tray.on('double-click', () => toggleDash(true));
    } catch { tray = null; }
    registerHotkey();
    win.setOpacity(Math.max(0.3, Math.min(1, Number(readSettings().opacity) || 1)));
    connectLive();
    checkStaff();
    initUpdates();
    setInterval(track, 700);
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
