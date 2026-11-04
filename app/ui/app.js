// The overlay's page: the HUD (the game's honeycomb of vitals, copied), the minimap, the voice box, notifications,
// and the dashboard frame (the website itself is a view the app puts inside it). The HUD, minimap and voice box are
// placed by the layout (fractions of the game's area, so it holds in windowed and fullscreen) and moved in
// Edit layout. Data comes from the app (window.overlay, see preload.cjs).
const $ = (s) => document.querySelector(s);
const O = window.overlay;
let settings = {}, live = { me: null, map: null }, mapImg = null, signedIn = false, editing = false;

// ---- layout: where things sit (fractions of the window, which the app fits to the game's area) ----
// Defaults from the game's own HUD: its honeycomb sits bottom right (this covers it); the minimap and voice box
// start bottom left, clear of the game's text.
const DEFAULT_LAYOUT = { hud: { x: 0.8725, y: 0.7305, w: 0.1265 }, map: { x: 0.012, y: 0.74, h: 0.22 }, voice: { x: 0.012, y: 0.68 } };
const layout = () => ({ hud: { ...DEFAULT_LAYOUT.hud, ...settings.layout?.hud }, map: { ...DEFAULT_LAYOUT.map, ...settings.layout?.map }, voice: { ...DEFAULT_LAYOUT.voice, ...settings.layout?.voice } });
const HUD_W = 253, HUD_H = 246;
const MINI_RATIO = 1221 / 700; // minimap-frame.png
// The map shows inside the frame's inner edge: a wide hexagon (fractions of the frame's width and height).
const MINI_INNER = [[0.045, 0.5], [0.165, 0.075], [0.835, 0.075], [0.955, 0.5], [0.835, 0.925], [0.165, 0.925]]; // the cluster's own drawing size (scaled to the layout's width)
function applyLayout() {
  const L = layout(), W = innerWidth, H = innerHeight;
  const hud = $('#hud'), hw = L.hud.w * W;
  hud.style.width = `${hw}px`; hud.style.height = `${hw * HUD_H / HUD_W}px`;
  place(hud, L.hud.x, L.hud.y);
  // The minimap is the owner's wide hexagon frame (img/minimap-frame.png): as wide as MINI_RATIO times its height.
  const size = Math.round(Math.max(120, L.map.h * H)), mw = Math.round(size * MINI_RATIO), c = $('#miniCanvas');
  if (c.width !== mw || c.height !== size) { c.width = mw; c.height = size; }
  $('#mini').style.width = `${mw}px`; $('#mini').style.height = `${size}px`;
  place($('#mini'), L.map.x, L.map.y);
  place($('#voice'), L.voice.x, L.voice.y);
}
function place(el, fx, fy) {
  const W = innerWidth, H = innerHeight, w = el.offsetWidth || parseFloat(el.style.width) || 0, h = el.offsetHeight || parseFloat(el.style.height) || 0;
  el.style.left = `${Math.max(0, Math.min(W - w, fx * W))}px`; el.style.top = `${Math.max(0, Math.min(H - h, fy * H))}px`;
}
addEventListener('resize', applyLayout);

async function applySettings(s) {
  settings = s; signedIn = s.signedIn;
  buildHud(); applyLayout(); render(); syncVoice();
}

// ---- proximity voice (voice.js) ----
let voiceOn = false, voiceMic = null;
function syncVoice() {
  const want = signedIn && settings.voice !== false;
  if (want && (!voiceOn || voiceMic !== (settings.micId || ''))) {
    if (voiceOn) Voice.stop();
    voiceOn = true; voiceMic = settings.micId || '';
    Voice.start({ micId: voiceMic, sensitivity: Number(settings.voiceSensitivity) || 0.02, volume: Number(settings.voiceVolume ?? 1), muted: !!settings.voiceMuted, mode: settings.voiceMode });
  } else if (!want && voiceOn) { voiceOn = false; Voice.stop(); }
  if (voiceOn) { Voice.setSensitivity(Number(settings.voiceSensitivity) || 0.02); Voice.setVolume(Number(settings.voiceVolume ?? 1)); Voice.setMuted(!!settings.voiceMuted); Voice.setMode(settings.voiceMode); }
}
O.onVoicePtt(({ down }) => Voice.setPtt(down));
let lastVoice = {};
Voice.onStatus((v) => {
  lastVoice = v;
  const box = $('#voice');
  box.hidden = !voiceOn && !editing;
  box.classList.toggle('talking', !!v.talking); box.classList.toggle('muted', !!v.muted || !!v.adminMuted);
  $('#voiceText').textContent = v.state !== 'on' ? (v.why || 'Voice: connecting…') : v.adminMuted ? 'Muted by an admin'
    : v.muted ? `Muted (${settings.voiceMuteKey || 'F9'})` : !v.inGame ? 'Voice: join the game to talk'
    : v.talking ? '🎙️ Talking' : settings.voiceMode === 'ptt' ? `Voice · hold ${settings.voicePttKey || 'Mouse5'} to talk` : 'Voice on';
  // Only players actually talking are named (no count of who's nearby).
  $('#voiceWho').textContent = (v.speakers || []).length ? `🔊 ${v.speakers.join(', ')}` : '';
});

