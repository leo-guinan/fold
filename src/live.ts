/** Running without end. A film is a log that is finished before anyone watches it; a live show is the same
 * log, still being written while it plays. Nothing else changes: state is still a fold, styles still draw
 * a view, sound still schedules from the log. What a live show adds is three roles around the world:
 *
 *   signals ──▶ Director ──▶ Stage ──▶ feed ──▶ Follower ──▶ Player ──▶ pixels
 *               (what it      (when it           (a renderer's copy of the world,
 *                means here)   happens)           a moment behind)
 *
 * The Stage is the one place events are written. It owns show time, puts every event a little in the
 * future (so nothing is ever inserted into what has already been shown), keeps actors to one action at a
 * time, and publishes each accepted event on a feed. A Director turns outside signals into beats for the
 * stage. A Follower holds a copy of the world in a renderer, fed by the stage, and plays it a fixed delay
 * behind so every event arrives before it is needed. Both ends compact their logs as they go.
 *
 * The feed is the broadcast. Video is one rendering of it; another page with another style is another. */

import type { EngineEvent, EventInput } from './log.js';
import type { Checkpoint, CompactResult, World } from './world.js';

// ---------- signals: what the outside world says ----------

/** Something that happened outside the show. Its data is evidence, never instruction: a rule decides what
 * (if anything) it means on stage, and should copy out only the fields it draws, bounded in size. */
export interface Signal<D = any> {
  /** Unique per source. A signal seen twice is staged once. */
  id: string;
  /** What kind of thing happened. Rules are chosen by kind. */
  kind: string;
  /** Where it came from (a feed name, a host). Rate limits are per source. */
  source?: string;
  /** When the source saw it (wall clock, ISO string or ms). Provenance only: show time is the stage's. */
  at?: string | number;
  data: D;
}

/** Cut text to a length that is safe to put on screen and in a log. */
export function clip(value: unknown, max = 140): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
}

// ---------- the feed: what the stage tells its followers ----------

export type FeedMessage<S, E extends EngineEvent = EngineEvent> =
  /** The whole world as of now. Sent first, and again whenever a follower asks. */
  | { type: 'hello'; seq: number; now: number; checkpoint: Checkpoint<S, E> }
  /** One event accepted into the log (allowed or refused). seq counts events, with no gaps. */
  | { type: 'event'; seq: number; now: number; e: E }
  /** A clock sample, and the latest seq (so a follower can tell it missed something). */
  | { type: 'tick'; seq: number; now: number };

/** What the stage writes down so a show can be resumed after a restart, or re-rendered later. */
export type JournalRecord<S, E extends EngineEvent = EngineEvent> =
  | { k: 'cp'; seq: number; now: number; wall: number; cp: Checkpoint<S, E> }
  | { k: 'e'; seq: number; now: number; wall: number; e: E };

// ---------- the stage ----------

/** One thing to happen on stage. Like an event, but the stage decides when. */
export interface Beat<A = any> {
  op: string;
  actor?: string;
  target?: string;
  frame?: string;
  dur?: number;
  args?: A;
  /** Anything else is kept on the event (provenance, a receipt id…). */
  [extra: string]: unknown;
  /** Not before this show time. Default: as soon as the lead allows. */
  t?: number;
  /** Seconds after the first beat of the same signal starts (for a short sequence). */
  after?: number;
  /** Wait for the actor's previous action to end. Default: true. */
  queue?: boolean;
}

export interface StageOptions<S, E extends EngineEvent = EngineEvent> {
  /** Show time in seconds. Must never go backwards. */
  clock: () => number;
  /** How far ahead of now every event is placed, so followers and sound have it before it starts. Default 1. */
  lead?: number;
  /** Pause between one actor's actions. Default 0.2. */
  gap?: number;
  /** A beat that could not start within this many seconds is dropped instead of queued. Default 20. */
  maxWait?: number;
  /** Seconds of finished history kept in the log before it is folded into the base. Default 30. */
  keep?: number;
  /** Seconds between compactions. Default 5. */
  compactEvery?: number;
  /** Where journal records go (a file, usually). */
  journal?: (record: JournalRecord<S, E>) => void;
  /** Wall clock in ms, for provenance in the journal. Default Date.now. */
  wall?: () => number;
}

export interface StageHealth {
  now: number; seq: number;
  /** Events in memory, and events folded into the base. */
  events: number; folded: number; baseT: number | null;
  denied: number; droppedBeats: number;
  /** Compactions that failed their check. More than zero means the log is growing: fix the op named in lastRefusal. */
  compactRefused: number; lastRefusal: string | null;
  followers: number;
}

