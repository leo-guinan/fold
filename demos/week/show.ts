/** "The Week": last week, read back by three roles, and the week ahead put on the record.
 *
 *   Borges remembers   what happened, from the receipts
 *   Leonardo creates   what was made, and what is promised next
 *   Agnolo keeps score the numbers, the trends, what failed, and whether last week's promises were kept
 *
 * An edition is a plan: receipts (dated, hashed quotes from the newsletter, the channel and the archive),
 * segments of lines that cite them, and promises for the week ahead. The plan becomes events on a fixed
 * timeline, the same events whether they are staged live by a control room or laid out as a finished scene
 * for export. The world holds the show to its own rule: a line that cites a receipt nobody filed is refused,
 * on air, with the reason.
 *
 * Runs in the control room (Node) and in every renderer (a browser). Nothing here says what it looks like. */

import { Cut, World, centreColumn, clip, fullStage, hashStr, rng,
  type Beat, type DirectorOptions, type EngineEvent, type Production, type Signal, type SoundSource, type Sounder } from '../../src/index.js';

export const STAGE = { w: 1280, h: 720 };
export const LAYOUTS = [fullStage('16x9', STAGE, { w: 1920, h: 1080 }), centreColumn('9x16', STAGE, 9 / 16, { w: 1080, h: 1920 })];

// ---------- the plan: one edition, as data ----------
export type Who = 'borges' | 'leonardo' | 'agnolo';
export const CAST: Record<Who, { name: string; role: string }> = {
  borges: { name: 'Borges', role: 'remembers' },
  leonardo: { name: 'Leonardo', role: 'creates' },
  agnolo: { name: 'Agnolo', role: 'keeps score' },
};
export interface Receipt {
  id: string;
  kind: 'tweet' | 'newsletter' | 'video';
  /** YYYY-MM-DD */
  date: string;
  url: string;
  author: string;
  /** The exact words (a post's text, an issue's title and opening, a video's title). */
  quote: string;
  /** SHA-256 over kind|date|url|quote (the Receipt Cuts format). */
  sha256: string;
  likes?: number; retweets?: number; views?: number;
}
export type Exhibit =
  | { receipt: string }
  | { chart: { title: string; unit?: string; bars: { label: string; value: number; mark?: boolean }[]; note?: string } }
  | { stats: { title?: string; items: { label: string; value: string }[] } }
  | { ledger: true };
export interface Line {
  who: Who;
  say: string;
  /** The receipt this line rests on. */
  cite?: string;
  show?: Exhibit;
  /** Put this on the record for next week (Leonardo), or rule on one from last week (Agnolo). */
  promise?: { id: string; text: string; due: string; cite: string };
  verdict?: { promise: string; result: 'kept' | 'missed' | 'open'; cite?: string };
}
export type SegmentKind = 'open' | 'recap' | 'numbers' | 'highlight' | 'trend' | 'failure' | 'ledger' | 'ahead' | 'close';
export interface Segment { id: string; kind: SegmentKind; title: string; lines: Line[] }
export interface Plan {
  schema: 'fold.week.v1';
  title: string;
  week: { from: string; to: string; label: string };
  /** What each source gave this week, or why it gave nothing. Shown at the top, so a gap is on the record. */
  sources: { name: string; status: 'ok' | 'missing' | 'partial'; note: string }[];
  receipts: Receipt[];
  /** Promises made in the previous edition, to be ruled on in this one. */
  carried: { id: string; text: string; due: string; cite: string }[];
  segments: Segment[];
}

// ---------- state ----------
export interface Promise_ { id: string; text: string; due: string; cite: string; carried: boolean; t0: number; verdict: null | { result: 'kept' | 'missed' | 'open'; t0: number } }
export interface WeekState {
  edition: { title: string; week: Plan['week']; sources: Plan['sources']; t0: number; segments: number; closed: number | null } | null;
  filed: Record<string, Receipt>;
  segment: { id: string; kind: SegmentKind; title: string; index: number; t0: number } | null;
  line: { who: Who; text: string; cite: string | null; t0: number; dur: number } | null;
  exhibit: { show: Exhibit; t0: number } | null;
  ledger: Promise_[];
  refused: { who: string; what: string; reason: string; t0: number }[];
}
const blank = (): WeekState => ({ edition: null, filed: {}, segment: null, line: null, exhibit: null, ledger: [], refused: [] });

