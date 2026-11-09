// Both demo styles render the same production: frames are deterministic per style, different across styles,
// and the export hooks behave. Skipped when Playwright isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import crypto from 'node:crypto';
let openPage = null; try { createRequire(import.meta.url)('playwright'); ({ openPage } = await import('../tools/page.mjs')); } catch { /* no playwright */ }
const hash = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

test('both styles draw the same scene, deterministically and differently', { skip: !openPage && 'playwright not installed' }, async () => {
  const shots = {};
  for (const style of ['geometric', 'terminal']) {
    const P = await openPage(`demos/two-builders/index.html?style=${style}`);
    try {
      assert.equal(await P.H('duration'), 16); assert.deepEqual((await P.H('layouts')).map(l => l.name), ['16x9', '9x16']);
      const grab = async t => { await P.H('seek', t); return hash(await P.page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } })); };
      shots[style] = [await grab(4.5), await grab(10.9)];
      assert.equal(await grab(4.5), shots[style][0], `${style}: same time, same pixels`);
      assert.notEqual(shots[style][0], shots[style][1]);
      assert.deepEqual(P.errors, []);
    } finally { await P.close(); }
  }
  assert.notEqual(shots.geometric[0], shots.terminal[0]);
});

test('the teaser renders its own audio, cut with the picture', { skip: !openPage && 'playwright not installed' }, async () => {
  const P = await openPage('demos/two-builders/index.html?style=terminal&cut=teaser');
  try {
    const r = await P.page.evaluate(() => globalThis.__fold.renderAudio(16000));
    assert.ok(Math.abs(r.dur - 6.9) < .01 && r.peak > .05, `audio ${r.dur}s peak ${r.peak}`);
  } finally { await P.close(); }
});
