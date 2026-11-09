/** Sound. A sound source knows how to load its samples and make a sounder; a sounder schedules whatever
 * should sound between two scene times, mapping scene time to the audio context's clock. The engine owns
 * the clocks and the loops: the same sounder runs live (a lookahead scheduler on the audio clock) and
 * offline (rendered faster than real time for export), so what you hear while scrubbing is what you export. */

import type { Cut, Shot } from './cut.js';

export interface Sounder {
  /** Schedule everything that sounds in scene time [t0, t1). `at(s)` maps scene seconds to context seconds; `rate` is playback speed. */
  schedule(t0: number, t1: number, at: (s: number) => number, rate: number): void;
  /** Stop and clear anything scheduled (on seek or pause). */
  silence?(): void;
}

export interface SoundSource {
  /** Load buffers into this context (called once per context). */
  load?(ctx: BaseAudioContext): Promise<void>;
  /** Make a sounder that plays into `dest`. */
  create(ctx: BaseAudioContext, dest: AudioNode): Sounder;
}

/** Render a sound source offline over output time [0, duration). With a cut, each shot plays its own
 * stretch of the scene through its own sounder, gated to the shot, so sound cuts exactly where picture does. */
export async function renderOffline(source: SoundSource, duration: number, sampleRate = 48000, channels = 2, cut?: Cut): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(channels, Math.ceil(sampleRate * duration), sampleRate);
  await source.load?.(ctx);
  if (!cut) { source.create(ctx, ctx.destination).schedule(0, duration, x => x, 1); return ctx.startRendering(); }
  for (const sh of cut.shots) {
    const gate = shotGate(ctx, sh, T => T); gate.connect(ctx.destination);
    source.create(ctx, gate).schedule(sh.src0, sh.src0 + (sh.T1 - sh.T0) * sh.rate, s => sh.T0 + (s - sh.src0) / sh.rate, sh.rate);
  }
  return ctx.startRendering();
}

/** A gain node open only while a shot plays (4 ms edges, so cuts don't click). `at` maps output time to context time. */
function shotGate(ctx: BaseAudioContext, sh: Shot, at: (T: number) => number): GainNode {
  const g = ctx.createGain(), a = at(sh.T0), b = at(sh.T1), e = .004;
  g.gain.setValueAtTime(0, 0);
  if (a > e) g.gain.setValueAtTime(0, a - e); g.gain.linearRampToValueAtTime(1, Math.max(a, 0) + e);
  g.gain.setValueAtTime(1, Math.max(b - e, a + e)); g.gain.linearRampToValueAtTime(0, b + e);
  return g;
}

export interface PcmLike { numberOfChannels: number; length: number; sampleRate: number; getChannelData(ch: number): Float32Array }

/** 16-bit PCM WAV. When `ceiling` is set, a mix that peaks above it is scaled down to it. */
export function encodeWav(buf: PcmLike, ceiling: number | null = .89): { wav: ArrayBuffer; peak: number } {
  const nc = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, bpf = 2 * nc;
  const chs = Array.from({ length: nc }, (_, c) => buf.getChannelData(c));
  const ab = new ArrayBuffer(44 + n * bpf), dv = new DataView(ab);
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * bpf, true); ws(8, 'WAVE'); ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, nc, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * bpf, true); dv.setUint16(32, bpf, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * bpf, true);
  let pk = 0; for (let i = 0; i < n; i++) for (const ch of chs) pk = Math.max(pk, Math.abs(ch[i]));
  const gn = ceiling != null && pk > ceiling ? ceiling / pk : 1;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) dv.setInt16(44 + i * bpf + c * 2, Math.max(-1, Math.min(1, chs[c][i] * gn)) * 32767, true);
  return { wav: ab, peak: pk };
}

export function toBase64(ab: ArrayBuffer): string {
  const u = new Uint8Array(ab); let bin = '';
  for (let i = 0; i < u.length; i += 32768) bin += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 32768)));
  return btoa(bin);
}

/** The clock and the live loop. While playing with sound, the audio clock drives scene time; otherwise
 * scene time is whatever the host last set. Scheduling runs on a timer, not on animation frames, so it
 * keeps going when the page is busy drawing. */
export class LiveAudio {
  ctx: AudioContext | null = null;
  sounder: Sounder | null = null;
  enabled = true;
  private acBase = 0; private tBase = 0; private schedTo = 0; private timer: ReturnType<typeof setInterval> | null = null;
  private shots = new Map<number, { s: Sounder; gate: GainNode }>();

  constructor(readonly source: SoundSource | null, readonly host: { playing(): boolean; time(): number; speed(): number },
              readonly opts: { lookahead?: number; tick?: number; cut?: Cut } = {}) {}

  /** Create the context (needs a user gesture in browsers). */
  async init(): Promise<void> {
    if (this.ctx || !this.source) return;
    try {
      const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
      this.ctx = new AC(); await this.source.load?.(this.ctx!);
      if (!this.opts.cut) this.sounder = this.source.create(this.ctx!, this.ctx!.destination);
    } catch { this.ctx = null; this.sounder = null; }
    if (!this.timer) this.timer = setInterval(() => this.pump(), this.opts.tick ?? 25);
  }
  get running(): boolean { return !!this.ctx && this.ctx.state === 'running'; }
  /** Scene time now: from the audio clock while playing, else the host's time. */
  now(): number { return this.host.playing() && this.running ? this.tBase + (this.ctx!.currentTime - this.acBase) * this.host.speed() : this.host.time(); }
  /** Re-anchor the clock at the host's current time (after a seek, pause or play). */
  sync(): void {
    if (this.ctx) {
      this.acBase = this.ctx.currentTime; this.tBase = this.host.time(); this.schedTo = this.host.time(); this.sounder?.silence?.();
      for (const { s, gate } of this.shots.values()) { s.silence?.(); gate.disconnect(); } this.shots.clear();
    }
    this.tBase = this.host.time();
  }
  private pump(): void {
    if (!this.host.playing() || !this.ctx || !this.enabled || this.ctx.state !== 'running') return;
    const speed = this.host.speed(), horizon = this.now() + (this.opts.lookahead ?? .15) * speed;
    if (horizon <= this.schedTo) return;
    const from = Math.max(this.schedTo, this.now());
    const acBase = this.acBase, tBase = this.tBase, out = (T: number) => acBase + (T - tBase) / speed;
    const cut = this.opts.cut;
    if (!cut) this.sounder?.schedule(from, horizon, out, speed);
    else cut.shots.forEach((sh, i) => {
      const a = Math.max(from, sh.T0), b = Math.min(horizon, sh.T1); if (a >= b) return;
      let entry = this.shots.get(i);
      if (!entry) { const gate = shotGate(this.ctx!, sh, out); gate.connect(this.ctx!.destination); entry = { s: this.source!.create(this.ctx!, gate), gate }; this.shots.set(i, entry); }
      entry.s.schedule(sh.src0 + (a - sh.T0) * sh.rate, sh.src0 + (b - sh.T0) * sh.rate, s => out(sh.T0 + (s - sh.src0) / sh.rate), speed * sh.rate);
    });
    this.schedTo = horizon;
  }
}
