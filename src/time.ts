/** Time structures that sit beside the log: keyframe tracks (cameras, or anything numeric), timelines of
 * clips (captions, lines of dialogue, cues), loudness envelopes that drive mouths and meters, and the
 * stager that places actions against a timeline. */

import { clamp, ease as quadEase, lerp } from './math.js';
import type { EngineEvent, EventInput } from './log.js';
import type { World, EmitOptions } from './world.js';

// ---------- keyframe tracks ----------

/** A keyframe: [time, ...values]. */
export type Key = number[];

export class Track {
  keys: Key[];
  constructor(keys: Key[] = [], readonly opts: { fallback?: number[]; ease?: (k: number) => number } = {}) { this.keys = keys; }
  add(...keys: Key[]): this { this.keys.push(...keys); return this; }
  /** Hold `values` from t0 to t1. */
  hold(t0: number, t1: number, values: number[]): this { this.keys.push([t0, ...values], [t1, ...values]); return this; }
  sort(): this { this.keys.sort((a, b) => a[0] - b[0]); return this; }
  clear(): this { this.keys.length = 0; return this; }
  /** Values at time t: eased between surrounding keys, held before the first and after the last. */
  at(t: number): number[] {
    const K = this.keys, ease = this.opts.ease ?? quadEase;
    if (!K.length) return (this.opts.fallback ?? []).slice();
    if (t <= K[0][0]) return K[0].slice(1);
    for (let i = 1; i < K.length; i++) if (t <= K[i][0]) {
      const a = K[i - 1], b = K[i], k = ease(clamp((t - a[0]) / Math.max(1e-6, b[0] - a[0])));
      return a.slice(1).map((v, j) => lerp(v, b[j + 1], k));
    }
    return K[K.length - 1].slice(1);
  }
}

/** A camera value [zoom, cx, cy] as a canvas transform: world point (cx, cy) at the centre of a stage of
 * size w × h, magnified by zoom, on a surface drawn at `scale` device pixels per stage unit. */
export function cameraMatrix(cam: number[], stage: { w: number; h: number }, scale = 1): [number, number, number, number, number, number] {
  const [z, cx, cy] = cam;
  return [scale * z, 0, 0, scale * z, scale * (stage.w / 2 - cx * z), scale * (stage.h / 2 - cy * z)];
}

// ---------- timelines ----------

export interface Span { t0: number; t1: number }

/** A list of timed items (captions, lines, cues). Items can be any shape: give accessors for their times. */
export class Timeline<T> {
  constructor(readonly items: T[] = [], readonly time: { t0(x: T): number; t1(x: T): number } = { t0: (x: any) => x.t0, t1: (x: any) => x.t1 }) {}
  /** The first item playing at t. `tail` trims each item's end (so a speaker isn't "still talking" during the last syllable's decay). */
  at(t: number, tail = 0): T | undefined { return this.items.find(x => t >= this.time.t0(x) && t < this.time.t1(x) - tail); }
  all(t: number, tail = 0): T[] { return this.items.filter(x => t >= this.time.t0(x) && t < this.time.t1(x) - tail); }
  get end(): number { return this.items.reduce((m, x) => Math.max(m, this.time.t1(x)), 0); }
}

// ---------- envelopes: loudness over time, per speaker ----------

export interface EnvelopeLine extends Span {
  who: string;
  /** Loudness samples at `rate` per second: a string of digits 0–9 (compact, as written by a mixer) or numbers 0–1. */
  env?: string | number[];
}

/** Turns per-line loudness envelopes into a signal per speaker: level(who, t) in 0..1, linearly interpolated.
 * This is what drives mouths, meters and speaker glows, so they open on syllables rather than on a loop. */
export class Envelopes {
  /** lines must be sorted by t0. */
  constructor(readonly lines: EnvelopeLine[], readonly rate = 30, readonly steps = 9) {}
  level(who: string, t: number): number {
    for (const r of this.lines) {
      if (t < r.t0) break;
      if (t >= r.t1 || r.who !== who) continue;
      const env = r.env; if (!env) return 0;
      const x = (t - r.t0) * this.rate, i = Math.floor(x), f = x - i;
      if (typeof env === 'string') { const a = +(env[i] || 0), b = +(env[i + 1] || 0); return (a + (b - a) * f) / this.steps; }
      const a = env[i] ?? 0, b = env[i + 1] ?? 0; return a + (b - a) * f;
    }
    return 0;
  }
  /** Is `who` speaking at t (inside one of their lines)? */
  active(who: string, t: number): boolean { return this.lines.some(r => r.who === who && t >= r.t0 && t < r.t1); }
  speaker(t: number): string | undefined { return this.lines.find(r => t >= r.t0 && t < r.t1)?.who; }
}

/** Quantize a loudness series (any scale) to the compact digit form, relative to its own 95th percentile. */
export function quantizeEnvelope(values: number[], steps = 9, curve = .8): string {
  const sorted = [...values].sort((a, b) => a - b);
  const ref = sorted[Math.floor(.95 * (sorted.length - 1))] || 1;
  return values.map(v => String(Math.min(steps, Math.round(steps * Math.pow(Math.min(1, v / ref), curve))))).join('');
}

// ---------- the stager: actions against a timeline ----------

export interface StagerOptions<E> {
  /** Fields every staged event gets (actor, provenance…). */
  defaults?: Partial<E>;
  /** Minimum gap between one action's end and the next one's start. */
  gap?: number;
  /** A beat that lands more than this late is recorded as a slip. */
  tolerance?: number;
  emit?: EmitOptions;
  /** Called after each emit (for hosts that refresh derived globals). */
  after?(e: E): void;
}

/** Places one actor's actions on cue, one at a time: each starts at its cue or right after the previous one
 * ends (plus a gap), whichever is later. Beats pushed far past their cue are recorded in `slips`, so a scene
 * can fail its tests when the staging no longer fits the soundtrack. */
export class Stager<S, E extends EngineEvent = EngineEvent> {
  last = -1;
  readonly slips: [string | undefined, number, number][] = [];
  constructor(readonly world: World<S, E>, readonly opts: StagerOptions<E> = {}) {}
  at(cue: number, ev: Omit<EventInput, 't'> & Partial<E>): E {
    const gap = this.opts.gap ?? .45, tol = this.opts.tolerance ?? 1.5;
    const s = Math.max(cue, this.last + gap);
    if (s > cue + tol) this.slips.push([ev.target, +cue.toFixed(2), +s.toFixed(2)]);
    const e = this.world.emit({ ...(this.opts.defaults as object), ...ev, t: s } as EventInput, this.opts.emit);
    this.opts.after?.(e);
    this.last = e.t + e.dur;
    return e;
  }
}