// ---- HUD: the game's honeycomb (stamina in the big footprint, food, water, the three nutrients), plus health ----
// The game has no health hexagon, so health gets its own in the empty corner above the footprint (covering nothing
// of the game's). The game's dotted line under the footprint is left showing.
const HEXES = [
  { key: 'st', cx: 63, cy: 169, r: 75, icon: 'foot', colour: '#ffcf4a' },
  { key: 'hp', cx: 50, cy: 52, r: 36, icon: 'heart', colour: '#ff6b6b' },
  { key: 'food', cx: 129, cy: 85, r: 50, icon: 'stomach', colour: '#f2b25c' },
  { key: 'water', cx: 168, cy: 164, r: 48, icon: 'drop', colour: '#5ab6ff' },
  { key: 'carb', cx: 165, cy: 31, r: 30, letter: 'α', colour: '#8eeaf6' },
  { key: 'protein', cx: 223, cy: 31, r: 30, letter: 'β', colour: '#8eeaf6' },
  { key: 'lipid', cx: 194, cy: 81, r: 30, letter: 'γ', colour: '#8eeaf6' },
];
const pts = (cx, cy, r) => [0, 1, 2, 3, 4, 5].map((i) => { const a = (Math.PI / 3) * i - Math.PI / 2; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
const ICONS = {
  // a three-toed footprint, a stomach, a water drop (drawn around 0,0, about 40 across)
  foot: '<g><ellipse cx="0" cy="10" rx="10" ry="9"/><g stroke="#8eeaf6" stroke-width="7" stroke-linecap="round"><line x1="-4" y1="4" x2="-16" y2="-16"/><line x1="0" y1="2" x2="0" y2="-22"/><line x1="4" y1="4" x2="16" y2="-16"/></g></g>',
  stomach: '<path d="M-5,-21 L-5,-12 C-5,-7 -16,-7 -16,5 C-16,18 -2,22 8,15 C18,8 16,-5 6,-7 C2,-8 1,-12 1,-21 Z"/>',
  drop: '<path d="M0,-20 C9,-7 13,0 13,7 A13,13 0 0 1 -13,7 C-13,0 -9,-7 0,-20Z"/>',
  heart: '<path transform="scale(0.62)" d="M0,18 C-20,4 -24,-6 -18,-14 C-12,-21 -3,-18 0,-11 C3,-18 12,-21 18,-14 C24,-6 20,4 0,18Z"/>',
};
// The frame and icons are the owner's art (2026-11-04, img/): one hexagon frame (hex.png, cut from the honeycomb
// picture) drawn over each cell at its size, and an icon per stat. Under the frame: a dark body and the level (the
// stat's colour, filling from the bottom), both inside the frame's inner edge. A low stat turns the frame red.
const HEX_IMG = { w: 309, h: 357 }; // hex.png: a pointy-top hexagon, corner to corner, glow included
function buildHud() {
  let defs = `<radialGradient id="hexBody" cx="50%" cy="30%" r="75%"><stop offset="0" stop-color="#123a44" stop-opacity="0.92"/><stop offset="1" stop-color="#050f13" stop-opacity="0.92"/></radialGradient>
    <filter id="lowRed"><feColorMatrix type="matrix" values="0 0 1.2 0 0  0 0.25 0 0 0  0 0.25 0 0 0  0 0 0 1 0"/></filter>`, body = '';
  for (const h of HEXES) {
    const inner = pts(h.cx, h.cy, h.r * 0.86), fh = h.r * 2.04, fw = fh * HEX_IMG.w / HEX_IMG.h;
    defs += `<clipPath id="clip-${h.key}"><polygon points="${inner}"/></clipPath>`
      + `<linearGradient id="lg-${h.key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${h.colour}" stop-opacity="0.95"/><stop offset="1" stop-color="${h.colour}" stop-opacity="0.45"/></linearGradient>`;
    const big = h.r > 40, iconY = big ? h.cy - (h.r > 60 ? 14 : 8) : h.cy - 6, is = h.r * (big ? (h.r > 60 ? 0.62 : 0.66) : 0.78);
    body += `<g id="hex-${h.key}"><polygon class="body" points="${inner}" fill="url(#hexBody)"/>
      <rect class="level" id="lvl-${h.key}" clip-path="url(#clip-${h.key})" x="${h.cx - h.r}" width="${h.r * 2}" y="${h.cy + h.r}" height="0" fill="url(#lg-${h.key})"/>
      <image class="icon" href="img/icon-${h.key}.png" x="${h.cx - is / 2}" y="${iconY - is / 2}" width="${is}" height="${is}"/>
      <text class="pct${big ? '' : ' small'}" id="pct-${h.key}" x="${h.cx}" y="${big ? h.cy + h.r * (h.r > 60 ? 0.55 : 0.6) : h.cy + 20}" text-anchor="middle"></text>
      <image class="frame" href="img/hex.png" x="${h.cx - fw / 2}" y="${h.cy - fh / 2}" width="${fw}" height="${fh}"/></g>`;
  }
  body += '<text class="growth" id="hudGrowth" x="2" y="10"></text>';
  // Ceratosaurus bile (its bacterial bite charge): the game shows it under its honeycomb, which this covers, so it's
  // drawn here, under the hexagons, only for a Cera (the owner, 2026-11-04). Assumed 0-100 until seen otherwise.
  body += `<g id="hudBile" hidden><text class="bileLbl" x="112" y="238">Bile</text><rect class="bileBg" x="140" y="229" width="110" height="12" rx="3"/>
    <rect class="bileLvl" id="bileLvl" x="140" y="229" width="0" height="12" rx="3"/><text class="bilePct" id="bilePct" x="195" y="239" text-anchor="middle"></text></g>`;
  $('#hud').innerHTML = `<svg viewBox="0 0 ${HUD_W} ${HUD_H}"><defs>${defs}</defs>${body}</svg>`;
}
const pct = (v, m) => (typeof v === 'number' && m > 0 ? Math.max(0, Math.min(100, (v / m) * 100)) : null);
function setHex(key, p) {
  const h = HEXES.find((x) => x.key === key), lvl = document.getElementById(`lvl-${key}`), t = document.getElementById(`pct-${key}`);
  if (!h || !lvl) return;
  const v = p ?? 0, hgt = h.r * 2 * (v / 100);
  lvl.setAttribute('y', h.cy + h.r - hgt); lvl.setAttribute('height', hgt);
  t.textContent = p === null ? '–' : `${Math.round(p)}%`;
  document.getElementById(`hex-${key}`).classList.toggle('low', p !== null && p < 25 && ['hp', 'st', 'food', 'water'].includes(key));
}
function render() {
  const me = live.me || (editing ? { species: 'Example', growth: 0.73, hp: 80, maxHp: 100, st: 60, maxSt: 100, food: 45, maxFood: 100, water: 90, maxWater: 100, carb: 30, protein: 55, lipid: 70 } : null);
  const show = (signedIn && !!me && settings.hud) || editing;
  $('#hud').hidden = !show;
  if (show && me) {
    setHex('hp', pct(me.hp, me.maxHp)); setHex('food', pct(me.food, me.maxFood)); setHex('water', pct(me.water, me.maxWater));
    setHex('carb', pct(me.carb, me.maxFood)); setHex('protein', pct(me.protein, me.maxFood)); setHex('lipid', pct(me.lipid, me.maxFood));
    setHex('st', pct(me.st, me.maxSt));
    $('#hudGrowth').textContent = typeof me.growth === 'number' ? `${Math.round(me.growth * 100)}% grown` : '';
    const bile = typeof me.bile === 'number' ? Math.max(0, Math.min(100, me.bile)) : null;
    $('#hudBile').toggleAttribute('hidden', bile === null);
    if (bile !== null) {
      $('#bileLvl').setAttribute('width', (110 * bile / 100).toFixed(1));
      $('#bilePct').textContent = me.bileCost > 0 ? `${Math.round(bile)}% · ${Math.floor(me.bile / me.bileCost)} bite${Math.floor(me.bile / me.bileCost) === 1 ? '' : 's'}` : `${Math.round(bile)}%`;
    }
  }
  drawMini();
}

// ---- minimap: the map image around you, north up; you and friends as arrows ----
function drawMini() {
  // Staff with the radar on see every player nearby (never sent to anyone else).
  const useRadar = staff && settings.staffRadar !== false && live.staff?.radar?.calibrated;
  const map = useRadar ? live.staff.radar : live.map, real = signedIn && settings.minimap && map?.calibrated && map.markers?.length && mapImg;
  $('#mini').hidden = !(real || editing);
  const c = $('#miniCanvas'), g = c.getContext('2d'), W = c.width, H = c.height, size = H;
  const hexPath = () => { g.beginPath(); MINI_INNER.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H))); g.closePath(); };
  if (!real) { if (editing) { g.clearRect(0, 0, W, H); hexPath(); g.fillStyle = '#16303a'; g.fill(); } return; }
  const me = map.markers.find((m) => m.me) || map.markers[0];
  const scale = (Number(settings.mapZoom) || 3) * (size / 600); // image pixels -> screen pixels
  g.save(); g.clearRect(0, 0, W, H);
  hexPath(); g.clip();
  g.fillStyle = '#0b0e11'; g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2); g.scale(scale, scale); g.translate(-me.px, -me.py);
  g.drawImage(mapImg, 0, 0);
  for (const m of map.markers) {
    g.save(); g.translate(m.px, m.py); g.rotate(((m.heading || 0) * Math.PI) / 180); const r = 7 / scale;
    g.beginPath(); g.moveTo(0, -r * 1.6); g.lineTo(r, r); g.lineTo(0, r * 0.4); g.lineTo(-r, r); g.closePath();
    const friend = !useRadar || (live.map?.markers || []).some((f) => f.name === m.name && !f.me);
    g.fillStyle = m.me ? '#7cf2a6' : friend ? '#5ab6ff' : '#ff9f43'; g.strokeStyle = '#000'; g.lineWidth = 1.5 / scale; g.fill(); g.stroke(); g.restore();
    const label = m.me ? '' : useRadar ? `${m.name || '?'} · ${m.species || ''}` : m.name;
    if (label) { g.font = `${11 / scale}px system-ui, 'Segoe UI'`; g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 3 / scale; g.strokeText(label, m.px + 9 / scale, m.py + 4 / scale); g.fillText(label, m.px + 9 / scale, m.py + 4 / scale); }
  }
  g.restore();
}

