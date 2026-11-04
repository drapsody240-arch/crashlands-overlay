// Proximity voice in the overlay: microphone -> voice activation -> Opus (Chromium's own encoder, 24 kbps, 20 ms
// frames) -> our voice server (voice/server.cjs), which forwards it only to players near you in game. Voices from
// nearby players come back, each decoded and played with the volume and side the server gives (distance and
// direction). Nothing goes player to player.
window.Voice = (() => {
  let ws = null, ctx = null, mic = null, cap = null, mixer = null, enc = null, seq = 0, wanted = false, retry = 1000;
  let muted = false, sens = 0.02, lastLoud = 0, level = 0, inGame = false, myId = 0;
  // mode: 'open' (voice activation: sends once louder than the sensitivity) or 'ptt' (push to talk: only while the
  // key is held, whatever the level; a short tail after letting go keeps the end of the word).
  let mode = 'open', pttDown = false, pttUp = 0;
  const counts = { sent: 0, received: 0, decoded: 0 };
  const decoders = new Map(), lastHeard = new Map(), names = {};
  let onStatus = () => {}, status = { state: 'off' };
  const set = (patch) => { status = { ...status, ...patch }; onStatus(status); };

  async function audio(micId) {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('worklets.js');
    mixer = new AudioWorkletNode(ctx, 'mixer', { numberOfInputs: 0, outputChannelCount: [2] });
    mixer.connect(ctx.destination);
    mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const src = ctx.createMediaStreamSource(mic);
    cap = new AudioWorkletNode(ctx, 'capture', { numberOfOutputs: 0 });
    src.connect(cap);
    enc = new AudioEncoder({
      output: (chunk) => {
        if (!ws || ws.readyState !== 1) return;
        const b = new Uint8Array(3 + chunk.byteLength); b[0] = 1; b[1] = (seq >> 8) & 255; b[2] = seq & 255; chunk.copyTo(b.subarray(3));
        seq = (seq + 1) & 65535; ws.send(b); counts.sent++;
      },
      error: () => {},
    });
    enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000, opus: { frameDuration: 20000, complexity: 5 } });
    let ts = 0;
    cap.port.onmessage = ({ data }) => {
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length); level = level * 0.7 + rms * 0.3;
      const loud = rms >= sens;
      if (loud) lastLoud = Date.now();
      const talking = !muted && inGame && (mode === 'ptt' ? pttDown || Date.now() - pttUp < 150 : Date.now() - lastLoud < 350); // keeps the ends of words
      if (talking !== status.talking) set({ talking });
      ts += 20000;
      if (!talking || enc.state !== 'configured') return;
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: ts, data }));
    };
  }
  function decoderFor(id) {
    let d = decoders.get(id);
    if (d && d.state !== 'closed') return d;
    d = new AudioDecoder({
      output: (a) => { counts.decoded++; const pcm = new Float32Array(a.numberOfFrames); a.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' }); a.close(); mixer.port.postMessage({ t: 'pcm', id, pcm }, [pcm.buffer]); },
      error: () => decoders.delete(id),
    });
    d.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    decoders.set(id, d);
    return d;
  }

  async function connect() {
    if (!wanted) return;
    set({ state: 'connecting' });
    let t; try { t = await window.overlay.voiceTicket(); } catch { t = null; }
    if (!t || t.error) { set({ state: 'off', why: t?.error || 'Could not reach the voice server.' }); return later(); }
    ws = new WebSocket(t.url); ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', ticket: t.ticket }));
    ws.onmessage = ({ data }) => {
      if (typeof data !== 'string') {
        const b = new Uint8Array(data); if (b[0] !== 1 || b.length < 6) return;
        const id = (b[1] << 8) | b[2], s = (b[3] << 8) | b[4];
        lastHeard.set(id, Date.now()); counts.received++;
        try { decoderFor(id).decode(new EncodedAudioChunk({ type: 'key', timestamp: s * 20000, data: b.subarray(5) })); } catch {}
        return;
      }
      const m = JSON.parse(data);
      if (m.t === 'hello') { myId = m.id; retry = 1000; set({ state: 'on', why: '' }); }
      else if (m.t === 'mix') { mixer.port.postMessage(m); set({ nearby: m.s.length }); if (m.s.some(([id]) => !(id in names))) ws.send(JSON.stringify({ t: 'names' })); }
      else if (m.t === 'names') Object.assign(names, m.names);
      else if (m.t === 'state') { inGame = m.inGame; set({ inGame: m.inGame, adminMuted: m.muted, rangeM: m.rangeM }); }
      else if (m.t === 'bye') set({ why: m.why });
    };
    ws.onclose = () => { ws = null; if (wanted) { set({ state: 'connecting' }); later(); } };
  }
  function later() { setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); }
  // Who's talking near you (for the overlay's list).
  setInterval(() => { if (!wanted) return; const now = Date.now(); set({ speakers: [...lastHeard].filter(([, t]) => now - t < 600).map(([id]) => names[id] || 'Someone'), level }); }, 250);

  return {
    onStatus: (cb) => { onStatus = cb; cb(status); },
    async start(opts) {
      if (wanted) return; wanted = true; sens = opts.sensitivity ?? sens; muted = !!opts.muted; mode = opts.mode === 'ptt' ? 'ptt' : 'open';
      try { await audio(opts.micId); } catch (e) { wanted = false; set({ state: 'off', why: `Microphone: ${e.message}` }); return; }
      if (mixer) mixer.port.postMessage({ t: 'master', v: opts.volume ?? 1 });
      connect();
    },
    stop() {
      wanted = false; try { ws?.close(); } catch {} ws = null;
      try { mic?.getTracks().forEach((t) => t.stop()); } catch {}
      try { enc?.close(); } catch {} for (const d of decoders.values()) try { d.close(); } catch {}
      decoders.clear(); try { ctx?.close(); } catch {} ctx = null; set({ state: 'off', talking: false, speakers: [], nearby: 0 });
    },
    setMuted(v) { muted = !!v; set({ muted }); },
    toggleMute() { this.setMuted(!muted); return muted; },
    setSensitivity(v) { sens = v; },
    setMode(m) { mode = m === 'ptt' ? 'ptt' : 'open'; set({ mode }); },
    setPtt(down) { if (!down && pttDown) pttUp = Date.now(); pttDown = !!down; },
    setVolume(v) { if (mixer) mixer.port.postMessage({ t: 'master', v }); },
    level: () => level,
    counts: () => ({ ...counts }),
  };
})();