// ---------- the world: ops and the rule ----------
export function makeWorld(): World<WeekState> {
  return new World<WeekState>({
    initial: blank,
    root: { id: 'studio', parent: null, x: 0, y: 0, w: STAGE.w, h: STAGE.h, lw: STAGE.w, lh: STAGE.h },
    rules: [(S, e) => (e.actor === 'director' || e.actor === 'board' || e.actor in CAST ? undefined : `${e.actor} is not in this show`)],
    onDenied(S, e, reason) { S.refused.push({ who: e.actor, what: clip(e.args?.text ?? e.args?.id ?? e.op, 60), reason: reason || '', t0: e.t }); if (S.refused.length > 3) S.refused.shift(); },
    ops: {
      /** A new edition. Clears the desk: last edition's receipts and lines are gone; open promises are carried by the plan. */
      OPEN: { apply(S, e) { const a = e.args; Object.assign(S, blank(), { refused: S.refused, edition: { title: a.title, week: a.week, sources: a.sources, t0: e.t, segments: a.segments, closed: null } }); } },
      /** Put a receipt on file. Only then can anyone cite it. */
      FILE: {
        check: (S, e) => (!S.edition ? 'no edition is open' : !e.args?.id || !e.args?.quote || !e.args?.url ? 'that is not a receipt' : null),
        apply(S, e) { S.filed[e.args.id] = e.args; },
      },
      SEGMENT: { check: S => (S.edition ? null : 'no edition is open'), apply(S, e) { const a = e.args; S.segment = { id: a.id, kind: a.kind, title: a.title, index: a.index, t0: e.t }; S.exhibit = null; } },
      /** Speak a line. A line that cites a receipt must cite one that is on file. */
      SAY: {
        check(S, e) {
          const a = e.args || {};
          if (!S.edition) return 'no edition is open';
          if (!String(a.text || '').trim()) return 'nothing to say';
          if (String(a.text).length > 240) return 'too long for one breath';
          return a.cite && !S.filed[a.cite] ? 'no receipt on file for that' : null;
        },
        apply(S, e) { S.line = { who: e.actor as Who, text: e.args.text, cite: e.args.cite ?? null, t0: e.t, dur: e.dur }; },
      },
      /** Put something on the board: a receipt, a chart, a row of numbers, the ledger. */
      SHOW: {
        check: (S, e) => { const x = e.args?.show; return !x ? 'nothing to show' : 'receipt' in x && !S.filed[x.receipt] ? 'no receipt on file for that' : null; },
        apply(S, e) { S.exhibit = { show: e.args.show, t0: e.t }; },
      },
      /** Put a promise on the record. It needs the words it was made in. */
      PROMISE: {
        check: (S, e) => { const a = e.args || {}; return !a.id || !a.text ? 'that is not a promise' : !S.filed[a.cite] ? 'a promise needs the words it was made in' : S.ledger.some(p => p.id === a.id) ? 'already on the record' : null; },
        apply(S, e) { const a = e.args; S.ledger.push({ id: a.id, text: a.text, due: a.due, cite: a.cite, carried: !!a.carried, t0: e.t, verdict: null }); },
      },
      /** Rule on a promise. Only the one who keeps score does that. */
      VERDICT: {
        check: (S, e) => (e.actor !== 'agnolo' ? 'only the one who keeps score gives verdicts' : !S.ledger.some(p => p.id === e.args?.promise) ? 'no such promise on the record' : null),
        apply(S, e) { const p = S.ledger.find(x => x.id === e.args.promise); if (p) p.verdict = { result: e.args.result, t0: e.t }; },
      },
      CLOSE: { apply(S, e) { if (S.edition) S.edition.closed = e.t; S.line = null; S.exhibit = { show: { ledger: true }, t0: e.t }; } },
    },
  });
}

