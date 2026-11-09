/** The world: a log plus the rules for reading it. A world defines ops (what each kind of event does to
 * state, and when it is refused), derives its frame tree from the log, and folds the log into the state
 * at any time t. Folding is pure: the same log and the same t always give the same state.
 *
 * Every event is re-checked during the fold, so a log that was edited (or written by hand) can't smuggle in
 * an action the world would have refused. If the replay disagrees with what the log recorded, the
 * disagreement is reported (onMismatch) instead of silently trusted. */

import { Log, type EngineEvent, type EventInput } from './log.js';
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
    const tree: FrameTree = { [this.config.root.id]: { ...this.config.root } };
    for (const pass of this.passes) for (const e of this.log.events) {
      if (e.result === 'denied') continue;
      const spec = this.ops.get(e.op); if (!spec) continue;
      for (const h of hooksOf(spec)) if (h.pass === pass) h.apply(tree, e, t);
    }
    setDepths(tree);
    if (this.fcache.size > (this.config.cache?.frames ?? 4000)) this.fcache.clear();
    this.fcache.set(key, tree);
    return tree;
  }

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
    const reason = this.check(state, e, this.config.checkFrames === 'fold' ? frames : this.frames(e.t));
    const denied = e.result === 'denied' || !!reason;
    if ((e.result === 'denied') !== !!reason) { report?.mismatches.push({ e, logged: e.result, replayed: reason }); this.config.onMismatch?.(state, e, reason); }
    if (denied) { report?.denied.push({ e, reason: reason || e.reason }); this.config.onDenied?.(state, e, reason || e.reason, t); return; }
    this.ops.get(e.op)?.apply?.(state, e, p, t, { world: this, frames });
  }

  /** Fold a given list of events (in the order given) into a fresh state, at time t. Not cached. */
  foldEvents(events: readonly E[], t: number, frames: FrameTree = this.frames(t), report?: FoldReport<E>): S {
    const S = this.config.initial();
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
    const e = this.log.add(input);
    const frames = this.frames(opts.frameTime ?? e.t);
    const unbind = this.config.bindFrames?.(frames);
    let reason: string | null;
    try { reason = this.check(this.stateAt(e.t - 1e-4), e, frames); } finally { unbind?.(); }
    if (reason) { e.result = 'denied'; e.reason = reason; this.config.decorateDenied?.(e, reason); this.log.touch(); }
    return e;
  }

  /** Clear the caches (they also clear themselves when the log changes version). */
  invalidate(): void { this.fcache.clear(); this.scache.clear(); this.log.touch(); }
}

function hooksOf<E extends EngineEvent>(spec: OpSpec<any, E>): LayoutHook<E>[] {
  return spec.layout ? (Array.isArray(spec.layout) ? spec.layout : [spec.layout]) : [];
}
