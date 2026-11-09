/** The log: an append-only list of events, kept in time order. It is the single source of truth: state,
 * frames, sound and pictures are all derived from it, so the same log always plays the same way. */

export type Result = 'ok' | 'denied';

export interface EngineEvent<A = any> {
  /** Assigned by the log: 'e1', 'e2', … in insertion order. */
  id: string;
  /** When the event starts, in scene seconds. */
  t: number;
  /** How long it takes. Zero means instantaneous. */
  dur: number;
  /** Who does it. */
  actor: string;
  /** What kind of thing happens. Ops are defined by the world, not by the log. */
  op: string;
  /** What it happens to. */
  target?: string;
  /** The frame (coordinate space) it happens in. */
  frame: string;
  args: A;
  /** 'denied' when the world refused it. A denied event stays in the log: refusals are part of the story. */
  result: Result;
  reason?: string;
  [extra: string]: unknown;
}

export type EventInput<A = any> = Partial<EngineEvent<A>> & { t: number; op: string };

export interface LogSnapshot<E> { events: E[]; inserted: E[]; next: number }

/** Time order, then insertion order. Ids are 'e<n>', so the numeric part is the insertion sequence. */
export const byTime = (a: EngineEvent, b: EngineEvent): number => a.t - b.t || (+a.id.slice(1)) - (+b.id.slice(1));

export class Log<E extends EngineEvent = EngineEvent> {
  /** Every event, sorted by time. The array is mutated in place, so a reference to it stays valid. */
  readonly events: E[] = [];
  /** Every event in the order it was added. */
  readonly inserted: E[] = [];
  next = 1;
  /** Bumped on every change. Caches of anything derived from the log key on it. */
  version = 0;

  add(ev: EventInput | E): E {
    const e = ev as E;
    e.id = e.id || 'e' + (this.next++);
    e.result = e.result || 'ok';
    // Insert where a full sort would put it. The array is already in order, so a binary search finds the
    // place; a live log takes an event every few seconds for days, and must not pay for a sort each time.
    const list = this.events; let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (byTime(list[mid], e) <= 0) lo = mid + 1; else hi = mid; }
    list.splice(lo, 0, e); this.inserted.push(e);
    this.version++;
    return e;
  }
  /** Forget the first n events (in time order). Used by World.compact once they are folded into a checkpoint. */
  dropFirst(n: number): E[] {
    const gone = this.events.splice(0, n); const ids = new Set(gone.map(e => e.id));
    const keep = this.inserted.filter(e => !ids.has(e.id)); this.inserted.length = 0; this.inserted.push(...keep);
    this.version++;
    return gone;
  }
  /** Mark the log changed after editing an event in place (for example, when it is denied). */
  touch(): void { this.version++; }
  clear(): void { this.events.length = 0; this.inserted.length = 0; this.next = 1; this.version++; }
  /** Drop everything after time t (for re-staging from a point). */
  keepUntil(t: number): void {
    const keep = (a: E[]) => { const k = a.filter(e => e.t <= t); a.length = 0; a.push(...k); };
    keep(this.events); keep(this.inserted); this.version++;
  }
  snapshot(): LogSnapshot<E> { return { events: this.events.slice(), inserted: this.inserted.slice(), next: this.next }; }
  restore(s: LogSnapshot<E>): void {
    this.events.length = 0; this.events.push(...s.events);
    this.inserted.length = 0; this.inserted.push(...s.inserted);
    this.next = s.next; this.version++;
  }
  find(id: string): E | undefined { return this.events.find(e => e.id === id); }
  /** A plain, rounded view of the log for diffing and inspection. */
  dump(): object[] {
    return this.events.map(e => ({ id: e.id, t: +e.t.toFixed(2), dur: +e.dur.toFixed(2), op: e.op, actor: e.actor, target: e.target, frame: e.frame, result: e.result, reason: e.reason || null }));
  }
}
