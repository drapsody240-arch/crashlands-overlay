// Audio worklets for proximity voice (they run on the audio thread).
// capture: gathers the microphone into 20 ms frames (960 samples at 48 kHz) and hands them to the page.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(960); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === 960) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(960); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);

// mixer: every nearby voice has its own queue (a small jitter buffer: starts once 60 ms is waiting, never holds
// more than 300 ms), played with its own volume and left/right pan (equal-power), mixed into stereo.
class Mixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.s = new Map(); // id -> { q: [Float32Array], off, queued, started, gain, pan, curGain }
    this.master = 1;
    this.port.onmessage = ({ data: m }) => {
      if (m.t === 'pcm') {
        const v = this.s.get(m.id) || { q: [], off: 0, queued: 0, started: false, gain: 0, pan: 0, curGain: 0 };
        v.q.push(m.pcm); v.queued += m.pcm.length;
        while (v.queued > 14400) { const d = v.q.shift(); v.queued -= d.length - v.off; v.off = 0; } // over 300 ms: drop the oldest
        if (!v.started && v.queued >= 2880) v.started = true; // 60 ms waiting: start
        this.s.set(m.id, v);
      } else if (m.t === 'mix') {
        const want = new Map(m.s.map(([id, g, p]) => [id, [g, p]]));
        for (const [id, v] of this.s) { const w = want.get(id); v.gain = w ? w[0] : 0; v.pan = w ? w[1] : v.pan; }
        for (const [id, [g, p]] of want) if (!this.s.has(id)) this.s.set(id, { q: [], off: 0, queued: 0, started: false, gain: g, pan: p, curGain: g });
      } else if (m.t === 'master') this.master = m.v;
    };
  }
  process(_inputs, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || outputs[0][0], n = L.length;
    L.fill(0); if (R !== L) R.fill(0);
    for (const v of this.s.values()) {
      if (!v.started) continue;
      const step = (v.gain - v.curGain) / n; // smooth volume changes (no clicks)
      const a = ((v.pan + 1) * Math.PI) / 4, lg = Math.cos(a), rg = Math.sin(a);
      for (let i = 0; i < n; i++) {
        const d = v.q[0];
        if (!d) { v.started = false; break; } // ran dry: wait for 60 ms again
        const x = d[v.off++] * v.curGain * this.master; v.curGain += step; v.queued--;
        L[i] += x * lg * 1.414; if (R !== L) R[i] += x * rg * 1.414;
        if (v.off >= d.length) { v.q.shift(); v.off = 0; }
      }
      v.curGain = v.gain;
    }
    for (let i = 0; i < n; i++) { if (L[i] > 1) L[i] = 1; else if (L[i] < -1) L[i] = -1; if (R !== L) { if (R[i] > 1) R[i] = 1; else if (R[i] < -1) R[i] = -1; } }
    return true;
  }
}
registerProcessor('mixer', Mixer);
