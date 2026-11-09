/** The world: a log plus the rules for reading it. A world defines ops (what each kind of event does to
 * state, and when it is refused), derives its frame tree from the log, and folds the log into the state
 * at any time t. Folding is pure: the same log and the same t always give the same state.
 *
 * Every event is re-checked during the fold, so a log that was edited (or written by hand) can't smuggle in
 * an action the world would have refused. If the replay disagrees with what the log recorded, the
 * disagreement is reported (onMismatch) instead of silently trusted. */

import { Log, byTime, type EngineEvent, type EventInput } from './log.js';
import { setDepths, type FrameNode, type FrameTree } from './frames.js';
import { clamp } from './math.js';

export interface FoldContext<S, E extends EngineEvent = EngineEvent> {
  world: World<S, E>;
  /** The frame tree the fold (or check) is reading. */
  frames: FrameTree;
}

/** A check answers: undefined = no opinion (keep checking), null = allowed (stop), string = refused, with the reason. */
export type Verdict = string | null | undefined;
export type Rule<S, E extends EngineEvent = EngineEvent> = (state: S, e: E, ctx: FoldContext<S, E>) => Verdict;

export interface LayoutHook<E extends EngineEvent = EngineEvent> {
  /** Hooks run pass by pass (ascending), each over the whole log in time order. */
  pass: number;
  /** Change the frame tree as of time t. Only events the log recorded as allowed are offered. */
  apply(tree: FrameTree, e: E, t: number): void;
}

export interface OpSpec<S, E extends EngineEvent = EngineEvent> {
  /** Op-specific check, after the world's rules. */
  check?: Rule<S, E>;
  /** Change state. p is the event's progress at time t (0..1); apply runs for every event that has started. */
  apply?(state: S, e: E, p: number, t: number, ctx: FoldContext<S, E>): void;
  /** How this op changes the frame tree, if it does. */
  layout?: LayoutHook<E> | LayoutHook<E>[];
  /** Set false when this op's effect keeps changing after the event has ended (it reads t, not just p).
   * Such an event is never folded into a checkpoint, and holds back everything after it. Default: true. */
  settles?: boolean;
}

export interface WorldConfig<S, E extends EngineEvent = EngineEvent> {
  /** A fresh, empty state. */
  initial(): S;
  /** The root frame. */
  root: FrameNode;
  ops?: Record<string, OpSpec<S, E>>;
  /** Checks that apply to every op, in order, before the op's own check. */
  rules?: Rule<S, E>[];
  /** Called during the fold for each refused event. */
  onDenied?(state: S, e: E, reason: string | undefined, t: number): void;
  /** Called during the fold when the replay's verdict differs from the log's. */
  onMismatch?(state: S, e: E, replayed: string | null): void;
  /** Decorate an event refused at emit time (shorten it, add a caption…). */
  decorateDenied?(e: E, reason: string): void;
  /** For hosts that keep a global "current frame tree": bind it, return a function that restores the previous one. */
  bindFrames?(tree: FrameTree): () => void;
  /** Which frame tree a replayed check reads. 'event' (default): the tree at the event's own time, so a
   * verdict never changes with the time you fold to. 'fold': the tree at the fold time (cheaper; correct
   * only when checks read frame structure that never changes, such as ancestry). */
  checkFrames?: 'event' | 'fold';
  cache?: { frames?: number; states?: number };
  /** Copy a state or a frame tree. Default: structuredClone. Only used by worlds that compact. */
  clone?<T>(value: T): T;
}

/** Everything the world has forgotten, folded into one state and one frame tree as of time t. */
export interface Base<S> {
  t: number;
  state: S;
  frames: FrameTree;
  /** How many events have been folded in so far. */
  dropped: number;
}

/** A world you can save and restore: the base, the events still in the log, and the frame trees pinned
 * for events that began before the base. Plain data, so it can be written to disk or sent to a renderer. */
export interface Checkpoint<S, E extends EngineEvent = EngineEvent> {
  v: 1;
  base: Base<S> | null;
  events: E[];
  pins: Record<string, FrameTree>;
  next: number;
}

export interface CompactOptions {
  /** Check that the compacted world gives the same state and frames as the full one before committing. Default: true. */
  verify?: boolean;
  /** Offsets after t (seconds) at which to compare. Default: [0, 1, 30]. */
  horizon?: number[];
}

export interface CompactResult {
  /** False when the check failed and nothing was changed. */
  ok: boolean;
  /** Events folded into the base by this call. */
  dropped: number;
  /** Events still in the log. */
  kept: number;
  reason?: string;
}

/** What a fold refused and where the replay disagreed with the log. */
export interface FoldReport<E extends EngineEvent = EngineEvent> {
  denied: { e: E; reason: string | undefined }[];
  mismatches: { e: E; logged: string; replayed: string | null }[];
}

export interface EmitOptions {
  /** The frame tree the check reads. Default: the tree at the event's own time. */
  frameTime?: number;
}

