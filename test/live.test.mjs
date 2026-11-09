// Running without end: the log stays small, a compacted world plays exactly like the full one, and a
// follower fed by a stage sees the same world a moment later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../dist/esm/index.js';

// A desk: cards are posted (they slide in over the event's duration), drawers open and close, and a card
// can't be posted into a closed drawer. Everything settles once its event has ended.
function makeWorld(extra = {}) {
  return new F.World({
    initial: () => ({ cards: [], count: 0, refused: 0 }),
    root: { id: 'desk', parent: null, x: 0, y: 0, w: 100, h: 100, lw: 100, lh: 100 },
    onDenied: (S) => { S.refused++; },
    ops: {
      OPEN: { layout: { pass: 0, apply(tree, e) { tree[e.args.id] = { id: e.args.id, parent: e.frame, x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 }; } } },
      SHUT: { layout: { pass: 1, apply(tree, e, t) { const f = tree[e.target]; if (!f || e.t > t) return; f.y += 5 * F.progress(t, e.t, e.dur); if (t >= e.t + e.dur) f.hidden = true; } } },
      POST: {
        check(S, e, ctx) { const f = ctx.frames[e.frame]; return !f ? 'no such place' : f.hidden ? 'that drawer is shut' : null; },
        apply(S, e, p) { S.count++; S.cards.push({ id: e.args.id, in: p, at: e.t }); if (S.cards.length > 4) S.cards.shift(); },
      },
      ...extra,
    },
  });
}
const same = (a, b, times, what) => { for (const t of times) { assert.deepEqual(a.stateAt(t), b.stateAt(t), `${what}: state at ${t}`); assert.deepEqual(a.frames(t), b.frames(t), `${what}: frames at ${t}`); } };

test('inserting into the log gives the same order as sorting it', () => {
  const R = F.rng(7); const L = new F.Log(); const ref = [];
  for (let i = 0; i < 400; i++) { const e = L.add({ t: Math.floor(R() * 40) / 2, op: 'X' }); ref.push(e); }
  assert.deepEqual(L.events.map(e => e.id), [...ref].sort(F.byTime).map(e => e.id));
  const gone = L.dropFirst(100); assert.equal(gone.length, 100); assert.equal(L.events.length, 300); assert.equal(L.inserted.length, 300);
  assert.ok(L.inserted.every((e, i, a) => !i || +a[i - 1].id.slice(1) < +e.id.slice(1)), 'insertion order survives a drop');
});

test('a compacted world plays exactly like the full one', () => {
  const full = makeWorld(), small = makeWorld();
  const script = [
    { t: 0, dur: .5, actor: 'a', op: 'OPEN', frame: 'desk', args: { id: 'drawer' } },
    { t: 1, dur: 1, actor: 'a', op: 'POST', frame: 'drawer', args: { id: 'c1' } },
    { t: 2, dur: 6, actor: 'b', op: 'POST', frame: 'drawer', args: { id: 'slow' } },   // still arriving when we compact
    { t: 3, dur: 1, actor: 'a', op: 'POST', frame: 'drawer', args: { id: 'c2' } },      // finished, but behind the slow one
    { t: 4, dur: 1, actor: 'a', op: 'SHUT', target: 'drawer', frame: 'desk' },
    { t: 5.5, dur: 1, actor: 'a', op: 'POST', frame: 'drawer', args: { id: 'c3' } },    // refused: shut by then
    { t: 9, dur: 1, actor: 'a', op: 'POST', frame: 'desk', args: { id: 'c4' } },
  ];
  for (const s of script) { full.emit(structuredClone(s)); small.emit(structuredClone(s)); }
  const r1 = small.compact(1.5);
  assert.deepEqual([r1.ok, r1.dropped, small.log.events.length], [true, 1, 6], 'only the drawer opening has ended by 1.5');
  same(full, small, [1.5, 2, 3.3, 4.5, 6, 7.9, 9.5, 20], 'after the first compaction');
  const r2 = small.compact(7);
  assert.equal(r2.ok, true); assert.equal(small.base.dropped, 2, 'the slow post holds back everything after it');
  same(full, small, [7, 7.5, 8, 9.5, 20], 'after the second');
  const r3 = small.compact(8.2);
  assert.equal(r3.ok, true); assert.equal(small.log.events.length, 1); assert.equal(small.base.dropped, 6);
  same(full, small, [8.2, 9.5, 20], 'after the third');
  assert.deepEqual(small.report().mismatches, [], 'the replay still agrees with every verdict left in the log');
  assert.equal(small.stateAt(20).refused, 1, 'the refusal is remembered in the base');
  assert.throws(() => small.emit({ t: 5, dur: 0, actor: 'a', op: 'POST', frame: 'desk', args: { id: 'late' } }), /before the checkpoint/);
});