// ---- notifications ----
function note({ text, kind }) {
  if (settings.notes === false || !text) return;
  const el = document.createElement('div');
  el.className = `note ${kind || ''}`; el.textContent = text;
  $('#notes').prepend(el);
  while ($('#notes').children.length > 5) $('#notes').lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, 7000);
}

// ---- Edit layout: drag the HUD, minimap and voice box; sizes on the bar at the top ----
let drag = null, draft = null;
function startEdit() {
  editing = true; draft = layout();
  document.body.classList.add('editing'); $('#editBar').hidden = false; $('#settings').hidden = true; $('#signIn').hidden = true;
  O.showSite(false);
  $('#eHex').value = (draft.hud.w * 100).toFixed(1); $('#eMap').value = Math.round(draft.map.h * innerHeight);
  $('#voice').hidden = false; render(); applyLayout();
}
async function endEdit(save) {
  editing = false; document.body.classList.remove('editing'); $('#editBar').hidden = true;
  if (save) settings = await O.setSettings({ layout: draft });
  draft = null; $('#voice').hidden = !voiceOn; render(); applyLayout();
  if (signedIn) O.showSite(true);
}
document.addEventListener('mousedown', (e) => {
  if (!editing) return;
  const el = e.target.closest('.movable'); if (!el) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  drag = { el, part: el.dataset.part, dx: e.clientX - r.left, dy: e.clientY - r.top };
});
document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const W = innerWidth, H = innerHeight, w = drag.el.offsetWidth, h = drag.el.offsetHeight;
  const x = Math.max(0, Math.min(W - w, e.clientX - drag.dx)), y = Math.max(0, Math.min(H - h, e.clientY - drag.dy));
  drag.el.style.left = `${x}px`; drag.el.style.top = `${y}px`;
  draft[drag.part].x = x / W; draft[drag.part].y = y / H;
});
document.addEventListener('mouseup', () => { drag = null; });
// The editor works on a draft (shown live through the layout function) until Done.
const liveDraft = () => { settings = { ...settings, layout: draft }; applyLayout(); render(); };
$('#eHex').addEventListener('input', (e) => { draft.hud.w = Number(e.target.value) / 100; liveDraft(); });
$('#eMap').addEventListener('input', (e) => { draft.map.h = Number(e.target.value) / innerHeight; liveDraft(); });
$('#eReset').onclick = () => { draft = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); $('#eHex').value = (draft.hud.w * 100).toFixed(1); $('#eMap').value = Math.round(draft.map.h * innerHeight); liveDraft(); };
$('#eDone').onclick = () => endEdit(true);
$('#btnEdit').onclick = startEdit;

