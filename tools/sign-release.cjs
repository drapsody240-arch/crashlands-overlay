// Signs the built installers (Windows .exe, Linux .AppImage from the GitHub build) with our private key (C:\IsleServer\secrets\overlay-signing-key.pem, never in git).
// The overlay installs an update only if its .sig checks out against update-public-key.pem.
// node tools/sign-release.cjs   (after npm run dist)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const REL = path.join(__dirname, '..', 'release');
const key = fs.readFileSync(path.join(__dirname, '..', '..', 'secrets', 'overlay-signing-key.pem'), 'utf8');
const pub = fs.readFileSync(path.join(__dirname, '..', 'update-public-key.pem'), 'utf8');
let n = 0;
for (const f of fs.readdirSync(REL).filter((x) => x.endsWith('.exe') || x.endsWith('.AppImage'))) {
  const data = fs.readFileSync(path.join(REL, f)), sig = crypto.sign(null, data, key);
  if (!crypto.verify(null, data, pub, sig)) throw new Error('signature does not match the public key');
  fs.writeFileSync(path.join(REL, `${f}.sig`), sig.toString('base64'));
  console.log(`signed ${f} (${(data.length / 1e6).toFixed(1)} MB)`); n++;
}
if (!n) console.log('nothing to sign: run npm run dist first');

// The player download: a zip of the latest installer + README (the website links it; the updater uses the .exe).
const version = (fs.readFileSync(path.join(REL, 'latest.yml'), 'utf8').match(/^version:\s*(.+)$/m) || [])[1];
const exe = path.join(REL, `CrashLands-Overlay-Setup-${version}.exe`);
if (version && fs.existsSync(exe)) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ovzip-')), zip = path.join(REL, `CrashLands-Overlay-${version}.zip`);
  fs.copyFileSync(exe, path.join(tmp, path.basename(exe)));
  fs.writeFileSync(path.join(tmp, 'README.txt'), fs.readFileSync(path.join(__dirname, 'player-readme.txt'), 'utf8').replaceAll('{version}', version));
  require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zip}' -Force`]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`zipped ${path.basename(zip)} (${(fs.statSync(zip).size / 1e6).toFixed(1)} MB)`);
}