// ---------- the plan as events on a timeline ----------

/** How long a line takes to say, in seconds. */
export const speak = (text: string): number => +Math.max(1.8, text.trim().split(/\s+/).length / 2.7 + .6).toFixed(2);

export interface Timed { after: number; op: string; actor: string; dur: number; args: any }
export interface Timeline_ { beats: Timed[]; duration: number; segments: { id: string; kind: SegmentKind; title: string; t0: number; t1: number }[] }

/** Lay a plan out in time. Pure: the same plan always gives the same events at the same offsets, which is
 * why a live airing and a later export of the same edition are the same show. */
export function planBeats(plan: Plan): Timeline_ {
  const beats: Timed[] = [], segments: Timeline_['segments'] = []; let t = 0;
  const at = (after: number, op: string, actor: string, dur: number, args: any) => beats.push({ after: +after.toFixed(2), op, actor, dur, args });
  at(t, 'OPEN', 'director', 1.6, { title: plan.title, week: plan.week, sources: plan.sources, segments: plan.segments.length });
  for (const r of plan.receipts) at(.1, 'FILE', 'director', 0, r);
  for (const c of plan.carried) at(.2, 'PROMISE', 'director', 0, { ...c, carried: true });
  t = 2.2;
  plan.segments.forEach((seg, index) => {
    const t0 = t;
    at(t, 'SEGMENT', 'director', 1.2, { id: seg.id, kind: seg.kind, title: seg.title, index }); t += 1.5;
    for (const line of seg.lines) {
      if (line.show) at(t, 'SHOW', 'board', .7, { show: line.show });
      const dur = speak(line.say);
      at(t + (line.show ? .35 : 0), 'SAY', line.who, dur, { text: line.say, cite: line.cite });
      // these land in the middle of the line that makes them; they take no time of their own
      if (line.promise) at(t + dur * .6, 'PROMISE', line.who, 0, line.promise);
      if (line.verdict) at(t + dur * .6, 'VERDICT', line.who, 0, line.verdict);
      t += (line.show ? .35 : 0) + dur + .45;
    }
    t += .4; segments.push({ id: seg.id, kind: seg.kind, title: seg.title, t0, t1: t });
  });
  at(t, 'CLOSE', 'director', 2, {});
  return { beats, duration: +(t + 6).toFixed(2), segments };
}

/** Problems with a plan that the world would refuse on air, found before it airs. Empty means clean. */
export function auditPlan(plan: Plan): string[] {
  const out: string[] = [], ids = new Set(plan.receipts.map(r => r.id)), promised = new Set(plan.carried.map(c => c.id));
  if (plan.schema !== 'fold.week.v1') out.push('schema must be fold.week.v1');
  if (ids.size !== plan.receipts.length) out.push('two receipts share an id');
  for (const c of plan.carried) if (!ids.has(c.cite)) out.push(`carried promise ${c.id} cites ${c.cite}, which is not filed`);
  const factual: SegmentKind[] = ['recap', 'numbers', 'highlight', 'trend', 'failure', 'ledger'];
  for (const seg of plan.segments) seg.lines.forEach((l, i) => {
    const where = `${seg.id} line ${i + 1}`;
    if (!(l.who in CAST)) out.push(`${where}: ${l.who} is not in the cast`);
    if (!l.say?.trim()) out.push(`${where}: empty line`); else if (l.say.length > 240) out.push(`${where}: ${l.say.length} characters, over 240`);
    if (l.cite && !ids.has(l.cite)) out.push(`${where}: cites ${l.cite}, which is not filed`);
    if (l.show && 'receipt' in l.show && !ids.has(l.show.receipt)) out.push(`${where}: shows ${l.show.receipt}, which is not filed`);
    if (factual.includes(seg.kind) && !l.cite && !(l.show && ('chart' in l.show || 'stats' in l.show || 'ledger' in l.show)) && !l.verdict) out.push(`${where}: a ${seg.kind} line with nothing behind it (no receipt, no numbers)`);
    if (l.promise) { if (!ids.has(l.promise.cite)) out.push(`${where}: promise ${l.promise.id} cites ${l.promise.cite}, which is not filed`); if (promised.has(l.promise.id)) out.push(`${where}: promise ${l.promise.id} is already on the record`); promised.add(l.promise.id); }
    if (l.verdict) { if (l.who !== 'agnolo') out.push(`${where}: only Agnolo gives verdicts`); if (!promised.has(l.verdict.promise)) out.push(`${where}: verdict on ${l.verdict.promise}, which was never promised`); }
  });
  for (const c of plan.carried) if (!plan.segments.some(s => s.lines.some(l => l.verdict?.promise === c.id))) out.push(`carried promise ${c.id} gets no verdict`);
  if (!plan.segments.some(s => s.kind === 'ahead')) out.push('no week-ahead segment');
  return out;
}