test('an event still in flight keeps the frames its check read, across a compaction', () => {
  const full = makeWorld(), small = makeWorld();
  for (const W of [full, small]) {
    W.emit({ t: 0, dur: .2, actor: 'a', op: 'OPEN', frame: 'desk', args: { id: 'drawer' } });
    W.emit({ t: 1, dur: 30, actor: 'b', op: 'POST', frame: 'drawer', args: { id: 'long' } });   // allowed: the drawer was open at t=1
    W.emit({ t: 2, dur: 1, actor: 'a', op: 'SHUT', target: 'drawer', frame: 'desk' });
  }
  // the long post is first in line and unfinished, so nothing after it can go yet; only the OPEN is dropped
  assert.equal(small.compact(10).dropped, 1);
  same(full, small, [10, 15, 40], 'in flight');
  assert.deepEqual(small.report(12).mismatches, []);
});

test('compaction refuses, and changes nothing, when an op keeps changing after its event ends', () => {
  const drifting = { GLOW: { apply(S, e, p, t) { S.glow = t - e.t; } } };
  const W = makeWorld(drifting);
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'GLOW', frame: 'desk' }); W.emit({ t: 5, dur: 1, actor: 'a', op: 'POST', frame: 'desk', args: { id: 'c' } });
  const before = JSON.stringify(W.stateAt(8)), r = W.compact(3);
  assert.equal(r.ok, false); assert.match(r.reason, /depends on time/); assert.equal(W.log.events.length, 2); assert.equal(W.base, null);
  assert.equal(JSON.stringify(W.stateAt(8)), before);
  // the honest way to write that op: say it never settles. It stays in the log and holds the rest back.
  const V = makeWorld({ GLOW: { settles: false, apply(S, e, p, t) { S.glow = t - e.t; } } });
  V.emit({ t: 0, dur: 1, actor: 'a', op: 'GLOW', frame: 'desk' }); V.emit({ t: 5, dur: 1, actor: 'a', op: 'POST', frame: 'desk', args: { id: 'c' } });
  assert.deepEqual([V.compact(50).ok, V.compact(50).dropped, V.log.events.length], [true, 0, 2]);
});

test('a checkpoint survives JSON and restores into a fresh world', () => {
  const A = makeWorld();
  for (let i = 0; i < 40; i++) A.emit({ t: i, dur: .5 + (i % 3), actor: 'a', op: i === 0 ? 'OPEN' : 'POST', frame: 'desk', args: { id: i === 0 ? 'drawer' : 'c' + i } });
  A.compact(25);
  const B = makeWorld().restore(JSON.parse(JSON.stringify(A.checkpoint())));
  same(A, B, [25, 26.2, 30, 39.9, 100], 'restored');
  assert.equal(B.emit({ t: 50, dur: 1, actor: 'a', op: 'POST', frame: 'desk', args: { id: 'new' } }).id, A.emit({ t: 50, dur: 1, actor: 'a', op: 'POST', frame: 'desk', args: { id: 'new' } }).id, 'ids carry on');
});

// ---------- stage, director, follower ----------

function makeShow({ keep = 30, journal } = {}) {
  let now = 0; const world = makeWorld();
  const stage = new F.Stage(world, { clock: () => now, lead: 1, gap: .2, keep, compactEvery: 5, journal, wall: () => 1000 * now });
  const director = new F.Director(stage, {
    perMinute: 1000,
    rules: {
      note: (s) => ({ op: 'POST', actor: 'clerk', dur: .8, args: { id: F.clip(s.data.text, 12) } }),
      pair: (s) => [{ op: 'POST', actor: 'clerk', dur: .5, args: { id: s.id + 'a' } }, { op: 'POST', actor: 'runner', dur: .5, after: 2, args: { id: s.id + 'b' } }],
      bad: () => { throw new Error('rule blew up'); },
    },
    idle: { after: 10, rule: ({ count }) => ({ op: 'POST', actor: 'clerk', dur: 1, args: { id: 'idle' + count } }) },
  });
  return { world, stage, director, advance: d => { now += d; }, set: t => { now = t; }, now: () => now };
}

test('the stage puts every event in the future, one at a time per actor, and numbers the feed', () => {
  const { stage, director, advance } = makeShow(); const feed = []; stage.subscribe(m => feed.push(m));
  advance(10);
  const a = director.accept({ id: 's1', kind: 'note', source: 'x', data: { text: 'first' } }).staged[0];
  const b = director.accept({ id: 's2', kind: 'note', source: 'x', data: { text: 'second' } }).staged[0];
  assert.equal(a.t, 11, 'now + lead'); assert.ok(Math.abs(b.t - 12) < 1e-9, 'after the first ends, plus the gap');
  assert.equal(a.signal, 's1'); assert.equal(a.source, 'x');
  const pair = director.accept({ id: 's3', kind: 'pair', data: {} }).staged;
  assert.ok(Math.abs(pair[1].t - (pair[0].t + 2)) < 1e-9, 'the second beat of a sequence keeps its offset from the first');
  assert.deepEqual(feed.map(m => [m.type, m.seq]), [['event', 1], ['event', 2], ['event', 3], ['event', 4]]);
});