export class World<S, E extends EngineEvent = EngineEvent> {
  readonly log = new Log<E>();
  readonly ops = new Map<string, OpSpec<S, E>>();
  readonly rules: Rule<S, E>[];
  private readonly fcache = new Map<string, FrameTree>();
  private readonly scache = new Map<string, S>();
  private passes: number[] = [];
  /** What the world has forgotten (see compact). Null until the first compaction or restore. */
  base: Base<S> | null = null;
  /** Frame trees for events that started before the base, as they were at each event's own time. */
  private readonly pins = new Map<string, FrameTree>();

  constructor(readonly config: WorldConfig<S, E>) {
    this.rules = [...(config.rules || [])];
    for (const [op, spec] of Object.entries(config.ops || {})) this.define(op, spec);
  }

  get version(): number { return this.log.version; }

  define(op: string, spec: OpSpec<S, E>): this {
    this.ops.set(op, spec);
    const ps = new Set(this.passes);
    for (const h of hooksOf(spec)) ps.add(h.pass);
    this.passes = [...ps].sort((a, b) => a - b);
    this.log.touch();
    return this;
  }
  rule(r: Rule<S, E>): this { this.rules.push(r); this.log.touch(); return this; }

  /** The frame tree as of time t (Infinity: every frame the log will ever make, at its final layout). */
  frames(t = Infinity): FrameTree {
    const key = this.version + '|' + t;
    const hit = this.fcache.get(key); if (hit) return hit;
    const tree = this.layoutEvents(this.log.events, t);
    if (this.fcache.size > (this.config.cache?.frames ?? 4000)) this.fcache.clear();
    this.fcache.set(key, tree);
    return tree;
  }

  /** Lay out a given list of events on top of the base (or the root), as of time t. Not cached. */
  private layoutEvents(events: readonly E[], t: number): FrameTree {
    const tree: FrameTree = this.base ? this.copy(this.base.frames) : { [this.config.root.id]: { ...this.config.root } };
    for (const pass of this.passes) for (const e of events) {
      if (e.result === 'denied') continue;
      const spec = this.ops.get(e.op); if (!spec) continue;
      for (const h of hooksOf(spec)) if (h.pass === pass) h.apply(tree, e, t);
    }
    setDepths(tree);
    return tree;
  }

  private copy<T>(value: T): T { return this.config.clone ? this.config.clone(value) : structuredClone(value); }

  /** The world's verdict on an event against a state: null if allowed, else the reason. */
  check(state: S, e: E, frames?: FrameTree): string | null {
    const ctx: FoldContext<S, E> = { world: this, frames: frames ?? this.frames() };
    for (const r of this.rules) { const v = r(state, e, ctx); if (v !== undefined) return v; }
    const spec = this.ops.get(e.op);
    return spec?.check ? (spec.check(state, e, ctx) ?? null) : null;
  }

  /** Apply one event to a state at time t: re-check it, report refusals and disagreements, else apply its op. */
  step(state: S, e: E, t: number, frames: FrameTree, report?: FoldReport<E>): void {
    const p = e.dur ? clamp((t - e.t) / e.dur) : 1;
    const reason = this.check(state, e, this.config.checkFrames === 'fold' ? frames : this.pins.get(e.id) ?? this.frames(e.t));
    const denied = e.result === 'denied' || !!reason;
    if ((e.result === 'denied') !== !!reason) { report?.mismatches.push({ e, logged: e.result, replayed: reason }); this.config.onMismatch?.(state, e, reason); }
    if (denied) { report?.denied.push({ e, reason: reason || e.reason }); this.config.onDenied?.(state, e, reason || e.reason, t); return; }
    this.ops.get(e.op)?.apply?.(state, e, p, t, { world: this, frames });
  }

  /** Fold a given list of events (in the order given) into a fresh state, at time t. Not cached.
   * A world that has compacted starts from its base instead of an empty state. */
  foldEvents(events: readonly E[], t: number, frames: FrameTree = this.frames(t), report?: FoldReport<E>): S {
    const S = this.base ? this.copy(this.base.state) : this.config.initial();
    for (const e of events) { if (e.t > t) continue; this.step(S, e, t, frames, report); }
    return S;
  }

  /** Replay the whole log at time t and report every refusal and every disagreement with the log. */
  report(t = Infinity): FoldReport<E> {
    const r: FoldReport<E> = { denied: [], mismatches: [] };
    const frames = this.frames(t); const unbind = this.config.bindFrames?.(frames);
    try { this.foldEvents(this.log.events, t, frames, r); } finally { unbind?.(); }
    return r;
  }

  /** The state at time t. Cached until the log changes. */
  stateAt(t: number): S {
    const key = this.version + '|' + t;
    const hit = this.scache.get(key); if (hit) return hit;
    const frames = this.frames(t);
    const unbind = this.config.bindFrames?.(frames);
    let S: S;
    try { S = this.foldEvents(this.log.events, t, frames); } finally { unbind?.(); }
    if (this.scache.size > (this.config.cache?.states ?? 300)) this.scache.clear();
    this.scache.set(key, S);
    return S;
  }

