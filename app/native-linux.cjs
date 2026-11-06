// The Linux side of native.cjs (same functions), for The Isle under Proton on an X11 or KDE/XWayland desktop, through
// koffi and libX11: read-only window information (which window is in front, where the game's window is). Nothing is
// injected into the game. The one key read is the player's own push-to-talk key, if they pick push to talk.
// Windows are X11 ids (numbers). The overlay runs as an X11 app (main.cjs forces it), like Proton games do.
'use strict';
const fs = require('fs');
const koffi = require('koffi');

const x11 = koffi.load('libX11.so.6');
const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
const XInternAtom = x11.func('unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)');
const XDefaultRootWindow = x11.func('unsigned long XDefaultRootWindow(void *dpy)');
const XGetWindowProperty = x11.func('int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, ' +
  '_Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)');
const XFree = x11.func('int XFree(void *data)');
const XGetGeometry = x11.func('int XGetGeometry(void *dpy, unsigned long d, _Out_ unsigned long *root, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *w, _Out_ unsigned int *h, ' +
  '_Out_ unsigned int *border, _Out_ unsigned int *depth)');
const XTranslateCoordinates = x11.func('int XTranslateCoordinates(void *dpy, unsigned long src, unsigned long dst, int x, int y, _Out_ int *dx, _Out_ int *dy, _Out_ unsigned long *child)');
const XQueryKeymap = x11.func('int XQueryKeymap(void *dpy, _Out_ uint8_t *keys)');
const XStringToKeysym = x11.func('unsigned long XStringToKeysym(const char *name)');
const XKeysymToKeycode = x11.func('uint8_t XKeysymToKeycode(void *dpy, unsigned long keysym)');
const XQueryPointer = x11.func('int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rx, _Out_ int *ry, ' +
  '_Out_ int *wx, _Out_ int *wy, _Out_ unsigned int *mask)');
// Xlib's default error handler ends the program, and a window can close between two calls: errors are ignored instead.
const ErrorHandler = koffi.proto('int XErrorHandler(void *dpy, void *event)');
const XSetErrorHandler = x11.func('void *XSetErrorHandler(XErrorHandler *handler)');
XSetErrorHandler(koffi.register(() => 0, koffi.pointer(ErrorHandler)));

const dpy = XOpenDisplay(null);
if (!dpy) throw new Error('no X display');
const root = XDefaultRootWindow(dpy);
const atoms = {};
const atom = (name) => atoms[name] || (atoms[name] = XInternAtom(dpy, name, 0));

// One window property as raw values: format 32 gives C longs, format 8 a string.
function prop(w, name) {
  const type = [0], format = [0], n = [0], after = [0], data = [null];
  if (XGetWindowProperty(dpy, w, atom(name), 0, 4096, 0, 0 /* AnyPropertyType */, type, format, n, after, data) !== 0 || !data[0]) return null;
  try {
    if (!n[0]) return null;
    if (format[0] === 32) return koffi.decode(data[0], koffi.array('unsigned long', n[0]));
    if (format[0] === 8) return Buffer.from(koffi.decode(data[0], koffi.array('uint8_t', n[0]))).toString('latin1');
    return null;
  } finally { XFree(data[0]); }
}
const clientList = () => Array.from(prop(root, '_NET_CLIENT_LIST') || []);

