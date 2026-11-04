// Which window is in front, and where the game's window is (Windows only), through koffi: read-only window
// information (title, owning program, position). Nothing is injected into the game. The one key read is the player's
// own push-to-talk key, if they pick push to talk: whether it's held (GetAsyncKeyState), no other keys.
'use strict';
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const HWND = koffi.pointer('HWND', koffi.opaque());
const GetForegroundWindow = user32.func('HWND __stdcall GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32 *pid)');
const IsWindow = user32.func('int __stdcall IsWindow(HWND hwnd)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(HWND hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(HWND hwnd, _Out_ char16 *buf, int max)');
const GetWindowRect = user32.func('int __stdcall GetWindowRect(HWND hwnd, _Out_ int32 *rect)');
const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(HWND hwnd, intptr lparam)');
const EnumWindows = user32.func('int __stdcall EnumWindows(EnumWindowsProc *cb, intptr lparam)');
const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(intptr handle)');
const QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr handle, uint32 flags, _Out_ char16 *buf, _Inout_ uint32 *size)');

const GetClientRect = user32.func('int __stdcall GetClientRect(HWND hwnd, _Out_ int32 *rect)');
const ClientToScreen = user32.func('int __stdcall ClientToScreen(HWND hwnd, _Inout_ int32 *point)');
const IsIconic = user32.func('int __stdcall IsIconic(HWND hwnd)');
const shell32 = koffi.load('shell32.dll');
const SHQueryUserNotificationState = shell32.func('int32 __stdcall SHQueryUserNotificationState(_Out_ int32 *state)');
// The game's drawing area on screen (inside its title bar and borders, in windowed mode).
function clientBounds(hwnd) {
  const r = [0, 0, 0, 0], p = [0, 0];
  if (IsIconic(hwnd) || !GetClientRect(hwnd, r) || !ClientToScreen(hwnd, p)) return null;
  return { x: p[0], y: p[1], width: r[2] - r[0], height: r[3] - r[1] };
}
// Windows' own answer to "is a game running in exclusive fullscreen?" (QUNS_RUNNING_D3D_FULL_SCREEN = 3).
// Nothing (but an injected overlay) can be drawn over a game in that mode.
function exclusiveFullscreen() { const s = [0]; try { return SHQueryUserNotificationState(s) === 0 && s[0] === 3; } catch { return false; } }
function pidOf(hwnd) { const out = [0]; GetWindowThreadProcessId(hwnd, out); return out[0]; }
function exeOf(pid) {
  if (!pid) return '';
  const h = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!h) return '';
  try { const buf = Buffer.alloc(1040), size = [520]; return QueryFullProcessImageNameW(h, 0, buf, size) ? buf.toString('utf16le', 0, size[0] * 2) : ''; } catch { return ''; } finally { CloseHandle(h); }
}
function titleOf(hwnd) { const buf = Buffer.alloc(512), n = GetWindowTextW(hwnd, buf, 256); return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''; }
function boundsOf(hwnd) { const r = [0, 0, 0, 0]; return GetWindowRect(hwnd, r) ? { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] } : null; }
// The Isle's game window: its program is TheIsleClient-Win64-Shipping.exe (or similar).
const IS_GAME = (exe) => /theisle[^\\]*\.exe$/i.test(exe) && !/server/i.test(exe);
function findGame() {
  let found = null;
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd) || !titleOf(hwnd)) return 1;
    if (IS_GAME(exeOf(pidOf(hwnd)))) { found = hwnd; return 0; }
    return 1;
  }, 'EnumWindowsProc *');
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return found;
}
const same = (a, b) => !!a && !!b && koffi.address(a) === koffi.address(b);
// Push to talk: is this one key (or mouse button) held right now?
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vk)');
const NAMED_KEYS = { mouse4: 0x05, mouse5: 0x06, mousemiddle: 0x04, middlemouse: 0x04, space: 0x20, tab: 0x09, capslock: 0x14, shift: 0x10, ctrl: 0x11, control: 0x11,
  alt: 0x12, lshift: 0xa0, rshift: 0xa1, lctrl: 0xa2, rctrl: 0xa3, lalt: 0xa4, ralt: 0xa5, '`': 0xc0, backquote: 0xc0, enter: 0x0d, insert: 0x2d, delete: 0x2e,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22 };
// A key name as typed in Settings ("V", "Mouse5", "F13", "CapsLock", "Num0") -> its Windows key code, or 0.
function vkOf(name) {
  const k = String(name || '').trim().toLowerCase().replace(/\s+/g, '');
  if (NAMED_KEYS[k]) return NAMED_KEYS[k];
  if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  let m = k.match(/^f(\d{1,2})$/); if (m && +m[1] >= 1 && +m[1] <= 24) return 0x6f + Number(m[1]);
  m = k.match(/^num(?:pad)?(\d)$/); if (m) return 0x60 + Number(m[1]);
  return 0;
}
const keyDown = (vk) => { try { return vk > 0 && (GetAsyncKeyState(vk) & 0x8000) !== 0; } catch { return false; } };
module.exports = { GetForegroundWindow, IsWindow, pidOf, boundsOf, clientBounds, exclusiveFullscreen, findGame, same, vkOf, keyDown };