export class Stage<S, E extends EngineEvent = EngineEvent> {
  seq = 0;
  private readonly busy = new Map<string, number>();
  private readonly subs = new Set<(m: FeedMessage<S, E>) => void>();
  private lastCompact = -Infinity;
  private readonly stats = { denied: 0, droppedBeats: 0, compactRefused: 0, lastRefusal: null as string | null };

  constructor(readonly world: World<S, E>, readonly opts: StageOptions<S, E>) {}

  now(): number { return this.opts.clock(); }

  /** Put a beat on air. Returns the event, or null if it was dropped because the actor's queue is too long. */
  put(beat: Beat): E | null {
    const now = this.now(), lead = this.opts.lead ?? 1, actor = beat.actor ?? 'stage';
    const { queue, after: _after, ...rest } = beat; void _after;
    let t = Math.max(now + lead, beat.t ?? -Infinity);
    if (queue !== false) t = Math.max(t, (this.busy.get(actor) ?? -Infinity) + (this.opts.gap ?? .2));
    if (t - now > (this.opts.maxWait ?? 20)) { this.stats.droppedBeats++; return null; }
    const e = this.world.emit({ dur: 0, frame: this.world.config.root.id, args: {}, ...rest, actor, t } as EventInput);
    if (e.result === 'denied') this.stats.denied++;
    else if (queue !== false) this.busy.set(actor, e.t + (e.dur || 0));
    this.seq++;
    this.opts.journal?.({ k: 'e', seq: this.seq, now, wall: this.wall(), e });
    this.publish({ type: 'event', seq: this.seq, now, e });
    return e;
  }

  /** When the actor is next free (show time). */
  freeAt(actor: string): number { return Math.max(this.now(), this.busy.get(actor) ?? -Infinity); }

  /** Housekeeping: call about once a second. Sends a clock sample and compacts when due. */
  tick(): CompactResult | null {
    const now = this.now();
    this.publish({ type: 'tick', seq: this.seq, now });
    if (now - this.lastCompact < (this.opts.compactEvery ?? 5)) return null;
    this.lastCompact = now;
    const r = this.world.compact(now - (this.opts.keep ?? 30));
    if (!r.ok) { this.stats.compactRefused++; this.stats.lastRefusal = r.reason ?? null; }
    for (const [actor, until] of this.busy) if (until < now - 60) this.busy.delete(actor);
    return r;
  }

  /** The whole world as of now, for a follower that is joining or has lost its place. */
  hello(): FeedMessage<S, E> { return { type: 'hello', seq: this.seq, now: this.now(), checkpoint: this.world.checkpoint() }; }

  /** Write a checkpoint to the journal (so a restart, or a later re-render, has somewhere to begin). */
  mark(): JournalRecord<S, E> {
    const rec: JournalRecord<S, E> = { k: 'cp', seq: this.seq, now: this.now(), wall: this.wall(), cp: this.world.checkpoint() };
    this.opts.journal?.(rec); return rec;
  }

  /** Carry on from a checkpoint record (after a restart). Set the clock to resume from rec.now first. */
  resume(rec: { seq: number; cp: Checkpoint<S, E> }, later: { seq: number; e: E }[] = []): this {
    this.world.restore(rec.cp); this.seq = rec.seq;
    for (const r of later) if (r.seq > this.seq && !this.world.log.find(r.e.id)) { this.world.log.add(r.e); this.world.log.next = Math.max(this.world.log.next, +r.e.id.slice(1) + 1 || 0); this.seq = r.seq; }
    this.busy.clear();
    for (const e of this.world.log.events) if (e.result !== 'denied') this.busy.set(e.actor, Math.max(this.busy.get(e.actor) ?? -Infinity, e.t + (e.dur || 0)));
    return this;
  }

  subscribe(fn: (m: FeedMessage<S, E>) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }

  health(): StageHealth {
    return { now: this.now(), seq: this.seq, events: this.world.log.events.length, folded: this.world.base?.dropped ?? 0, baseT: this.world.base?.t ?? null,
      ...this.stats, followers: this.subs.size };
  }

  private wall(): number { return (this.opts.wall ?? Date.now)(); }
  private publish(m: FeedMessage<S, E>): void { for (const fn of this.subs) { try { fn(m); } catch { /* a bad follower must not stop the show */ } } }
}

// ---------- the director ----------

export interface DirectorContext<S, E extends EngineEvent = EngineEvent> {
  stage: Stage<S, E>;
  now: number;
  /** The world as it stands now. */
  state: S;
}

export type SignalRule<S, E extends EngineEvent = EngineEvent, D = any> = (signal: Signal<D>, ctx: DirectorContext<S, E>) => Beat | Beat[] | null | void;

