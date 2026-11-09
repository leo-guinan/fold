// The Week: an edition is a plan; the plan is checked, becomes the same events live and exported, and the
// show's world refuses what the plan can't back up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as F from '../dist/esm/index.js';
import * as W from '../demos/week/dist/show.mjs';
import { checkPlan, parseNewsletter, parseYouTube, postsToReceipts, receiptHash } from '../tools/week.mjs';

const real = () => JSON.parse(fs.readFileSync('demos/week/episodes/2026-11-02.json', 'utf8'));
const receipt = (id, quote) => { const r = { id, kind: 'tweet', date: '2026-11-03', url: 'https://x.com/a/status/' + id, author: '@a', quote }; return { ...r, sha256: receiptHash(r) }; };
const small = () => ({ schema: 'fold.week.v1', title: 'T', week: { from: '2026-11-02', to: '2026-11-09', label: 'w' }, sources: [], receipts: [receipt('r1', 'I will ship it by Friday.'), receipt('r2', 'Shipped.')],
  carried: [{ id: 'p0', text: 'Ship it', due: '2026-11-06', cite: 'r1' }],
  segments: [
    { id: 'recap', kind: 'recap', title: 'What happened', lines: [{ who: 'borges', say: 'He said he would ship it.', cite: 'r1', show: { receipt: 'r1' } }] },
    { id: 'ledger', kind: 'ledger', title: 'Promises', lines: [{ who: 'agnolo', say: 'And he did.', cite: 'r2', verdict: { promise: 'p0', result: 'kept', cite: 'r2' } }] },
    { id: 'ahead', kind: 'ahead', title: 'Ahead', lines: [{ who: 'leonardo', say: 'Next, the same again.', cite: 'r2', promise: { id: 'p1', text: 'Ship again', due: '2026-11-13', cite: 'r2' } }] },
  ] });

test('this week\'s edition is clean: every hash matches its words and the world refuses nothing', async () => {
  const plan = real(), { problems, edition } = await checkPlan(plan);
  assert.deepEqual(problems, []);
  assert.equal(plan.receipts.length, 20); assert.ok(edition.timeline.duration > 240 && edition.timeline.duration < 420);
  assert.equal(F.consistentReplay(edition.world).pass, true); assert.equal(F.deterministic(() => W.makeEdition(real()).world).pass, true);
  for (const who of ['borges', 'leonardo', 'agnolo']) assert.equal(F.oneAtATime(edition.world, who).pass, true, `${who} never talks over himself`);
  const says = edition.world.log.events.filter(e => e.op === 'SAY').sort((a, b) => a.t - b.t);
  for (let i = 1; i < says.length; i++) assert.ok(says[i].t >= says[i - 1].t + says[i - 1].dur, 'nobody talks over anybody');
  const end = edition.world.stateAt(edition.timeline.duration);
  assert.deepEqual(end.ledger.map(p => [p.id, p.verdict?.result ?? null]), [['p-3k', null], ['p-design', 'open'], ['p-traffic', null]]);
  assert.deepEqual(W.openPromises(plan).map(p => p.id), ['p-3k', 'p-design', 'p-traffic'], 'next week carries these');
});