// ---- staff (only once the server says this account is staff): tabs, staff tools, radar ----
let staff = false, staffRole = null, tab = 'site', stSel = null;
function onStaff(s) {
  staff = !!s?.staff; staffRole = s?.role || null;
  $('#tabs').hidden = !staff; $('#sRadarRow').hidden = !staff;
  if (!staff && tab !== 'site') setTab('site');
  render();
}
async function setTab(t) {
  tab = await O.dashTab(t);
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('primary', b.dataset.tab === tab);
  $('#staffPanel').hidden = tab !== 'staff'; $('#settings').hidden = true;
  if (tab === 'staff') renderStaff();
}
document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderStaff() {
  if ($('#staffPanel').hidden) return;
  $('#stRole').textContent = staffRole ? `· ${staffRole}` : '';
  const q = $('#stFind').value.trim().toLowerCase(), list = (live.staff?.players || []).filter((p) => !q || `${p.name} ${p.species}`.toLowerCase().includes(q));
  $('#stList').innerHTML = list.length ? list.map((p) => `<div class="stRow${stSel === p.steam ? ' sel' : ''}" data-steam="${p.steam}">
      <div class="who"><b>${escH(p.name)}</b> <small>${escH(p.species || '')}${typeof p.growth === 'number' ? ` · ${Math.round(p.growth * 100)}%` : ''}${p.dist !== null ? ` · ${p.dist} m` : ''}</small></div>
      <button data-act="goto" title="Teleport to them">Go to</button><button data-act="bring" title="Bring them to you">Bring</button><button data-act="heal" title="Full health">Heal</button>
      <button data-act="slay" title="Kill their dino">Slay</button><button data-act="message" title="Message them (type it below)">Message</button></div>`).join('')
    : '<p class="muted">No one in game right now.</p>';
}
$('#stFind').addEventListener('input', renderStaff);
$('#stList').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-steam]'); if (!row) return;
  stSel = row.dataset.steam;
  const b = e.target.closest('[data-act]');
  if (!b) { renderStaff(); return; }
  const act = b.dataset.act, name = row.querySelector('b').textContent;
  if (act === 'slay' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sure?'; return; }
  if (act === 'message' && !$('#stMsg').value.trim()) { note({ text: 'Type the message below first.', kind: 'warn' }); $('#stMsg').focus(); return; }
  const r = await O.staffAction({ action: act, steamId: stSel, text: $('#stMsg').value });
  if (r?.error) note({ text: `${name}: ${r.error}`, kind: 'warn' });
  else { note({ text: `${{ goto: 'Teleported to', bring: 'Brought', heal: 'Healed', slay: 'Slayed', message: 'Messaged' }[act]} ${name}.`, kind: 'staff' }); if (act === 'message') $('#stMsg').value = ''; }
  renderStaff();
});