function GetForegroundWindow() { const a = prop(root, '_NET_ACTIVE_WINDOW'); return a && a[0] ? a[0] : null; }
const IsWindow = (w) => !!w && clientList().includes(w);
function pidOf(w) { const p = w && prop(w, '_NET_WM_PID'); return p ? p[0] : 0; }
// The window's position on screen (X11 pixels) and size. Under Proton the game's window has no frame of its own.
function boundsOf(w) {
  const r = [0], x = [0], y = [0], ww = [0], hh = [0], b = [0], d = [0], ax = [0], ay = [0], c = [0];
  if (!w || !XGetGeometry(dpy, w, r, x, y, ww, hh, b, d) || !XTranslateCoordinates(dpy, w, root, 0, 0, ax, ay, c)) return null;
  return { x: ax[0], y: ay[0], width: ww[0], height: hh[0] };
}
const clientBounds = boundsOf;
const exclusiveFullscreen = () => false; // no such mode under Proton: the game is an ordinary window
// The Isle's game window, by any of: its class (Proton names it steam_app_<app id>, The Isle is 376210; plain Wine
// uses the program's name), its title, or the program (TheIsleClient-Win64-Shipping.exe or similar under Wine; the
// pid can be from inside Steam's container, so this one may not work).
const titleOf = (w) => prop(w, '_NET_WM_NAME') || prop(w, 'WM_NAME') || '';
function cmdOf(pid) { try { return pid ? fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0/g, ' ').trim() : ''; } catch { return ''; } }
function isGame(w) {
  const pid = pidOf(w);
  if (pid === process.pid) return false; // our own windows
  const cls = prop(w, 'WM_CLASS') || '';
  if (/steam_app_376210\b/i.test(cls) || (/theisle/i.test(cls) && !/server/i.test(cls))) return true;
  if (/^\s*the ?isle\b/i.test(titleOf(w)) && !/crashlands/i.test(titleOf(w))) return true;
  const cmd = cmdOf(pid);
  return /theisle[^/\\ ]*\.exe/i.test(cmd) && !/server/i.test(cmd);
}
function findGame() { for (const w of clientList()) if (isGame(w)) return w; return null; }
const same = (a, b) => !!a && !!b && a === b;
// What the overlay sees (for the --diag option): every window's class, title and program, and which one is in front.
function diag() {
  return { front: GetForegroundWindow(), game: findGame(), windows: clientList().map((w) => ({ id: w, class: (prop(w, 'WM_CLASS') || '').replace(/\0/g, ' ').trim(),
    title: titleOf(w).slice(0, 80), pid: pidOf(w), cmd: cmdOf(pidOf(w)).slice(0, 160) })) };
}

// Our own overlay window: by default it never takes the keyboard (the game keeps it) and stays out of alt-tab and the
// taskbar; while the dashboard is open it takes the keyboard. Through the window's input hint (ICCCM) and _NET_WM_STATE.
const XWMHints = koffi.struct('XWMHints', { flags: 'long', input: 'int', initial_state: 'int', icon_pixmap: 'unsigned long', icon_window: 'unsigned long',
  icon_x: 'int', icon_y: 'int', icon_mask: 'unsigned long', window_group: 'unsigned long' });
const XGetWMHints = x11.func('XWMHints *XGetWMHints(void *dpy, unsigned long w)');
const XSetWMHints = x11.func('int XSetWMHints(void *dpy, unsigned long w, XWMHints *hints)');
const XSendEvent = x11.func('int XSendEvent(void *dpy, unsigned long w, int propagate, long mask, void *event)');
const XFlush = x11.func('int XFlush(void *dpy)');
const xidOf = (buf) => (buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0));
// A message to the window manager about window w (XClientMessageEvent, format 32, inside a 192-byte XEvent).
function wmMessage(w, type, data) {
  const ev = Buffer.alloc(192);
  ev.writeInt32LE(33, 0); ev.writeInt32LE(1, 16); ev.writeBigUInt64LE(BigInt(w), 32); ev.writeBigUInt64LE(BigInt(atom(type)), 40); ev.writeInt32LE(32, 48);
  data.forEach((v, i) => ev.writeBigInt64LE(BigInt(v), 56 + i * 8));
  XSendEvent(dpy, root, 0, (1 << 19) | (1 << 20) /* SubstructureNotify | SubstructureRedirect */, ev);
}
function setPassive(handle, passive) {
  const w = xidOf(handle);
  const p = XGetWMHints(dpy, w), h = p ? koffi.decode(p, XWMHints) : { flags: 0, input: 1, initial_state: 1, icon_pixmap: 0, icon_window: 0, icon_x: 0, icon_y: 0, icon_mask: 0, window_group: 0 };
  if (p) XFree(p);
  XSetWMHints(dpy, w, { ...h, flags: Number(h.flags) | 1 /* InputHint */, input: passive ? 0 : 1 });
  // 1 = add: out of the taskbar, the pager and KDE's alt-tab switcher (source 1 = an application).
  wmMessage(w, '_NET_WM_STATE', [1, atom('_NET_WM_STATE_SKIP_TASKBAR'), atom('_NET_WM_STATE_SKIP_PAGER'), 1, 0]);
  wmMessage(w, '_NET_WM_STATE', [1, atom('_KDE_NET_WM_STATE_SKIP_SWITCHER'), 0, 1, 0]);
  XFlush(dpy);
}
// Bring a window to the front with the keyboard (source 2 = a pager, which window managers always allow).
function activate(w) { if (!w) return; wmMessage(typeof w === 'number' ? w : xidOf(w), '_NET_ACTIVE_WINDOW', [2, 0, 0, 0, 0]); XFlush(dpy); }