export interface DirectorOptions<S, E extends EngineEvent = EngineEvent> {
  /** What each kind of signal means on stage. '*' takes any kind without its own rule. */
  rules: Record<string, SignalRule<S, E>>;
  /** What to do when nothing has happened for a while, so the stream is never dead air. */
  idle?: { after: number; rule(ctx: DirectorContext<S, E> & { quiet: number; count: number }): Beat | Beat[] | null | void };
  /** How many signal ids to remember for de-duplication. Default 5000. */
  remember?: number;
  /** Signals accepted per source per minute of show time. Default 30. */
  perMinute?: number;
}

export interface Accepted<E> { staged: E[]; skipped?: string }

/** Turns signals into beats. It never throws: a malformed signal, a repeat, a flood or a rule that fails
 * is skipped and counted, because one bad input must not take a 24-hour show off the air. */
export class Director<S, E extends EngineEvent = EngineEvent> {
  readonly stats = { accepted: 0, staged: 0, skipped: {} as Record<string, number>, idles: 0 };
  private readonly seen = new Set<string>();
  private readonly rate = new Map<string, number[]>();
  private lastBusy = -Infinity; private lastIdle: number; private idleCount = 0;

  constructor(readonly stage: Stage<S, E>, readonly opts: DirectorOptions<S, E>) { this.lastIdle = stage.now(); }

  accept(signal: Signal): Accepted<E> {
    const skip = (why: string): Accepted<E> => { this.stats.skipped[why] = (this.stats.skipped[why] ?? 0) + 1; return { staged: [], skipped: why }; };
    if (!signal || typeof signal.id !== 'string' || !signal.id || typeof signal.kind !== 'string') return skip('malformed');
    const source = typeof signal.source === 'string' ? signal.source : '', key = source + '\n' + signal.id;
    if (this.seen.has(key)) return skip('duplicate');
    const rule = this.opts.rules[signal.kind] ?? this.opts.rules['*'];
    if (!rule) return skip('no rule');
    const now = this.stage.now(), recent = (this.rate.get(source) ?? []).filter(t => t > now - 60);
    if (recent.length >= (this.opts.perMinute ?? 30)) { this.rate.set(source, recent); return skip('rate'); }
    recent.push(now); this.rate.set(source, recent);
    this.seen.add(key);
    if (this.seen.size > (this.opts.remember ?? 5000)) this.seen.delete(this.seen.values().next().value as string);
    let beats: Beat[];
    try { beats = this.list(rule(signal, this.context(now))); } catch (err) { return skip('rule error: ' + clip(err instanceof Error ? err.message : err, 80)); }
    const staged = this.run(beats, { signal: signal.id, source: source || undefined });
    this.stats.accepted++;
    return { staged };
  }

  /** Call about once a second: plays the idle rule when the stage has been quiet long enough. */
  tick(): E[] {
    const idle = this.opts.idle; if (!idle) return [];
    const now = this.stage.now(), quiet = now - Math.max(this.lastBusy, this.lastIdle);
    if (quiet < idle.after) return [];
    this.lastIdle = now;
    let beats: Beat[];
    try { beats = this.list(idle.rule({ ...this.context(now), quiet: now - this.lastBusy, count: this.idleCount++ })); } catch { return []; }
    this.stats.idles++;
    return this.run(beats, {}, false);
  }

  private context(now: number): DirectorContext<S, E> { return { stage: this.stage, now, state: this.stage.world.stateAt(now) }; }
  private list(b: Beat | Beat[] | null | void): Beat[] { return !b ? [] : Array.isArray(b) ? b : [b]; }
  private run(beats: Beat[], tag: Record<string, unknown>, counts = true): E[] {
    const out: E[] = []; let first: number | null = null;
    for (const b of beats) {
      const t = b.after != null && first != null ? Math.max(b.t ?? -Infinity, first + b.after) : b.t;
      const e = this.stage.put({ ...b, ...tag, t });
      if (!e) continue;
      first ??= e.t; out.push(e);
      if (counts) this.lastBusy = Math.max(this.lastBusy, e.t + (e.dur || 0));
    }
    this.stats.staged += out.length;
    return out;
  }
}

// ---------- the follower ----------

export interface FollowerOptions {
  /** How far behind the stage this renderer plays, in seconds. Must be less than the stage's lead plus the
   * time an event takes to arrive, or events land late. Default 0.5 behind a stage lead of 1. */
  delay?: number;
  /** A local monotonic clock in seconds. Default performance.now() / 1000. */
  local?: () => number;
  /** Seconds of finished history kept behind the playhead before compacting. Default 20. */
  keep?: number;
  compactEvery?: number;
}