// Staff tickets: every open ticket (Discord or website) with its recent messages; reply, claim, close.
let stSub = 'players', tkData = { tickets: [] }, tkSel = null;
function setSub(s) {
  stSub = s;
  for (const b of document.querySelectorAll('[data-sub]')) b.classList.toggle('primary', b.dataset.sub === s);
  $('#stPlayers').hidden = s !== 'players'; $('#stTickets').hidden = s !== 'tickets'; $('#stFind').hidden = s !== 'players';
  if (s === 'tickets') loadStaffTickets(); else renderStaff();
}
document.querySelectorAll('[data-sub]').forEach((b) => { b.onclick = () => setSub(b.dataset.sub); });
async function loadStaffTickets() {
  if (!staff) return;
  const r = await O.staffTickets();
  if (r && !r.error) tkData = r;
  renderStaffTickets();
}
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
function renderStaffTickets() {
  const list = tkData.tickets || [];
  $('#stTkCount').textContent = list.length ? `(${list.length})` : '';
  if ($('#stTickets').hidden) return;
  const t = tkSel && list.find((x) => x.channelId === tkSel);
  if (tkSel && !t) tkSel = null;
  $('#stTkList').hidden = !!t; $('#stTkView').hidden = !t;
  if (!t) {
    $('#stTkList').innerHTML = list.length ? list.map((x) => { const last = x.messages[x.messages.length - 1];
      return `<div class="tkRow" data-ch="${x.channelId}"><b>#${x.n}</b> ${escH(x.opener)} ${x.web ? '<small>🌐 website</small>' : ''} <small>· opened ${ago(x.openedAt)}${x.claimedBy ? ` · claimed by ${escH(x.claimedBy)}` : ' · not claimed'}</small>
        ${last ? `<div class="last">${last.staff ? '🛡️' : '💬'} ${escH(last.name)}: ${escH(last.text)}</div>` : ''}</div>`; }).join('') : '<p class="muted">No open tickets. 🎉</p>';
    return;
  }
  $('#stTkTitle').textContent = `#${t.n} · ${t.opener}${t.web ? ' (website)' : ''}${t.claimedBy ? ` · claimed by ${t.claimedBy}` : ''}`;
  const box = $('#stTkMsgs'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = t.messages.length ? t.messages.map((m) => `<div class="tkMsg${m.staff ? ' staff' : ''}"><div class="meta">${escH(m.name)} · ${new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>${escH(m.text)}</div>`).join('') : '<p class="muted">No messages yet.</p>';
  if (atBottom || box.dataset.ch !== t.channelId) { box.scrollTop = box.scrollHeight; box.dataset.ch = t.channelId; }
}
$('#stTkList').addEventListener('click', (e) => { const r = e.target.closest('[data-ch]'); if (r) { tkSel = r.dataset.ch; renderStaffTickets(); } });
$('#stTkBack').onclick = () => { tkSel = null; renderStaffTickets(); };
async function tkAct(act, extra) {
  const r = await O.staffTicket({ act, channelId: tkSel, ...extra });
  if (r?.error) note({ text: r.error, kind: 'warn' }); else note({ text: r.msg || 'Done.', kind: 'staff' });
  setTimeout(loadStaffTickets, 1500);
  return !r?.error;
}
$('#stTkSend').onclick = async () => { const v = $('#stTkReply').value.trim(); if (!v) return; if (await tkAct('reply', { text: v })) $('#stTkReply').value = ''; };
$('#stTkClaim').onclick = () => tkAct('claim');
$('#stTkClose').onclick = async (e) => {
  const b = e.target;
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sure? Click again'; setTimeout(() => { b.dataset.sure = ''; b.textContent = '🔒 Close ticket'; }, 4000); return; }
  if (await tkAct('close', { reason: $('#stTkReason').value })) { $('#stTkReason').value = ''; tkSel = null; }
};
// Fresh while the tickets view is open; the count on the button every so often.
setInterval(() => { if (staff && !$('#staffPanel').hidden && stSub === 'tickets' && !$('#stTkReply').matches(':focus')) loadStaffTickets(); }, 4000);
setInterval(() => { if (staff) loadStaffTickets(); }, 30000);

// ---- dashboard ----
function showDash({ open, needSignIn }) {
  if (!open && editing) endEdit(true);
  $('#dash').hidden = !open;
  $('#signIn').hidden = !(open && (needSignIn || !signedIn));
  $('#settings').hidden = true;
  $('#staffPanel').hidden = !(open && tab === 'staff');
}
// The bar sits on top of the website panel (its size is a setting).
O.onDashRect((r) => { const b = $('#dashBar'); b.style.left = `${r.x}px`; b.style.top = `${r.y - 34}px`; b.style.width = `${r.width}px`; $('#notes').style.top = `${Math.max(18, r.y - 34)}px`; });
$('#btnClose').onclick = () => O.toggleDash(false);
$('#btnSettings').onclick = async () => {
  const s = await O.getSettings();
  $('#sHud').checked = s.hud; $('#sMini').checked = s.minimap; $('#sNotes').checked = s.notes; $('#sRadar').checked = s.staffRadar !== false;
  $('#sMapZoom').value = s.mapZoom; $('#sOpacity').value = s.opacity; $('#sDashSize').value = s.dashSize; $('#sHotkey').value = s.hotkey;
  $('#ver').textContent = `CrashLands Overlay ${await O.version()}`;
  $('#sVoice').checked = s.voice !== false; $('#sSens').value = s.voiceSensitivity; $('#sVolume').value = s.voiceVolume; $('#sMuteKey').value = s.voiceMuteKey;
  $('#sVoiceMode').value = s.voiceMode === 'ptt' ? 'ptt' : 'open'; $('#sPttKey').value = s.voicePttKey || 'Mouse5';
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const sel = $('#sMic'); sel.length = 1;
    devs.forEach((d, i) => { const o = new Option(d.label || `Microphone ${i + 1}`, d.deviceId); o.selected = d.deviceId === s.micId; sel.add(o); });
  } catch { /* no devices */ }
  $('#btnSignOut').hidden = !s.signedIn;
  $('#settings').hidden = false; $('#signIn').hidden = true; $('#staffPanel').hidden = true; O.showSite(false);
};
$('#btnBack').onclick = () => { $('#settings').hidden = true; if (tab === 'staff') $('#staffPanel').hidden = false; else if (signedIn) O.showSite(true); else $('#signIn').hidden = false; };
$('#btnSave').onclick = async () => {
  const s = await O.setSettings({ hud: $('#sHud').checked, minimap: $('#sMini').checked, notes: $('#sNotes').checked, staffRadar: $('#sRadar').checked, mapZoom: Number($('#sMapZoom').value),
    opacity: Number($('#sOpacity').value), dashSize: Number($('#sDashSize').value), hotkey: $('#sHotkey').value.trim() || 'F8',
    voice: $('#sVoice').checked, micId: $('#sMic').value, voiceSensitivity: Number($('#sSens').value), voiceVolume: Number($('#sVolume').value), voiceMuteKey: $('#sMuteKey').value.trim() || 'F9',
    voiceMode: $('#sVoiceMode').value, voicePttKey: $('#sPttKey').value.trim() || 'Mouse5' });
  applySettings(s); note({ text: 'Settings saved.' }); $('#btnBack').onclick();
};
$('#btnSignIn').onclick = () => { O.signIn(); $('#signInWait').hidden = false; };
$('#btnSignOut').onclick = () => O.signOut();
$('#btnQuit').onclick = () => O.quit();

