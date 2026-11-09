/** "The Night Desk": a show with no end. Things happen somewhere else (a watched page changes, someone
 * sends a note), a signal arrives, and a card is posted on the desk. When nothing happens, the desk checks
 * the line. Everything here is connection: what can happen (ops), what a signal means (rules), and what it
 * sounds like. What it looks like is the style's (style.ts).
 *
 * This file runs in two places: in the control room (Node), where the director and stage write the log,
 * and in every renderer (a browser), where a follower replays it. The ops must be the same in both. */

import { World, clip, type Beat, type DirectorOptions, type EngineEvent, type Production, type Signal, type SoundSource, type Sounder } from '../../src/index.js';

export const STAGE = { w: 1280, h: 720 };

export interface Card { id: string; kind: 'lens' | 'note' | 'other'; title: string; lines: string[]; source: string; receipt: string; t0: number; in: number }
export interface DeskState {
  /** The newest few cards, oldest first. Older ones have left the desk (and the log). */
  cards: Card[];
  posted: number;
  /** Recent refusals: what was refused, why, and when. */
  refused: { title: string; reason: string; t0: number }[];
  /** The last time the desk checked the line. */
  pulse: { t0: number; dur: number; n: number } | null;
}
export const MAX_CARDS = 5;

export function makeWorld(): World<DeskState> {
  return new World<DeskState>({
    initial: () => ({ cards: [], posted: 0, refused: [], pulse: null }),
    root: { id: 'desk', parent: null, x: 0, y: 0, w: STAGE.w, h: STAGE.h, lw: STAGE.w, lh: STAGE.h },
    onDenied(S, e, reason) { S.refused.push({ title: clip(e.args?.title, 40), reason: reason || '', t0: e.t }); if (S.refused.length > 3) S.refused.shift(); },
    ops: {
      /** Post a card. Refused if it says nothing, or says it at too much length. */
      POST: {
        check(S, e) {
          const a = e.args || {};
          if (!String(a.title || '').trim()) return 'a card needs a headline';
          if (!Array.isArray(a.lines) || a.lines.length > 4 || a.lines.some((l: unknown) => String(l).length > 120)) return 'too much for one card';
          return S.cards.some(c => c.id === a.id) ? 'already on the desk' : null;
        },
        apply(S, e, p) {
          const a = e.args; S.posted++;
          S.cards.push({ id: a.id, kind: a.kind ?? 'other', title: a.title, lines: a.lines, source: a.source ?? '', receipt: a.receipt ?? '', t0: e.t, in: p });
          if (S.cards.length > MAX_CARDS) S.cards.shift();
        },
      },
      /** Check the line: the desk's way of saying it is still here. */
      PULSE: { apply(S, e) { S.pulse = { t0: e.t, dur: e.dur, n: e.args?.n ?? 0 }; } },
    },
  });
}

// ---------- what signals mean here ----------
// Signal data is evidence from outside (page text, a stranger's note). A rule copies out the few fields
// the desk draws, cut to size, and never does what the text says.

const post = (id: string, kind: Card['kind'], title: string, lines: string[], source: string, receipt: string): Beat =>
  ({ op: 'POST', actor: 'desk', dur: .9, args: { id, kind, title: clip(title, 64), lines: lines.map(l => clip(l, 96)).filter(Boolean).slice(0, 2), source: clip(source, 40), receipt: clip(receipt, 12) } });

export const RULES: DirectorOptions<DeskState>['rules'] = {
  /** A page watched by World Lens changed (world-lens.signal.v1). */
  'lens.change': (s: Signal) => {
    const d = s.data, added = (d.added || []).filter((x: any) => x.kind !== 'link' && x.kind !== 'control');
    const head = added.find((x: any) => x.kind === 'title' || x.kind === 'heading') ?? added[0];
    const title = head?.value || d.source?.title || `${d.summary?.added ?? 0} added, ${d.summary?.removed ?? 0} removed`;
    // a new heading usually shows up in the page text as well: say it once
    const said = new Set(added.filter((x: any) => x.kind === 'title' || x.kind === 'heading').map((x: any) => x.value).concat(title));
    const body = added.filter((x: any) => x.kind === 'text' && !said.has(x.value)).map((x: any) => x.value);
    return post(s.id, 'lens', title, body, d.source?.host || s.source || 'lens', String(d.source?.receiptId || s.id).slice(0, 8));
  },
  /** A note sent straight to the control room: { title, text }. */
  note: (s: Signal) => post(s.id, 'note', s.data.title, String(s.data.text ?? '').split('\n'), s.source || 'note', s.id.slice(0, 8)),
  '*': (s: Signal) => post(s.id, 'other', s.kind, [JSON.stringify(s.data ?? null)], s.source || 'signal', s.id.slice(0, 8)),
};

export const IDLE: DirectorOptions<DeskState>['idle'] = { after: 12, rule: ({ count }) => ({ op: 'PULSE', actor: 'desk', dur: 2.4, queue: false, args: { n: count } }) };

/** What the control room loads (tools/room.mjs). */
export function makeShow() { return { world: makeWorld(), rules: RULES, idle: IDLE, perMinute: 20 }; }

// ---------- sound: scheduled from the log, so it lands with the picture in every renderer ----------
export function sounds(W: World<DeskState>): SoundSource {
  return {
    create(ctx: BaseAudioContext, dest: AudioNode): Sounder {
      const bus = ctx.createGain(); bus.gain.value = .7; bus.connect(dest);
      let live: AudioScheduledSourceNode[] = [];
      const tone = (when: number, f: number, d: number, g: number, type: OscillatorType = 'sine') => {
        if (when < ctx.currentTime - .05) return;
        const o = ctx.createOscillator(), v = ctx.createGain(); o.type = type; o.frequency.value = f;
        v.gain.setValueAtTime(0, when); v.gain.linearRampToValueAtTime(g, when + .012); v.gain.exponentialRampToValueAtTime(.0005, when + d);
        o.connect(v); v.connect(bus); o.start(when); o.stop(when + d + .05); live.push(o); o.onended = () => { live = live.filter(x => x !== o); };
      };
      return {
        schedule(t0, t1, at) {
          for (const e of W.log.events as EngineEvent[]) {
            if (e.t < t0 || e.t >= t1) continue; const w = at(e.t);
            if (e.result === 'denied') { tone(w, 123, .3, .2, 'square'); tone(w + .11, 104, .34, .16, 'square'); }
            else if (e.op === 'POST') { tone(w + .1, 587.3, .5, .16); tone(w + .26, 880, .7, .13); tone(w + e.dur * .9, 1760, .09, .06, 'triangle'); }
            else if (e.op === 'PULSE') { tone(w, 196, 1.6, .07); tone(w + .5, 293.7, 1.4, .045); }
          }
        },
        silence() { for (const n of live.splice(0)) { try { n.stop(); } catch { /* already stopped */ } } },
      };
    },
  };
}

export function makeProduction(world = makeWorld(), duration = Infinity): Production<DeskState> {
  return { world, stage: STAGE, duration: () => duration, sound: sounds(world) };
}
