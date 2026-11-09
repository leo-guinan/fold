/** "Two Builders": one scene, written once, drawn by any style.
 *
 * Everything here is connection: what can happen (ops and the rule), when it happens (staged against the
 * dialogue), what the camera does, how a trailer cuts it, and what it sounds like. Nothing here says what
 * anything looks like; that's the styles' job (styles/geometric.ts, styles/terminal.ts). */

import { Cut, Envelopes, Stager, Timeline, Track, World, centreColumn, fullStage, hashStr, progress, quantizeEnvelope, rng,
  type EngineEvent, type FrameNode, type Production, type SoundSource, type Sounder } from '../../src/index.js';

export const STAGE = { w: 1280, h: 720 };

// ---------- state: what the world knows at a moment ----------
export type Kind = 'character' | 'machine' | 'core' | 'lamp';
export interface Thing { id: string; kind: Kind; name: string; frame: string; at: [number, number]; size: number; prog: number; lit: number | null; t0: number }
/** Frames in drawing order: parents first, then by stacking (z), then by when they were made. */
export const drawOrder = (tree: Record<string, FrameNode>) => Object.values(tree).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || (+(a.z ?? 0)) - (+(b.z ?? 0)));
export interface SceneState { frames: Record<string, { prog: number; t0: number }>; things: Record<string, Thing>; refusals: { e: EngineEvent; reason: string; t: number }[] }

// ---------- the world: ops and the rule ----------
export function makeWorld(): World<SceneState> {
  return new World<SceneState>({
    initial: () => ({ frames: {}, things: {}, refusals: [] }),
    root: { id: 'room', parent: null, x: 0, y: 0, w: STAGE.w, h: STAGE.h, lw: STAGE.w, lh: STAGE.h },
    // only someone in the room can act (the director sets the stage)
    rules: [(S, e) => (e.actor === 'director' || S.things[e.actor]?.prog === 1 ? undefined : `${e.actor} isn't here`)],
    onDenied: (S, e, reason, t) => { if (t < e.t + 1.8) S.refusals.push({ e, reason: reason || '', t: e.t }); },
    ops: {
      /** Open a frame: a space things can be put in. */
      OPEN: {
        layout: { pass: 0, apply(tree, e) { const a = e.args; tree[a.id] = { id: a.id, parent: e.frame, x: a.x, y: a.y, w: a.w, h: a.h, lw: a.lw ?? a.w, lh: a.lh ?? a.h, name: a.name, z: a.z ?? 0 } as FrameNode; } },
        apply(S, e, p) { S.frames[e.args.id] = { prog: p, t0: e.t }; },
      },
      /** Put a thing in a frame. Refused if the frame is closed. */
      PLACE: {
        check(S, e, ctx) { const f = ctx.frames[e.frame]; return !f ? 'there is no such place' : f.hidden ? 'that drawer is closed' : null; },
        apply(S, e, p) { const a = e.args; S.things[a.id] = { id: a.id, kind: a.kind, name: a.name, frame: e.frame, at: a.at, size: a.size ?? 1, prog: p, lit: null, t0: e.t }; },
      },
      /** Switch a thing on. */
      LIGHT: { check: (S, e) => (S.things[e.target!] ? null : 'nothing to switch on'), apply(S, e) { const o = S.things[e.target!]; if (o) o.lit = e.t; } },
      /** Slide a frame away (under something) and close it. */
      CLOSE: {
        layout: { pass: 1, apply(tree, e, t) { const f = tree[e.target!]; if (!f || e.t > t) return; const k = progress(t, e.t, e.dur); const q = k * k * (3 - 2 * k);
          f.x += e.args.dx * q; f.y += e.args.dy * q; f.h *= 1 - .9 * q; if (t >= e.t + e.dur) f.hidden = true; } },
      },
    },
  });
}

// ---------- dialogue: lines, with loudness envelopes made from the words ----------
export interface Line { t0: number; t1: number; who: string; text: string; env: string }
const SAY: [number, string, string][] = [
  [3.0, 'MAKER', 'Two builders. Two machines. Nobody has to know how they work.'],
  [11.2, 'GUEST', 'Can I try?'],
  [12.9, 'MAKER', 'That is the whole point.'],
];
/** A deterministic syllable envelope: words become bumps, gaps between words fall to silence. */
function envelopeOf(text: string, seed: number): { env: string; dur: number } {
  const R = rng(seed); const vals: number[] = []; const rate = 30;
  for (const w of text.split(/\s+/)) {
    const syl = Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) || []).length);
    for (let s = 0; s < syl; s++) { const n = 5 + Math.floor(R() * 3), peak = .7 + .3 * R(); for (let i = 0; i < n; i++) vals.push(peak * Math.sin(Math.PI * (i + .5) / n)); }
    vals.push(...Array(/[.,?!]$/.test(w) ? 6 : 2).fill(0));
  }
  return { env: quantizeEnvelope(vals), dur: vals.length / rate };
}
export const LINES: Line[] = SAY.map(([t0, who, text]) => { const { env, dur } = envelopeOf(text, hashStr(text)); return { t0, t1: +(t0 + dur).toFixed(3), who, text, env }; });