/** The promises this edition leaves open, for the next edition to carry. */
export const openPromises = (plan: Plan): Plan['carried'] => plan.segments.flatMap(s => s.lines).flatMap(l => (l.promise ? [l.promise] : []));

// ---------- live: an edition arrives at the control room as one signal ----------
export const RULES: DirectorOptions<WeekState>['rules'] = {
  /** { id, kind: 'week.edition', data: Plan }. Sent by tools/week.mjs air, from a local client only. */
  'week.edition': (s: Signal<Plan>): Beat[] => {
    const problems = auditPlan(s.data); if (problems.length) throw new Error(`plan refused: ${problems[0]} (${problems.length} problems)`);
    return planBeats(s.data).beats.map(b => ({ op: b.op, actor: b.actor, dur: b.dur, args: b.args, after: b.after, queue: false }));
  },
};
export function makeShow() { return { world: makeWorld(), rules: RULES, perMinute: 4 }; }

// ---------- sound: each voice is a tone that opens and closes on the syllables of its line ----------
/** Loudness 0..1 of a line, s seconds in. A function of the words, so mouths, meters and sound agree everywhere. */
export function voiceLevel(text: string, s: number, dur: number): number {
  if (s < 0 || s > dur) return 0;
  const words = text.trim().split(/\s+/), k = Math.min(words.length - 1, Math.floor((s / dur) * words.length)), w = words[k];
  const within = (s / dur) * words.length - k, syl = Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) || []).length);
  const R = rng(hashStr(w) + k), peak = .65 + .35 * R(), pause = /[.,;:?!]$/.test(w) ? .72 : .9;
  return within > pause ? 0 : peak * Math.abs(Math.sin(Math.PI * syl * within / pause));
}
const PITCH: Record<string, number> = { borges: 104, leonardo: 138, agnolo: 176 };
export function sounds(W: World<WeekState>): SoundSource {
  return {
    create(ctx: BaseAudioContext, dest: AudioNode): Sounder {
      const bus = ctx.createGain(); bus.gain.value = .55; bus.connect(dest);
      let live: AudioScheduledSourceNode[] = []; const started = new Set<string>();
      const keep = (n: AudioScheduledSourceNode) => { live.push(n); n.onended = () => { live = live.filter(x => x !== n); }; };
      const tone = (when: number, f: number, d: number, g: number, type: OscillatorType = 'sine') => {
        if (when < ctx.currentTime - .05) return;
        const o = ctx.createOscillator(), v = ctx.createGain(); o.type = type; o.frequency.value = f;
        v.gain.setValueAtTime(0, when); v.gain.linearRampToValueAtTime(g, when + .012); v.gain.exponentialRampToValueAtTime(.0005, when + d);
        o.connect(v); v.connect(bus); o.start(when); o.stop(when + d + .05); keep(o);
      };
      const voice = (e: EngineEvent, from: number, at: (s: number) => number) => {
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), base = PITCH[e.actor] ?? 140;
        o.type = 'triangle'; o.frequency.value = base; f.type = 'bandpass'; f.Q.value = 3; f.frequency.value = base * 5; g.gain.value = 0;
        o.connect(f); f.connect(g); g.connect(bus);
        for (let s = Math.max(0, from - e.t); s <= e.dur; s += 1 / 30) {
          const w = at(e.t + s); g.gain.linearRampToValueAtTime(.34 * voiceLevel(e.args.text, s, e.dur), w);
          if (Math.round(s * 30) % 6 === 0) o.frequency.linearRampToValueAtTime(base * (1 + .07 * Math.sin(s * 2.3 + hashStr(e.id))), w);
        }
        const a = at(Math.max(from, e.t)), b = at(e.t + e.dur) + .05; g.gain.setValueAtTime(0, Math.max(0, a - .001)); g.gain.linearRampToValueAtTime(0, b);
        o.start(a); o.stop(b + .02); keep(o);
      };
      return {
        schedule(t0, t1, at) {
          for (const e of W.log.events as EngineEvent[]) {
            if (e.op === 'SAY' && e.result !== 'denied' && e.t < t1 && e.t + e.dur > t0 && !started.has(e.id)) { started.add(e.id); voice(e, Math.max(t0, e.t), at); }
            if (e.t < t0 || e.t >= t1) continue; const w = at(e.t);
            if (e.result === 'denied') { tone(w, 123, .3, .2, 'square'); tone(w + .11, 104, .34, .16, 'square'); }
            else if (e.op === 'OPEN') { tone(w, 196, 1.8, .12); tone(w + .25, 293.7, 1.6, .1); tone(w + .5, 392, 1.6, .09); }
            else if (e.op === 'SEGMENT') { tone(w, 392, .5, .1); tone(w + .12, 587.3, .6, .08); }
            else if (e.op === 'SHOW') tone(w + .1, 1320, .08, .05, 'triangle');
            else if (e.op === 'PROMISE' && !e.args?.carried) { tone(w, 523.3, .5, .1); tone(w + .16, 784, .7, .09); }
            else if (e.op === 'VERDICT') tone(w, e.args.result === 'kept' ? 784 : e.args.result === 'missed' ? 155.6 : 392, .6, .12, e.args.result === 'missed' ? 'square' : 'sine');
            else if (e.op === 'CLOSE') { tone(w, 392, 1.6, .1); tone(w + .3, 293.7, 1.6, .09); tone(w + .6, 196, 2.2, .1); }
          }
          for (const id of started) if (!W.log.find(id)) started.delete(id);   // folded into the checkpoint: forget it
        },
        silence() { for (const n of live.splice(0)) { try { n.stop(); } catch { /* already stopped */ } } started.clear(); },
      };
    },
  };
}

// ---------- productions ----------
/** Live: a world a follower fills from the feed. */
export function makeProduction(world = makeWorld()): Production<WeekState> { return { world, stage: STAGE, duration: () => Infinity, sound: sounds(world), layouts: LAYOUTS }; }

/** Finished: one edition laid out from its plan, for scrubbing and export. `only` cuts it to one segment. */
export function makeEdition(plan: Plan, only?: string): Production<WeekState> & { timeline: Timeline_ } {
  const world = makeWorld(), timeline = planBeats(plan), T0 = .4;
  for (const b of timeline.beats) world.emit({ t: T0 + b.after, dur: b.dur, actor: b.actor, op: b.op, frame: 'studio', args: structuredClone(b.args) });
  const seg = only ? timeline.segments.find(s => s.id === only) : undefined;
  const cut = seg ? new Cut({ shots: [{ T0: 0, T1: seg.t1 - seg.t0, src0: T0 + seg.t0, rate: 1 }] }) : undefined;
  return { world, stage: STAGE, duration: () => (cut ? cut.end : T0 + timeline.duration), cut, sound: sounds(world), layouts: LAYOUTS, timeline };
}