test('the director never throws: repeats, floods, strangers and broken rules are skipped and counted', () => {
  const { director, stage, advance } = makeShow();
  const limited = new F.Director(stage, { perMinute: 3, rules: { note: () => ({ op: 'POST', actor: 'n' + Math.random(), queue: false, dur: .1, args: { id: 'x' } }) } });
  assert.equal(director.accept({ id: 'a', kind: 'note', data: { text: 'hi' } }).staged.length, 1);
  assert.equal(director.accept({ id: 'a', kind: 'note', data: { text: 'hi' } }).skipped, 'duplicate');
  assert.equal(director.accept({ id: 'b', kind: 'unknown', data: {} }).skipped, 'no rule');
  assert.equal(director.accept({ kind: 'note' }).skipped, 'malformed'); assert.equal(director.accept(null).skipped, 'malformed');
  assert.match(director.accept({ id: 'c', kind: 'bad', data: {} }).skipped, /rule error: rule blew up/);
  assert.equal(director.accept({ id: 'd', kind: 'note', data: null }).skipped.startsWith('rule error'), true, 'a rule reading missing data fails safely');
  const got = [1, 2, 3, 4, 5].map(i => limited.accept({ id: 'f' + i, kind: 'note', source: 'flood', data: {} }).skipped);
  assert.deepEqual(got, [undefined, undefined, undefined, 'rate', 'rate']);
  advance(61); assert.equal(limited.accept({ id: 'f6', kind: 'note', source: 'flood', data: {} }).skipped, undefined, 'the limit is per minute');
});

test('a long queue drops beats instead of falling behind forever', () => {
  const { stage } = makeShow();
  const got = Array.from({ length: 30 }, (_, i) => stage.put({ op: 'POST', actor: 'clerk', dur: 2, args: { id: 'q' + i } }));
  assert.ok(got.filter(Boolean).length < 30 && got.filter(Boolean).length >= 9); assert.ok(stage.health().droppedBeats > 0);
  assert.ok(Math.max(...got.filter(Boolean).map(e => e.t)) <= 21 + 1e-9, 'nothing queues more than maxWait behind the time it asked for');
  const far = stage.put({ op: 'POST', actor: 'planner', dur: 1, t: 600, args: { id: 'later' } });
  assert.equal(far.t, 600, 'a beat that asks for a time far ahead gets it: the limit is on queueing, not on planning');
});

test('idle beats fill the quiet, and stop when something happens', () => {
  const { director, advance, world } = makeShow();
  advance(5); assert.equal(director.tick().length, 0, 'not quiet for long enough yet');
  advance(6); assert.equal(director.tick().length, 1);
  advance(3); assert.equal(director.tick().length, 0);
  advance(8); assert.equal(director.tick().length, 1);
  director.accept({ id: 'n', kind: 'note', data: { text: 'news' } });
  advance(9); assert.equal(director.tick().length, 0, 'a signal resets the quiet');
  assert.equal(world.log.events.filter(e => String(e.args.id).startsWith('idle')).length, 2);
});

test('a follower sees the stage\'s world, a moment later, and notices when it misses something', () => {
  const { stage, director, advance, now } = makeShow();
  const copy = makeWorld(); const follower = new F.Follower(copy, { delay: .5, local: () => now() + 1000 /* its own clock, offset */ });
  let drop = false; stage.subscribe(m => { if (!drop) follower.receive(m); });
  follower.receive(stage.hello());
  assert.ok(Math.abs(follower.clock() - (now() - .5)) < 1e-6);
  for (let i = 0; i < 20; i++) { advance(.7); director.accept({ id: 'n' + i, kind: 'note', data: { text: 'c' + i } }); stage.tick(); follower.tick(); }
  advance(3);
  assert.equal(follower.stats.late, 0, 'the lead is longer than the delay, so nothing arrives late');
  const t = follower.clock(); assert.deepEqual(copy.stateAt(t), stage.world.stateAt(t)); assert.deepEqual(copy.report().mismatches, []);
  drop = true; advance(1); director.accept({ id: 'lost', kind: 'note', data: { text: 'lost' } }); drop = false;
  advance(1); stage.tick(); assert.equal(follower.needsHello, true, 'the tick carries the stage\'s seq');
  follower.receive(stage.hello()); assert.equal(follower.needsHello, false);
  const t2 = follower.clock() + 2; assert.deepEqual(copy.stateAt(t2), stage.world.stateAt(t2));
});

