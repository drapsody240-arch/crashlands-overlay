// CI check (GitHub Actions, under Xvfb): the Linux native module loads and answers without crashing.
const n = require('../app/native-linux.cjs');
const keys = ['V', 'F13', 'CapsLock', 'Num0', 'Mouse5', 'MouseMiddle'].map((k) => [k, n.vkOf(k)]);
console.log('keys', JSON.stringify(keys));
for (const [, vk] of keys) n.keyDown(vk);
console.log('front', n.GetForegroundWindow(), 'game', n.findGame(), 'bogus window', n.boundsOf(0x7fffff), n.IsWindow(0x7fffff));
if (keys.some(([k, vk]) => k !== 'Mouse5' && k !== 'MouseMiddle' && !vk)) { console.error('a key did not map'); process.exit(1); }
console.log('native-linux ok');