// The sensitivity meter: your mic level against the threshold, while Settings are open.
setInterval(() => {
  if ($('#settings').hidden) return;
  const max = 0.12, lv = Math.min(1, Voice.level() / max), th = Math.min(1, Number($('#sSens').value) / max);
  $('#sLevel').style.width = `${lv * 100}%`; $('#sLevel').style.background = lv >= th ? '#7cf2a6' : '#5ab6ff'; $('#sThresh').style.left = `${th * 100}%`;
}, 80);

// ---- wiring ----
O.onVoiceMute(async () => { if (!voiceOn) return; const m = Voice.toggleMute(); settings = await O.setSettings({ voiceMuted: m }); note({ text: m ? '🔇 Voice muted' : '🎙️ Voice on' }); });
O.onLive((d) => { live = d; render(); renderStaff(); });
O.onStaff(onStaff);
O.onNote(note);
O.onDash(showDash);
O.onLiveStatus(({ connected }) => { $('#dashStatus').textContent = connected ? 'connected' : 'reconnecting…'; });
O.onAuth(async (a) => {
  $('#signInWait').hidden = !a.pending;
  if (a.signedIn) { note({ text: '✔ Signed in. Press your dashboard key any time.' }); await applySettings(await O.getSettings()); O.toggleDash(true); }
  else if (a.failed) note({ text: 'Sign-in timed out: try again.', kind: 'warn' });
  else if (a.expired) note({ text: 'Your overlay sign-in ran out: sign in again.', kind: 'warn' });
  if (a.signedIn === false) { signedIn = false; render(); }
});
(async () => {
  await applySettings(await O.getSettings());
  onStaff(await O.staffGet());
  const src = await O.mapImage();
  if (src) { mapImg = new Image(); mapImg.onload = render; mapImg.src = src; }
  if (!signedIn) note({ text: `CrashLands Overlay is running. Press ${settings.hotkey || 'F8'} to sign in.` });
})();