test('a day of signals: the log stays small on both ends and nothing drifts from the full record', (ctx) => {
  const { stage, director, advance, now, world } = makeShow();
  const reference = makeWorld(); stage.subscribe(m => { if (m.type === 'event') reference.log.add(structuredClone(m.e)); });
  const copy = makeWorld(); const follower = new F.Follower(copy, { delay: .5, local: now }); stage.subscribe(m => follower.receive(m)); follower.receive(stage.hello());
  const R = F.rng(42); let peak = 0, peakCopy = 0, n = 0, checks = 0;
  stage.put({ op: 'OPEN', actor: 'clerk', dur: .2, args: { id: 'drawer' } });
  while (now() < 86400) {
    advance(1 + R() * 20);
    const k = R();
    if (k < .7) director.accept({ id: 'n' + n++, kind: 'note', source: 'feed', data: { text: 'c' + n } });
    else if (k < .8) director.accept({ id: 'p' + n++, kind: 'pair', source: 'feed', data: {} });
    else if (k < .82) stage.put({ op: 'POST', actor: 'clerk', dur: .5, frame: 'nowhere', args: { id: 'refused' } });
    director.tick(); stage.tick(); follower.tick();
    peak = Math.max(peak, world.log.events.length); peakCopy = Math.max(peakCopy, copy.log.events.length);
    if (n % 2500 === 0 && k < .8) { const t = follower.clock(); assert.deepEqual(copy.stateAt(t), reference.stateAt(t)); assert.deepEqual(world.stateAt(now()), reference.stateAt(now())); checks++; }
  }
  const h = stage.health();
  ctx.diagnostic(`${reference.log.events.length} events in a day; at most ${peak} in memory on the stage and ${peakCopy} in the follower; ${h.denied} refused; ${checks} comparisons with the full log`);
  assert.ok(reference.log.events.length > 7000, `${reference.log.events.length} events over the day`);
  assert.ok(peak < 80 && peakCopy < 80, `at most ${peak} events in memory on stage, ${peakCopy} in the follower`);
  assert.equal(h.compactRefused, 0); assert.equal(follower.stats.compactRefused, 0); assert.ok(checks >= 2);
  assert.equal(h.folded + h.events, reference.log.events.length, 'every event is either in the base or in the log');
  assert.equal(world.stateAt(now()).count, reference.stateAt(now()).count); assert.ok(world.stateAt(now()).refused > 30);
});

test('a show resumes from its journal after a restart, and a stretch of it can be reopened for export', () => {
  const lines = []; const A = makeShow({ journal: r => lines.push(JSON.stringify(r)) });
  A.stage.mark();
  for (let i = 0; i < 120; i++) { A.advance(1.5); A.director.accept({ id: 'n' + i, kind: 'note', data: { text: 'c' + i } }); A.stage.tick(); if (i % 20 === 19) A.stage.mark(); }
  A.advance(.5); A.director.accept({ id: 'last', kind: 'note', data: { text: 'last' } });   // staged, journaled, not yet in any checkpoint
  const text = lines.join('\n') + '\n{"k":"e","seq":999,"now"';                                // …and the process dies mid-write
  const records = F.parseJournal(text);
  assert.equal(records.filter(r => r.k === 'cp').length, 7);

  // restart: a new process, a new world, the same show
  const B = makeShow(); const cp = [...records].reverse().find(r => r.k === 'cp');
  B.set(Math.max(...records.map(r => r.now))); B.stage.resume(cp, records.filter(r => r.k === 'e'));
  assert.equal(B.stage.seq, A.stage.seq); const t = A.now() + 5;
  assert.deepEqual(B.world.stateAt(t), A.world.stateAt(t), 'including the event staged after the last checkpoint');
  const next = B.director.accept({ id: 'after', kind: 'note', data: { text: 'after' } }).staged[0];
  assert.ok(next.t >= A.world.log.events.at(-1).t + A.world.log.events.at(-1).dur, 'the clerk finishes what was already staged first');
  assert.equal(B.world.log.events.filter(e => e.id === next.id).length, 1, 'new ids do not collide with journaled ones');

  // a clip: seconds 60–90 of the show, reopened from the journal alone
  const C = makeWorld(); const opened = F.openJournal(C, records, { from: 60, to: 90 });
  assert.ok(opened.from <= 60);
  const full = makeWorld(); for (const r of records) if (r.k === 'e') full.log.add(structuredClone(r.e));
  for (const x of [60, 66.6, 75, 89.9]) assert.deepEqual(C.stateAt(x), full.stateAt(x), `clip state at ${x}`);
});
