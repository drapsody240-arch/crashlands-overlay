// CI check (GitHub Actions, under Xvfb): the Linux native module loads and answers without crashing.
const n = require('../app/native-linux.cjs');
const keys = ['V', 'F13', 'CapsLock', 'Num0', 'Mouse5', 'MouseMiddle'].map((k) => [k, n.vkOf(k)]);
console.log('keys', JSON.stringify(keys));
for (const [, vk] of keys) n.keyDown(vk);
console.log('front', n.GetForegroundWindow(), 'game', n.findGame(), 'bogus window', n.boundsOf(0x7fffff), n.IsWindow(0x7fffff));
if (keys.some(([k, vk]) => ['V', 'CapsLock', 'Num0'].includes(k) && !vk)) { console.error('a key did not map'); process.exit(1); }
console.log('native-linux ok');
// The keyboard/alt-tab handling and the diagnostics, on a window that doesn't exist (X errors must be ignored, not crash).
const bogus = Buffer.alloc(8); bogus.writeBigUInt64LE(0x7fffffn);
console.log('diag', JSON.stringify(n.diag()).slice(0, 200));
n.setPassive(bogus, true); n.setPassive(bogus, false); n.activate(0x7fffff);
console.log('focus handling ok');