/** A renderer's copy of the world. Feed it the stage's messages; draw world.stateAt(clock()). */
export class Follower<S, E extends EngineEvent = EngineEvent> {
  ready = false;
  /** Set when a message was missed or arrived too late to use. Ask the stage for a new hello. */
  needsHello = false;
  seq = 0;
  readonly stats = { events: 0, late: 0, hellos: 0, compactRefused: 0, lastRefusal: null as string | null };
  private samples: number[] = []; private offset = 0; private lastLocal = 0; private lastCompact = -Infinity;

  constructor(readonly world: World<S, E>, readonly opts: FollowerOptions = {}) {}

  receive(m: FeedMessage<S, E>): void {
    if (m.type === 'hello') {
      this.world.restore(m.checkpoint); this.seq = m.seq; this.samples = []; this.sample(m.now, true);
      this.ready = true; this.needsHello = false; this.stats.hellos++; this.lastCompact = -Infinity;
      return;
    }
    if (!this.ready) return;
    this.sample(m.now);
    if (m.type === 'tick') { if (m.seq > this.seq) this.needsHello = true; return; }
    if (m.seq <= this.seq) return;
    if (m.seq > this.seq + 1 || (this.world.base && m.e.t < this.world.base.t)) { this.needsHello = true; return; }
    this.seq = m.seq;
    if (this.world.log.find(m.e.id)) return;
    if (m.e.t < this.clock()) this.stats.late++;
    this.world.log.add(structuredClone(m.e)); this.stats.events++;
  }

  /** The show time to draw now: the stage's clock, as best this renderer can tell, minus the delay. */
  clock(): number {
    const l = this.local(), dt = Math.max(0, l - this.lastLocal); this.lastLocal = l;
    const target = this.samples.length ? Math.max(...this.samples) : this.offset, err = target - this.offset;
    // close: slew gently (half a percent), so the picture never steps; far: jump
    this.offset += Math.abs(err) > 1 ? err : Math.max(-.005 * dt, Math.min(.005 * dt, err));
    return l + this.offset - (this.opts.delay ?? .5);
  }

  /** Housekeeping: call about once a second. */
  tick(): CompactResult | null {
    if (!this.ready) return null;
    const t = this.clock();
    if (t - this.lastCompact < (this.opts.compactEvery ?? 5)) return null;
    this.lastCompact = t;
    const r = this.world.compact(t - (this.opts.keep ?? 20));
    if (!r.ok) { this.stats.compactRefused++; this.stats.lastRefusal = r.reason ?? null; }
    return r;
  }

  private local(): number { return this.opts.local ? this.opts.local() : performance.now() / 1000; }
  /** Messages arrive late by a varying amount, never early: the largest recent offset is the nearest to true. */
  private sample(now: number, reset = false): void {
    const o = now - this.local();
    this.samples.push(o); if (this.samples.length > 20) this.samples.shift();
    if (reset) { this.offset = o; this.lastLocal = this.local(); }
  }
}

// ---------- journals: resuming, and re-rendering what was broadcast ----------

/** Load a stretch of a journal into a world: the last checkpoint at or before `from` (or the first one
 * there is), then every event after it up to `to`. The world can then be scrubbed and exported like any
 * finished scene, which is how a clip of a live show is cut frame-exact after the fact. */
export function openJournal<S, E extends EngineEvent = EngineEvent>(world: World<S, E>, records: JournalRecord<S, E>[], range: { from?: number; to?: number } = {}):
  { seq: number; now: number; from: number } | null {
  const cps = records.filter((r): r is Extract<JournalRecord<S, E>, { k: 'cp' }> => r.k === 'cp');
  if (!cps.length) return null;
  const from = range.from ?? Infinity;
  const cp = [...cps].reverse().find(r => (r.cp.base?.t ?? -Infinity) <= from) ?? cps[0];
  world.restore(cp.cp);
  let seq = cp.seq, now = cp.now;
  for (const r of records) {
    if (r.k !== 'e' || r.seq <= cp.seq) continue;
    if (range.to != null && r.e.t > range.to) continue;
    if (!world.log.find(r.e.id)) world.log.add(structuredClone(r.e));
    seq = Math.max(seq, r.seq); now = Math.max(now, r.now);
  }
  world.log.next = Math.max(world.log.next, ...world.log.events.map(e => (+e.id.slice(1) || 0) + 1));
  return { seq, now, from: world.base?.t ?? 0 };
}

/** Parse journal text (one JSON record per line). A torn last line, from a crash mid-write, is ignored. */
export function parseJournal<S, E extends EngineEvent = EngineEvent>(text: string): JournalRecord<S, E>[] {
  const out: JournalRecord<S, E>[] = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && (r.k === 'cp' || r.k === 'e')) out.push(r); } catch { /* torn line */ } }
  return out;
}