test('the audit finds what would go wrong before it airs', async () => {
  const cases = [
    [p => { p.segments[0].lines[0].cite = 'r9'; p.segments[0].lines[0].show = { receipt: 'r9' }; }, /cites r9, which is not filed/],
    [p => { delete p.segments[0].lines[0].cite; delete p.segments[0].lines[0].show; }, /a recap line with nothing behind it/],
    [p => { p.receipts[0].quote += ' Honest.'; }, /receipt r1: the words don't match the hash/],
    [p => { p.segments[1].lines[0].who = 'borges'; }, /only Agnolo gives verdicts/],
    [p => { p.segments[1].lines = []; }, /carried promise p0 gets no verdict/],
    [p => { p.segments[2].lines[0].promise.cite = 'nope'; }, /promise p1 cites nope/],
    [p => { p.segments.pop(); }, /no week-ahead segment/],
    [p => { p.segments[0].lines[0].say = 'x'.repeat(300); }, /over 240/],
  ];
  assert.deepEqual((await checkPlan(small())).problems, []);
  for (const [breakIt, expected] of cases) { const p = small(); breakIt(p); assert.match((await checkPlan(p)).problems.join('\n'), expected); }
});

test('on air, the world holds the show to its rule even if a plan slips through', () => {
  const world = W.makeWorld(); const at = (t, op, actor, args, dur = 1) => world.emit({ t, dur, op, actor, frame: 'studio', args });
  assert.equal(at(0, 'SAY', 'borges', { text: 'Too early.' }).reason, 'no edition is open');
  at(1, 'OPEN', 'director', { title: 'T', week: {}, sources: [], segments: 1 }); at(1.1, 'FILE', 'director', receipt('r1', 'On the record.'), 0);
  assert.equal(at(2, 'SAY', 'borges', { text: 'He said it.', cite: 'r1' }).result, 'ok');
  assert.equal(at(4, 'SAY', 'borges', { text: 'He also said this.', cite: 'r7' }).reason, 'no receipt on file for that');
  assert.equal(at(5, 'SHOW', 'board', { show: { receipt: 'r7' } }).reason, 'no receipt on file for that');
  assert.equal(at(6, 'PROMISE', 'leonardo', { id: 'p1', text: 'Soon', due: 'x', cite: 'r7' }).reason, 'a promise needs the words it was made in');
  assert.equal(at(7, 'PROMISE', 'leonardo', { id: 'p1', text: 'Soon', due: 'x', cite: 'r1' }).result, 'ok');
  assert.equal(at(9, 'VERDICT', 'leonardo', { promise: 'p1', result: 'kept' }).reason, 'only the one who keeps score gives verdicts');
  assert.equal(at(10, 'VERDICT', 'agnolo', { promise: 'p1', result: 'missed' }).result, 'ok');
  assert.equal(at(11, 'SAY', 'heckler', { text: 'Boo.' }).reason, 'heckler is not in this show');
  const S = world.stateAt(20); assert.equal(S.ledger[0].verdict.result, 'missed'); assert.equal(S.refused.length, 3, 'the last three refusals stay on the page');
  at(30, 'OPEN', 'director', { title: 'Next', week: {}, sources: [], segments: 1 });
  assert.deepEqual([Object.keys(world.stateAt(40).filed).length, world.stateAt(40).ledger.length], [0, 0], 'a new edition clears the desk');
});

test('the same plan is the same show live and exported, and a live edition compacts away behind itself', () => {
  const plan = real(), exported = W.makeEdition(plan); let now = 100;
  const live = W.makeWorld(), stage = new F.Stage(live, { clock: () => now, lead: 1, keep: 30, compactEvery: 5 }), director = new F.Director(stage, { rules: W.RULES });
  const copy = W.makeWorld(), follower = new F.Follower(copy, { delay: .5, local: () => now, keep: 20 }); stage.subscribe(m => follower.receive(m)); follower.receive(stage.hello());
  const aired = director.accept({ id: 'e1', kind: 'week.edition', source: 'test', data: plan });
  assert.equal(aired.skipped, undefined); assert.equal(aired.staged.length, exported.world.log.events.length); assert.equal(stage.health().droppedBeats, 0, 'a five-minute plan is staged whole');
  // the two run on different clocks: compare them with every timestamp moved back to the edition's own start
  const t0 = aired.staged[0].t, shift = (S, by) => JSON.parse(JSON.stringify(S), (k, v) => ((k === 't0' || k === 'closed') && typeof v === 'number' ? +(v - by).toFixed(3) : v));
  let peak = 0;
  for (const dt of [3, 40, 104, 165.5, 240, 300]) {
    while (now < t0 + dt + .5) { now += 1; stage.tick(); follower.tick(); peak = Math.max(peak, copy.log.events.length); }
    const t = follower.clock(); assert.deepEqual(shift(copy.stateAt(t), t0), shift(exported.world.stateAt(t - t0 + .4), .4), `live state at ${dt}s matches the exported edition`);
  }
  assert.equal(stage.health().compactRefused, 0); assert.equal(follower.stats.compactRefused, 0); assert.equal(follower.stats.late, 0);
  assert.ok(stage.health().folded > 60 && live.log.events.length < 30, `${stage.health().folded} events folded away, ${live.log.events.length} left`);
  const bad = structuredClone(plan); bad.segments[1].lines[0].cite = 'r99';
  assert.match(director.accept({ id: 'e2', kind: 'week.edition', source: 'test', data: bad }).skipped, /rule error: plan refused/);
});

test('one segment can be cut out as its own short', () => {
  const edition = W.makeEdition(real(), 'trend'), seg = edition.timeline.segments.find(s => s.id === 'trend');
  assert.ok(Math.abs(edition.duration() - (seg.t1 - seg.t0)) < 1e-9); assert.equal(F.cutFits(edition.cut, edition.timeline.duration + 1).pass, true);
  const first = F.viewAt(edition, 2), last = F.viewAt(edition, edition.duration() - .1);
  assert.equal(first.state.segment.id, 'trend'); assert.equal(last.state.segment.id, 'trend'); assert.deepEqual(edition.layouts.map(l => l.name), ['16x9', '9x16']);
});

test('voices open and close on the words, the same everywhere', () => {
  const text = 'A phrase. Arm the artists.', dur = W.speak(text), levels = Array.from({ length: 60 }, (_, i) => W.voiceLevel(text, dur * i / 60, dur));
  assert.ok(Math.max(...levels) > .6 && levels.filter(v => v === 0).length >= 4, 'loud on syllables, silent at the stops');
  assert.deepEqual(levels, Array.from({ length: 60 }, (_, i) => W.voiceLevel(text, dur * i / 60, dur))); assert.equal(W.voiceLevel(text, dur + 1, dur), 0);
});

test('feeds and archive records become receipts with the Receipt Cuts hash', () => {
  const rss = `<rss><channel><title>The Guide</title><item><title><![CDATA[Everything Last Week Was Wrong]]></title><link>https://example.substack.com/p/wrong</link><dc:creator><![CDATA[Leo Guinan]]></dc:creator><pubDate>Wed, 04 Nov 2026 14:00:00 GMT</pubDate><description><![CDATA[<p>Thank God. &amp; more</p>]]></description></item><item><title>Older</title><link>https://example.substack.com/p/older</link><pubDate>Wed, 21 Oct 2026 14:00:00 GMT</pubDate></item></channel></rss>`;
  const [issue, older] = parseNewsletter(rss);
  assert.deepEqual([issue.kind, issue.date, issue.author, issue.quote, issue.url], ['newsletter', '2026-11-04', 'Leo Guinan', 'Everything Last Week Was Wrong\nThank God. & more', 'https://example.substack.com/p/wrong']);
  assert.equal(issue.sha256, receiptHash(issue)); assert.equal(older.author, 'The Guide');
  const atom = `<feed><entry><yt:videoId>abc123</yt:videoId><title>Leonardo &amp; Borges read a book</title><author><name>Future Radio</name></author><published>2026-11-02T14:30:00+00:00</published><media:group><media:community><media:starRating count="12" average="5.00"/><media:statistics views="431"/></media:community></media:group></entry></feed>`;
  const [video] = parseYouTube(atom);
  assert.deepEqual([video.kind, video.date, video.url, video.quote, video.author, video.views, video.likes], ['video', '2026-11-02', 'https://www.youtube.com/watch?v=abc123', 'Leonardo & Borges read a book', 'Future Radio', 431, 12]);
  const posts = [{ id: '1', url: 'https://x.com/a/status/1', user: 'a', created_at: '2026-11-05T01:28:05.000Z', text: 'Submitted. Now we make it viral.', likes: 1, retweets: 0 },
    { id: '2', url: 'https://x.com/a/status/2', user: 'a', created_at: '2026-11-05T02:00:00.000Z', text: '@b yes', likes: 3, retweets: 1, reply_to: { id: '9' } }, { id: '3', url: 'https://x.com/a/status/3', user: 'a', created_at: '2026-11-06T02:00:00.000Z', text: 'RT @b: hi', likes: 0, retweets: 5, retweet_of: '8' }];
  const got = postsToReceipts(posts, '@a');
  assert.deepEqual([got.stats.posts, got.stats.originals, got.stats.replies, got.stats.reposts, got.stats.likes, got.stats.perDay], [3, 1, 1, 1, 4, { '2026-11-05': 2, '2026-11-06': 1 }]);
  assert.equal(got.stats.top[0].url, 'https://x.com/a/status/2', 'reposts of others are not his best posts');
  // the same format the archive's own receipts use: this hash is the one it returned for this post
  assert.equal(receiptHash({ kind: 'tweet', date: '2026-11-05', url: 'https://x.com/leo_guinan/status/2118153344850006098', quote: 'Submitted. Now we make it viral.' }), 'e21c7fbab01b3595e5df5331b952a3072e848fffdce59f4f147dac9911b5e784');
});