// ---------- staging: who does what, on cue ----------
export const SCENE_END = 16;
export function stage(W: World<SceneState>) {
  const dir = (t: number, ev: object) => W.emit({ actor: 'director', frame: 'room', dur: .7, ...ev, t } as any);
  dir(.2, { op: 'PLACE', target: 'maker', args: { id: 'maker', kind: 'character', name: 'Maker', at: [300, 470], size: 1 } });
  dir(.5, { op: 'PLACE', target: 'guest', args: { id: 'guest', kind: 'character', name: 'Guest', at: [1050, 480], size: .9 } });
  dir(.6, { op: 'PLACE', target: 'lamp', args: { id: 'lamp', kind: 'lamp', name: 'lamp', at: [640, 90], size: 1 } });
  const maker = new Stager(W, { defaults: { actor: 'maker' } as any, gap: .25 });
  maker.at(1.0, { op: 'OPEN', frame: 'room', dur: 1.1, target: 'bench', args: { id: 'bench', name: 'the bench', x: 470, y: 250, w: 380, h: 220, lw: 380, lh: 220 } });
  maker.at(2.2, { op: 'PLACE', frame: 'bench', dur: .8, target: 'mA', args: { id: 'mA', kind: 'machine', name: 'machine A', at: [100, 110] } });
  maker.at(3.1, { op: 'PLACE', frame: 'bench', dur: .8, target: 'mB', args: { id: 'mB', kind: 'machine', name: 'machine B', at: [280, 110] } });
  maker.at(5.4, { op: 'LIGHT', frame: 'bench', dur: .3, target: 'mA', args: {} });
  maker.at(6.0, { op: 'LIGHT', frame: 'bench', dur: .3, target: 'mB', args: {} });
  maker.at(7.6, { op: 'OPEN', frame: 'room', dur: .9, target: 'drawer', args: { id: 'drawer', name: 'the drawer', x: 520, y: 500, w: 280, h: 110, lw: 280, lh: 110, z: -1 } });
  maker.at(8.6, { op: 'PLACE', frame: 'drawer', dur: .7, target: 'coreA', args: { id: 'coreA', kind: 'core', name: 'how it works', at: [80, 55] } });
  maker.at(9.4, { op: 'CLOSE', frame: 'room', dur: 1.0, target: 'drawer', args: { dx: 0, dy: -150 } });
  maker.at(10.6, { op: 'PLACE', frame: 'drawer', dur: .7, target: 'coreB', args: { id: 'coreB', kind: 'core', name: 'one more part', at: [200, 55] } });
  maker.at(13.6, { op: 'LIGHT', frame: 'room', dur: .3, target: 'guest', args: {} });
  return { slips: maker.slips };
}

// ---------- camera, captions, cut, layouts ----------
export const CAMERA = new Track([], { fallback: [1, 640, 360] })
  .hold(0, 1.6, [1, 640, 360]).hold(2.6, 7.2, [1.55, 660, 360]).hold(8.0, 11.35, [1.5, 660, 450])
  .hold(11.95, 12.6, [1.9, 1000, 420]).hold(13.3, 14.6, [1.25, 760, 380]).hold(15.2, 16, [1, 640, 360]).sort();

export const CAPTIONS = new Timeline(LINES);
export const ENVELOPES = new Envelopes(LINES);
export const LAYOUTS = [fullStage('16x9', STAGE, { w: 1920, h: 1080 }), centreColumn('9x16', STAGE, 9 / 16, { w: 1080, h: 1920 })];