// Push to talk: is this one key (or mouse button) held right now? Keys by X keysym name; mouse buttons as 1000 + the
// X button number (middle 2, side buttons 8 and 9).
const NAMED = { space: 'space', tab: 'Tab', capslock: 'Caps_Lock', shift: 'Shift_L', ctrl: 'Control_L', control: 'Control_L', alt: 'Alt_L',
  lshift: 'Shift_L', rshift: 'Shift_R', lctrl: 'Control_L', rctrl: 'Control_R', lalt: 'Alt_L', ralt: 'Alt_R', '`': 'grave', backquote: 'grave',
  enter: 'Return', insert: 'Insert', delete: 'Delete', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' };
const MOUSE = { mousemiddle: 2, middlemouse: 2, mouse4: 8, mouse5: 9 };
function vkOf(name) {
  const k = String(name || '').trim().toLowerCase().replace(/\s+/g, '');
  if (MOUSE[k]) return 1000 + MOUSE[k];
  let sym = NAMED[k] || (/^[a-z0-9]$/.test(k) ? k : null);
  let m = k.match(/^f(\d{1,2})$/); if (m && +m[1] >= 1 && +m[1] <= 24) sym = `F${+m[1]}`;
  m = k.match(/^num(?:pad)?(\d)$/); if (m) sym = `KP_${m[1]}`;
  if (!sym) return 0;
  const code = (s) => { const ks = XStringToKeysym(s); return ks ? XKeysymToKeycode(dpy, ks) || 0 : 0; };
  return code(sym) || (F_ALT[sym] ? code(F_ALT[sym]) : 0);
}
// Most Linux keyboard layouts give the keys F13-F23 these names instead.
const F_ALT = { F13: 'XF86Tools', F14: 'XF86Launch5', F15: 'XF86Launch6', F16: 'XF86Launch7', F17: 'XF86Launch8', F18: 'XF86Launch9',
  F20: 'XF86AudioMicMute', F21: 'XF86TouchpadToggle', F22: 'XF86TouchpadOn', F23: 'XF86TouchpadOff' };
// Side mouse buttons aren't in the core pointer state: XInput 2 has them (if libXi is there).
let xi = null;
function xiButtons() {
  if (xi === null) {
    try {
      const lib = koffi.load('libXi.so.6');
      const ButtonState = koffi.struct('XIButtonState', { mask_len: 'int', mask: 'uint8_t *' });
      const ModState = koffi.struct('XIModifierState', { base: 'int', latched: 'int', locked: 'int', effective: 'int' });
      const XIQueryVersion = lib.func('int XIQueryVersion(void *dpy, _Inout_ int *major, _Inout_ int *minor)');
      const q = lib.func('int XIQueryPointer(void *dpy, int dev, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ double *rx, _Out_ double *ry, ' +
        '_Out_ double *wx, _Out_ double *wy, _Out_ XIButtonState *buttons, _Out_ XIModifierState *mods, _Out_ XIModifierState *group)');
      xi = XIQueryVersion(dpy, [2], [0]) === 0 ? { q, ButtonState } : false;
    } catch { xi = false; }
  }
  if (!xi) return null;
  const b = {}, o = [0], d = [0];
  if (!xi.q(dpy, 2 /* the core pointer */, root, o, o, d, d, d, d, b, {}, {})) return null;
  try { return b.mask_len > 0 ? Buffer.from(koffi.decode(b.mask, koffi.array('uint8_t', b.mask_len))) : Buffer.alloc(0); } finally { if (b.mask) XFree(b.mask); }
}
function keyDown(vk) {
  try {
    if (vk > 1000) {
      const btn = vk - 1000;
      if (btn <= 5) { const o = [0], i = [0], mask = [0]; XQueryPointer(dpy, root, o, o, i, i, i, i, mask); return (mask[0] & (1 << (7 + btn))) !== 0; }
      const m = xiButtons();
      return !!m && m.length > btn >> 3 && (m[btn >> 3] & (1 << (btn & 7))) !== 0;
    }
    if (vk <= 0) return false;
    const keys = Buffer.alloc(32); XQueryKeymap(dpy, keys);
    return (keys[vk >> 3] & (1 << (vk & 7))) !== 0;
  } catch { return false; }
}
module.exports = { GetForegroundWindow, IsWindow, pidOf, boundsOf, clientBounds, exclusiveFullscreen, findGame, same, vkOf, keyDown, diag, setPassive, activate, linux: true };