  /** Add an event, checked against the world just before it starts. A refused event is kept, marked denied. */
  emit(input: EventInput | E, opts: EmitOptions = {}): E {
    if (this.base && input.t < this.base.t) throw new RangeError(`event at ${input.t} is before the checkpoint at ${this.base.t}: that part of the log is closed`);
    const e = this.log.add(input);
    const frames = this.frames(opts.frameTime ?? e.t);
    const unbind = this.config.bindFrames?.(frames);
    let reason: string | null;
    try { reason = this.check(this.stateAt(e.t - 1e-4), e, frames); } finally { unbind?.(); }
    if (reason) { e.result = 'denied'; e.reason = reason; this.config.decorateDenied?.(e, reason); this.log.touch(); }
    return e;
  }

  // ---------- running without end: compaction and checkpoints ----------

  /** Fold the oldest finished events into the base and drop them from the log, so a world that runs for
   * days stays small. Call it with a time safely behind anything still being drawn.
   *
   * What goes: the longest run of events at the start of the log that have all ended by t (and whose ops
   * settle). The fold keeps its order, so the world plays exactly as before as long as each dropped event's
   * effect no longer depends on t once it has ended. That is checked here, not assumed: the state and frames
   * are compared before and after, and if they differ nothing is dropped and the reason is returned.
   *
   * After a compaction the world answers for t >= base.t only, and refuses new events before it. */
  compact(t: number, opts: CompactOptions = {}): CompactResult {
    const ev = this.log.events; let n = 0;
    while (n < ev.length && ev[n].t + ev[n].dur <= t && this.ops.get(ev[n].op)?.settles !== false) n++;
    if (!n) return { ok: true, dropped: 0, kept: ev.length };
    const verify = opts.verify ?? true, times = (opts.horizon ?? [0, 1, 30]).map(d => t + d);
    const sample = () => times.map(x => canonical([this.stateAt(x), this.frames(x)]));
    const want = verify ? sample() : [];

    const prefix = ev.slice(0, n), tail = ev.slice(n);
    const framesAtT = this.frames(t); const unbind = this.config.bindFrames?.(framesAtT);
    let state: S; try { state = this.foldEvents(prefix, t, framesAtT); } finally { unbind?.(); }
    const frames = this.layoutEvents(prefix, t);
    // events still in the log that began before the new base keep the frame tree their check read
    const pinned = new Map<string, FrameTree>();
    for (const e of tail) if (e.t < t) pinned.set(e.id, this.pins.get(e.id) ?? this.frames(e.t));

    const undo = { base: this.base, pins: new Map(this.pins), log: this.log.snapshot() };
    this.base = { t, state, frames, dropped: (this.base?.dropped ?? 0) + n };
    this.pins.clear(); for (const [id, tree] of pinned) this.pins.set(id, tree);
    this.log.dropFirst(n);
    if (verify) {
      const got = sample(); const bad = got.findIndex((g, i) => g !== want[i]);
      if (bad >= 0) {
        this.base = undo.base; this.pins.clear(); for (const [id, tree] of undo.pins) this.pins.set(id, tree);
        this.log.restore(undo.log);
        return { ok: false, dropped: 0, kept: this.log.events.length,
          reason: `folding ${n} events into a checkpoint at ${t} would change the world at ${times[bad]} (first: ${prefix[0].id} ${prefix[0].op}, last: ${prefix[n - 1].id} ${prefix[n - 1].op}); an op's effect still depends on time after its event ends` };
      }
    }
    return { ok: true, dropped: n, kept: this.log.events.length };
  }

  /** The world as plain data: enough to carry on from here in another process, or after a restart. */
  checkpoint(): Checkpoint<S, E> {
    return this.copy({ v: 1 as const, base: this.base, events: this.log.events.slice(), pins: Object.fromEntries(this.pins), next: this.log.next });
  }

  /** Replace the world with a checkpoint. */
  restore(cp: Checkpoint<S, E>): this {
    const c = this.copy(cp);
    this.base = c.base; this.pins.clear(); for (const [id, tree] of Object.entries(c.pins || {})) this.pins.set(id, tree);
    const events = c.events.slice().sort(byTime);
    this.log.restore({ events, inserted: events.slice().sort((a, b) => (+a.id.slice(1)) - (+b.id.slice(1))), next: c.next });
    this.fcache.clear(); this.scache.clear();
    return this;
  }

  /** Clear the caches (they also clear themselves when the log changes version). */
  invalidate(): void { this.fcache.clear(); this.scache.clear(); this.log.touch(); }
}

/** JSON with keys in sorted order, so two values compare equal whatever order their fields were set in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

function hooksOf<E extends EngineEvent>(spec: OpSpec<any, E>): LayoutHook<E>[] {
  return spec.layout ? (Array.isArray(spec.layout) ? spec.layout : [spec.layout]) : [];
}