/** A 6-second teaser cut from the same scene: the guest's question, the machines waking, the answer. */
export const TEASER = new Cut({ shots: [
  { T0: 0, T1: 1.5, src0: 11.05, rate: 1, cams: { '16x9': [2.2, 1050, 420], '9x16': [1.9, 1050, 430] } },
  { T0: 1.5, T1: 3.2, src0: 5.2, rate: 1, cams: { '16x9': [1.7, 660, 360], '9x16': [1.5, 660, 360] } },
  { T0: 3.2, T1: 5.4, src0: 12.75, rate: 1, cams: { '16x9': [2.1, 300, 420], '9x16': [1.8, 300, 430] } },
  { T0: 5.4, T1: 6.4, src0: 15.0, rate: 1, cams: { '16x9': [1, 640, 360], '9x16': [1, 640, 360] } },
] });

// ---------- sound: synthesized, scheduled by the engine ----------
const PITCH: Record<string, number> = { MAKER: 118, GUEST: 205 };
function sounds(W: World<SceneState>): SoundSource {
  return {
    create(ctx: BaseAudioContext, dest: AudioNode): Sounder {
      const bus = ctx.createGain(); bus.gain.value = .8; bus.connect(dest);
      let live: AudioScheduledSourceNode[] = []; const done = new Set<string>();
      const track = (n: AudioScheduledSourceNode) => { live.push(n); n.onended = () => { live = live.filter(x => x !== n); }; };
      const tone = (when: number, f: number, d: number, g: number, type: OscillatorType = 'sine') => {
        const o = ctx.createOscillator(), v = ctx.createGain(); o.type = type; o.frequency.value = f;
        v.gain.setValueAtTime(0, when); v.gain.linearRampToValueAtTime(g, when + .01); v.gain.exponentialRampToValueAtTime(.0005, when + d);
        o.connect(v); v.connect(bus); o.start(when); o.stop(when + d + .05); track(o);
      };
      const voice = (L: Line, from: number, at: (s: number) => number, rate: number) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = PITCH[L.who] ?? 150;
        const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 6; const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 8;
        const g = ctx.createGain(); g.gain.value = 0; const mix = ctx.createGain(); mix.gain.value = .9;
        o.connect(f1); o.connect(f2); f1.connect(mix); f2.connect(mix); mix.connect(g); g.connect(bus);
        const R = rng(hashStr(L.text));
        for (let i = 0; i < L.env.length; i++) {
          const s = L.t0 + i / 30; if (s < from) continue; const w = at(s), lv = +L.env[i] / 9;
          g.gain.linearRampToValueAtTime(.5 * lv, w);
          if (i % 5 === 0) { f1.frequency.linearRampToValueAtTime(500 + 500 * R(), w); f2.frequency.linearRampToValueAtTime(1100 + 900 * R(), w); o.frequency.linearRampToValueAtTime((PITCH[L.who] ?? 150) * (1 + .06 * Math.sin(i / 4)), w); }
        }
        const start = at(Math.max(from, L.t0)), end = at(L.t1) + .05;
        g.gain.setValueAtTime(0, Math.max(0, start - .001)); o.start(start); o.stop(end); track(o);
      };
      return {
        schedule(t0, t1, at, rate) {
          for (const L of LINES) if (!done.has(L.text) && L.t0 < t1 && L.t1 > t0) { done.add(L.text); voice(L, Math.max(t0, L.t0), at, rate); }
          for (const e of W.log.events) {
            if (e.t < t0 || e.t >= t1) continue; const w = at(e.t);
            if (e.result === 'denied') { tone(w, 110, .35, .25, 'square'); tone(w + .12, 98, .35, .2, 'square'); continue; }
            if (e.op === 'OPEN') tone(w, 660, .5, .18), tone(w + .08, 990, .45, .1);
            if (e.op === 'PLACE' && e.actor !== 'director') tone(w + e.dur * .8, 1320, .12, .2, 'triangle');
            if (e.op === 'LIGHT') tone(w, 880, .9, .16), tone(w, 1318.5, .9, .08);
            if (e.op === 'CLOSE') tone(w + e.dur * .9, 80, .4, .4, 'triangle');
          }
        },
        silence() { for (const n of live.splice(0)) { try { n.stop(); } catch { /* already stopped */ } } done.clear(); },
      };
    },
  };
}

// ---------- the production ----------
export function makeProduction(opts: { cut?: boolean } = {}): Production<SceneState> & { slips: unknown[] } {
  const world = makeWorld(); const { slips } = stage(world);
  const cut = opts.cut ? TEASER : undefined;
  return { world, stage: STAGE, duration: () => (cut ? cut.end : SCENE_END), camera: CAMERA, captions: CAPTIONS, envelopes: ENVELOPES, cut,
    sound: sounds(world), layouts: LAYOUTS, slips };
}
