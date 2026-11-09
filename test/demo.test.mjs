// The demo scene passes the audits any production should pass, independent of how it's drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../dist/esm/index.js';
import * as D from '../demos/two-builders/dist/scene.mjs';

test('two-builders: the replay agrees with the log; exactly one refusal, for the right reason', () => {
  const P = D.makeProduction(); const r = P.world.report();
  assert.equal(F.consistentReplay(P.world).pass, true);
  assert.deepEqual(r.denied.map(d => [d.e.target, d.reason]), [['coreB', 'that drawer is closed']]);
});
test('two-builders: the maker does one thing at a time, on cue', () => {
  const P = D.makeProduction();
  assert.equal(F.oneAtATime(P.world, 'maker').pass, true); assert.equal(F.onCue(P.slips).pass, true);
});
test('two-builders: deterministic, captioned, and the teaser fits inside the scene', () => {
  assert.equal(F.deterministic(() => D.makeProduction().world).pass, true);
  assert.equal(F.captioned(D.LINES, D.CAPTIONS).pass, true);
  assert.equal(F.cutFits(D.TEASER, D.SCENE_END).pass, true);
});
test('two-builders: a speaker\'s level is zero outside their lines and moves inside them', () => {
  for (const L of D.LINES) {
    assert.equal(D.ENVELOPES.level(L.who, L.t0 - .01), 0);
    const levels = Array.from({ length: 30 }, (_, i) => D.ENVELOPES.level(L.who, L.t0 + (L.t1 - L.t0) * i / 30));
    assert.ok(Math.max(...levels) > .6 && Math.min(...levels) < .2, `${L.who} opens and closes`);
  }
});
test('two-builders: the drawer is hidden after it closes, and its contents with it', () => {
  const P = D.makeProduction(); const T = P.world.frames(12);
  assert.equal(T.drawer.hidden, true); assert.ok(T.drawer.y < 500 - 140, 'it slid up under the bench');
  assert.equal(P.world.stateAt(12).things.coreA.frame, 'drawer');
});
