import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../dist/esm/index.js';

// A tiny world used throughout: a room, actors who can PLACE things in frames they can reach, OPEN frames
// (layout), and MOVE frames. A rule: nothing can be placed in a closed (hidden) frame, and actors must exist.
function makeWorld() {
  const W = new F.World({
    initial: () => ({ things: {}, opened: [] }),
    root: { id: 'room', parent: null, x: 0, y: 0, w: 100, h: 100, lw: 100, lh: 100 },
    rules: [(S, e, ctx) => (e.actor === 'ghost' ? 'no such actor' : undefined)],
    ops: {
      OPEN: {
        layout: { pass: 0, apply(tree, e) { const a = e.args; tree[a.id] = { id: a.id, parent: e.frame, x: a.x, y: a.y, w: a.w, h: a.h, lw: a.lw, lh: a.lh }; } },
        apply(S, e, p) { if (p >= 1) S.opened.push(e.args.id); },
      },
      MOVE: {
        layout: { pass: 1, apply(tree, e, t) { if (e.t > t || !tree[e.target]) return; const k = F.progress(t, e.t, e.dur); tree[e.target].x += e.args.dx * k; if (e.args.close && t >= e.t + e.dur) tree[e.target].hidden = true; } },
      },
      PLACE: {
        check(S, e, ctx) { const f = ctx.frames[e.frame]; return !f ? 'no such frame' : f.hidden ? 'that frame is closed' : null; },
        apply(S, e, p) { S.things[e.target] = { frame: e.frame, at: e.args.at, shown: p }; },
      },
    },
  });
  return W;
}

test('the log keeps time order, then insertion order, and versions every change', () => {
  const L = new F.Log();
  const a = L.add({ t: 2, op: 'X' }), b = L.add({ t: 1, op: 'X' }), c = L.add({ t: 1, op: 'X' });
  assert.deepEqual(L.events.map(e => e.id), [b.id, c.id, a.id]);
  assert.deepEqual(L.inserted.map(e => e.id), ['e1', 'e2', 'e3']);
  assert.equal(L.version, 3);
  const snap = L.snapshot(); const ref = L.events; L.clear(); assert.equal(ref.length, 0, 'arrays are mutated in place');
  L.restore(snap); assert.equal(L.events.length, 3); assert.equal(L.next, 4);
  L.keepUntil(1); assert.equal(L.events.length, 2);
});

test('frames nest: world ↔ local transforms, scale and ancestry', () => {
  const W = makeWorld();
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 10, y: 20, w: 40, h: 40, lw: 200, lh: 200 } });
  W.emit({ t: 1, dur: 1, actor: 'a', op: 'OPEN', frame: 'box', args: { id: 'inner', x: 100, y: 100, w: 50, h: 50, lw: 10, lh: 10 } });
  const T = W.frames();
  assert.deepEqual(F.toWorld(T, 'box', [100, 100]), [30, 40]);
  assert.deepEqual(F.toWorld(T, 'inner', [0, 0]), [30, 40]);
  assert.deepEqual(F.worldTo(T, 'inner', [30, 40]), [0, 0]);
  assert.equal(F.frameScale(T, 'inner'), .2 * 5);
  assert.ok(F.isAncestor(T, 'room', 'inner') && !F.isAncestor(T, 'inner', 'box'));
  assert.equal(T.inner.depth, 2);
  assert.equal(F.pathOf(T, 'inner'), 'room › box › inner');
});

test('layout passes run in order, and frames follow moves over time', () => {
  const W = makeWorld();
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 } });
  W.emit({ t: 2, dur: 2, actor: 'a', op: 'MOVE', target: 'box', frame: 'room', args: { dx: 40, close: true } });
  assert.equal(W.frames(2).box.x, 0);
  assert.equal(W.frames(3).box.x, 20);
  assert.equal(W.frames(4).box.x, 40);
  assert.equal(W.frames(3.9).box.hidden, undefined);
  assert.equal(W.frames(4).box.hidden, true);
});

test('emit checks against the world just before the event; refusals stay in the log', () => {
  const W = makeWorld();
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 } });
  W.emit({ t: 1, dur: 1, actor: 'a', op: 'MOVE', target: 'box', frame: 'room', args: { dx: 5, close: true } });
  const ok = W.emit({ t: 1.5, dur: 1, actor: 'a', op: 'PLACE', target: 'cup', frame: 'box', args: { at: [1, 1] } });
  const late = W.emit({ t: 3, dur: 1, actor: 'a', op: 'PLACE', target: 'pen', frame: 'box', args: { at: [2, 2] } });
  const ghost = W.emit({ t: 3, dur: 1, actor: 'ghost', op: 'PLACE', target: 'pen', frame: 'room', args: { at: [2, 2] } });
  assert.equal(ok.result, 'ok');
  assert.equal(late.result, 'denied'); assert.equal(late.reason, 'that frame is closed');
  assert.equal(ghost.reason, 'no such actor', 'rules run before op checks');
  assert.equal(W.log.events.length, 5);
  const S = W.stateAt(10);
  assert.deepEqual(Object.keys(S.things), ['cup']);
  assert.equal(W.stateAt(2).things.cup.shown, .5);
  assert.equal(F.consistentReplay(W).pass, true, 'verdicts don\'t change with the time you fold to');
});

