/** The browser host: a player that keeps time, renders on demand, plays sound in sync, and exposes the hooks
 * the export tools use. A page needs a canvas, a production and a style; everything else is optional. */

import type { Production, Style, Surface, View } from './render.js';
import { renderFrame } from './render.js';
import type { Layout } from './cut.js';
import { LiveAudio, encodeWav, renderOffline, toBase64 } from './sound.js';

/** The contract between a page and the export tools (tools/export.mjs, tools/stills.mjs). */
export interface EngineHooks {
  ready: boolean;
  /** Output length in seconds. */
  duration(): number;
  /** Draw output time T, synchronously. */
  seek(T: number): void;
  /** Output shapes this page can render (crop region of the stage, output size). */
  layouts(): Layout[];
  setLayout(name: string): void;
  /** The stage size in units and the canvas scale (device pixels per unit). */
  surface(): { w: number; h: number; scale: number };
  renderAudio?(sampleRate?: number): Promise<{ b64: string; peak: number; dur: number }>;
  /** The log, plain and rounded. */
  dump(): object[];
  [extra: string]: unknown;
}

export function exposeHooks(hooks: EngineHooks, name = '__fold'): EngineHooks {
  (globalThis as any)[name] = hooks; return hooks;
}

export interface PlayerOptions<S> {
  canvas: HTMLCanvasElement;
  production: Production<S, any>;
  style: Style<S, any>;
  /** Device pixels per stage unit. Default: devicePixelRatio. */
  scale?: number;
  /** Called after each drawn frame (update a scrubber, captions in HTML…). */
  onFrame?(view: View<S>): void;
}

export class Player<S> {
  T = 0; playing = false; speed = 1; layout: Layout | undefined;
  readonly surface: Surface; readonly audio: LiveAudio;
  private dirty = true; private last = 0; private raf = 0;
  readonly scale: number;

  constructor(readonly opts: PlayerOptions<S>) {
    const p = opts.production;
    this.scale = opts.scale ?? (globalThis.devicePixelRatio || 1);
    opts.canvas.width = Math.round(p.stage.w * this.scale); opts.canvas.height = Math.round(p.stage.h * this.scale);
    this.surface = opts.canvas.getContext('2d')!;
    this.layout = p.layouts?.[0];
    this.audio = new LiveAudio(p.sound ?? null, { playing: () => this.playing, time: () => this.T, speed: () => this.speed }, { cut: p.cut });
  }
  get production(): Production<S, any> { return this.opts.production; }
  async setup(): Promise<void> { await this.opts.style.setup?.(this.surface, this.production); }
  /** Draw output time T now. */
  draw(T = this.T): View<S> {
    const v = renderFrame(this.surface, this.production, this.opts.style, T, { layout: this.layout, scale: this.scale });
    this.opts.onFrame?.(v); return v;
  }
  seek(T: number): void { this.T = Math.max(0, Math.min(this.production.duration(), T)); this.audio.sync(); this.dirty = true; }
  async play(): Promise<void> { await this.audio.init(); await this.audio.ctx?.resume(); if (this.T >= this.production.duration()) this.T = 0; this.playing = true; this.audio.sync(); this.dirty = true; }
  pause(): void { this.playing = false; this.audio.sync(); this.dirty = true; }
  invalidate(): void { this.dirty = true; }
  /** Start the animation-frame loop. */
  start(): void {
    const frame = (now: number) => {
      const dt = Math.min(.1, (now - this.last) / 1000 || 0); this.last = now;
      if (this.playing) {
        this.T = this.audio.running ? this.audio.now() : this.T + dt * this.speed;
        if (this.T >= this.production.duration()) { this.T = this.production.duration(); this.pause(); }
        this.dirty = true;
      }
      if (this.dirty) { this.draw(this.T); this.dirty = false; }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
  stop(): void { cancelAnimationFrame(this.raf); }
  /** The export hooks for this player. */
  hooks(extra: Record<string, unknown> = {}): EngineHooks {
    const p = this.production;
    return {
      ready: true,
      duration: () => p.duration(),
      seek: (T: number) => { this.T = T; this.draw(T); },
      layouts: () => p.layouts || [],
      setLayout: (name: string) => { this.layout = p.layouts?.find(l => l.name === name) ?? this.layout; this.dirty = true; },
      surface: () => ({ w: p.stage.w, h: p.stage.h, scale: this.scale }),
      renderAudio: p.sound ? async (sr = 48000) => {
        const dur = p.duration() + .5; const buf = await renderOffline(p.sound!, dur, sr, 2, p.cut);
        const { wav, peak } = encodeWav(buf); return { b64: toBase64(wav), peak, dur };
      } : undefined,
      dump: () => p.world.log.dump(),
      ...extra,
    };
  }
}