test("checkFrames: 'fold' reads the fold-time tree (the old, cheaper behaviour)", () => {
  const W = makeWorld(); W.config.checkFrames = 'fold';
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 } });
  W.emit({ t: 1, dur: 1, actor: 'a', op: 'MOVE', target: 'box', frame: 'room', args: { dx: 5, close: true } });
  W.emit({ t: 1.5, dur: 1, actor: 'a', op: 'PLACE', target: 'cup', frame: 'box', args: { at: [1, 1] } });
  assert.equal(W.stateAt(10).things.cup, undefined, 'a check that reads time-varying frames changes its verdict');
  assert.equal(W.report().mismatches.length, 1);
});

test('the fold re-checks every event and reports disagreements with the log', () => {
  const W = makeWorld();
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 } });
  const e = W.emit({ t: 2, dur: 1, actor: 'a', op: 'PLACE', target: 'cup', frame: 'box', args: { at: [1, 1] } });
  assert.equal(F.consistentReplay(W).pass, true);
  // tamper: claim an impossible event was fine
  const forged = W.log.add({ t: 3, dur: 1, actor: 'ghost', op: 'PLACE', target: 'x', frame: 'room', args: { at: [0, 0] } });
  const r = W.report();
  assert.equal(r.mismatches.length, 1); assert.equal(r.mismatches[0].e, forged);
  assert.equal(r.denied.length, 1, 'the forged event is refused on replay');
  assert.equal(W.stateAt(10).things.x, undefined);
  assert.equal(e.result, 'ok');
});

test('state is cached per version and time, and invalidated by any change', () => {
  const W = makeWorld();
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 } });
  const s1 = W.stateAt(5); assert.equal(W.stateAt(5), s1);
  W.emit({ t: 2, dur: 1, actor: 'a', op: 'PLACE', target: 'cup', frame: 'box', args: { at: [1, 1] } });
  assert.notEqual(W.stateAt(5), s1); assert.ok(W.stateAt(5).things.cup);
});

test('bindFrames lets a host follow the fold (and is restored after)', () => {
  let current = 'none';
  const W = new F.World({ initial: () => ({ seen: [] }), root: { id: 'r', parent: null, x: 0, y: 0, w: 1, h: 1, lw: 1, lh: 1 },
    bindFrames(tree) { const prev = current; current = tree; return () => { current = prev; }; },
    ops: { LOOK: { apply(S) { S.seen.push(typeof current); } } } });
  W.emit({ t: 0, dur: 0, actor: 'a', op: 'LOOK', frame: 'r', args: {} });
  assert.deepEqual(W.stateAt(1).seen, ['object']);
  assert.equal(current, 'none');
});

test('tracks ease between keys and hold at the ends', () => {
  const T = new F.Track([], { fallback: [1, 0, 0] });
  assert.deepEqual(T.at(3), [1, 0, 0]);
  T.add([0, 1, 0, 0], [2, 3, 10, 20]).sort();
  assert.deepEqual(T.at(-1), [1, 0, 0]);
  assert.deepEqual(T.at(1), [2, 5, 10]);
  assert.deepEqual(T.at(9), [3, 10, 20]);
  assert.deepEqual(F.cameraMatrix([2, 100, 50], { w: 200, h: 100 }, 1.5), [3, 0, 0, 3, 1.5 * (100 - 200), 1.5 * (50 - 100)]);
});

test('timelines and envelopes: who is speaking, and how loudly', () => {
  const lines = [{ t0: 1, t1: 2, who: 'A', env: '09' }, { t0: 2.5, t1: 3, who: 'B', env: [0, 1, .5] }];
  const E = new F.Envelopes(lines, 2);
  assert.equal(E.level('A', 1), 0); assert.equal(E.level('A', 1.25), .5); assert.equal(E.level('A', 1.5), 1);
  assert.equal(E.level('B', 1.5), 0, 'only the line\'s speaker');
  assert.equal(E.level('B', 2.75), .5); assert.equal(E.level('B', 2.875), .75);
  assert.ok(E.active('A', 1.9) && !E.active('A', 2));
  assert.equal(E.speaker(2.6), 'B');
  const TL = new F.Timeline([[0, 1, 'x'], [1, 2, 'y']], { t0: s => s[0], t1: s => s[1] });
  assert.equal(TL.at(1.95)[2], 'y'); assert.equal(TL.at(1.95, .1), undefined); assert.equal(TL.end, 2);
  assert.equal(F.quantizeEnvelope([0, 5, 10, 10]), '0599');
});

test('the stager puts beats on cue, one at a time, and records slips', () => {
  const W = makeWorld(); const st = new F.Stager(W, { defaults: { actor: 'a', frame: 'room' }, gap: .5, tolerance: 1 });
  const a = st.at(0, { dur: 2, op: 'OPEN', args: { id: 'b1', x: 0, y: 0, w: 1, h: 1, lw: 1, lh: 1 } });
  const b = st.at(1, { dur: 1, op: 'OPEN', args: { id: 'b2', x: 0, y: 0, w: 1, h: 1, lw: 1, lh: 1 } });
  const c = st.at(2, { dur: 1, op: 'OPEN', args: { id: 'b3', x: 0, y: 0, w: 1, h: 1, lw: 1, lh: 1 } });
  assert.equal(a.t, 0); assert.equal(b.t, 2.5); assert.equal(c.t, 4);
  assert.deepEqual(st.slips.map(s => s.slice(1)), [[1, 2.5], [2, 4]]);
  assert.equal(F.oneAtATime(W, 'a').pass, true);
  assert.equal(F.onCue(st.slips).pass, false);
});

test('cuts map output time to scene time, shot by shot', () => {
  const C = new F.Cut({ shots: [{ T0: 0, T1: 2, src0: 10, rate: 1 }, { T0: 2, T1: 3, src0: 50, rate: 3, cams: { tall: [2, 5, 5] } }] });
  assert.equal(C.end, 3);
  assert.deepEqual(C.map(1.5).t, 11.5);
  assert.equal(C.map(2.5).t, 51.5);
  assert.equal(C.map(9).shot, C.shots[1]);
  assert.deepEqual(C.seams(), []);
  assert.equal(F.cutFits(C, 60).pass, true);
  assert.equal(F.cutFits(C, 52).pass, false);
});

test('layouts: full stage and centre column', () => {
  const L = F.centreColumn('9x16', { w: 1280, h: 720 }, 9 / 16, { w: 1080, h: 1920 });
  assert.deepEqual(L.crop, { x: 437.5, y: 0, w: 405, h: 720 });
  assert.deepEqual(F.fullStage('16x9', { w: 1280, h: 720 }, { w: 1920, h: 1080 }).crop, { x: 0, y: 0, w: 1280, h: 720 });
});

test('viewAt resolves cut, state, frames and camera without drawing', () => {
  const W = makeWorld();
  W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 } });
  const cam = new F.Track([[0, 1, 50, 50], [10, 2, 50, 50]]);
  const tall = F.centreColumn('tall', { w: 100, h: 100 }, .5, { w: 50, h: 100 });
  const P = { world: W, stage: { w: 100, h: 100 }, duration: () => 4, camera: cam, cut: new F.Cut({ shots: [{ T0: 0, T1: 4, src0: 5, rate: 1, cams: { tall: [3, 1, 1] } }] }) };
  const v = F.viewAt(P, 1); assert.equal(v.t, 6); assert.deepEqual(v.camera, [1 + ((6 - 0) / 10 < .5 ? 2 * .6 * .6 : 1 - Math.pow(-2 * .6 + 2, 2) / 2), 50, 50]);
  assert.deepEqual(F.viewAt(P, 1, { layout: tall }).camera, [3, 1, 1]);
  assert.ok(v.frames.box && v.state.opened.includes('box'));
});

test('audits: determinism, captions, continuity', () => {
  const build = () => { const W = makeWorld(); W.emit({ t: 0, dur: 1, actor: 'a', op: 'OPEN', frame: 'room', args: { id: 'box', x: 0, y: 0, w: 10, h: 10, lw: 10, lh: 10 } }); return W; };
  assert.equal(F.deterministic(build).pass, true);
  const caps = new F.Timeline([{ t0: 0, t1: 1 }]);
  assert.equal(F.captioned([{ t0: 0, t1: 1 }, { t0: 5, t1: 6 }], caps).pass, false);
  assert.equal(F.continuous(t => [t * 10, 0], [1], 100, .2).pass, true);
  assert.equal(F.continuous(t => [t < 1 ? 0 : 50, 0], [1], 100, 5).pass, false);
});

test('WAV encoding: header, normalization ceiling, clipping', () => {
  const ch = [new Float32Array([0, 1, -1, .5]), new Float32Array([0, -.5, 2, 0])];
  const { wav, peak } = F.encodeWav({ numberOfChannels: 2, length: 4, sampleRate: 8000, getChannelData: c => ch[c] }, .89);
  const dv = new DataView(wav);
  assert.equal(String.fromCharCode(...new Uint8Array(wav, 0, 4)), 'RIFF');
  assert.equal(dv.getUint16(22, true), 2); assert.equal(dv.getUint32(24, true), 8000); assert.equal(dv.getUint32(40, true), 16);
  assert.equal(peak, 2);
  assert.equal(dv.getInt16(44 + 2 * 4, true), Math.trunc(-1 * .445 * 32767), 'scaled by .89/peak');
  assert.equal(wav.byteLength, 44 + 16);
});

test('seeded randomness is repeatable', () => {
  const a = F.rng(42), b = F.rng(42); const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]); assert.ok(xs.every(x => x >= 0 && x < 1));
});
