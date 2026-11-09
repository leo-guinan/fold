// The control room as a process: signals in, a feed out, and the same show after it is killed and restarted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import * as F from '../dist/esm/index.js';
import * as D from '../demos/live-desk/dist/show.mjs';

const freePort = () => new Promise(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function startRoom(port, journal) {
  const child = spawn(process.execPath, ['tools/room.mjs', 'demos/live-desk/dist/show.mjs', '--port', String(port), '--journal', journal], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 50)); }
  child.kill('SIGKILL'); throw new Error('the room did not start');
}
const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/signal`, { method: 'POST', body: JSON.stringify(body), headers });
/** Read the feed until `done(messages)` says enough. */
async function readFeed(port, done) {
  const ctl = new AbortController(), res = await fetch(`http://127.0.0.1:${port}/feed`, { signal: ctl.signal }); const out = []; let buf = ''; const dec = new TextDecoder();
  try { for await (const c of res.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { out.push(JSON.parse(buf.slice(5, i))); buf = buf.slice(i + 2); if (done(out)) { ctl.abort(); return out; } } } } catch (e) { if (!ctl.signal.aborted) throw e; }
  return out;
}

test('the room stages signals, feeds followers, and carries on after being killed', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-room-')), journal = path.join(dir, 'show.ndjson'), port = await freePort();
  let room = await startRoom(port, journal);
  try {
    const note = (id, title) => ({ id, kind: 'note', source: 'test', data: { title, text: 'one line\nanother' } });
    const first = await (await post(port, [note('n1', 'First'), note('n1', 'First again'), { id: 'x', kind: 'note', source: 'test', data: { title: '' } }])).json();
    assert.equal(first.results[0].staged[0].result, 'ok'); assert.ok(first.results[0].staged[0].t > first.now + .9, 'staged a lead ahead of now');
    assert.equal(first.results[1].skipped, 'duplicate'); assert.equal(first.results[2].staged[0].reason, 'a card needs a headline');
    assert.equal((await post(port, note('n2', 'From a web page'), { origin: 'http://somewhere.example' })).status, 403, 'a browser page cannot put words on air');

    // a follower joins late, gets the whole world, then hears the next event and the clock
    const world = D.makeWorld(), follower = new F.Follower(world, { delay: .5 });
    const heard = await readFeed(port, m => { if (m.length === 1) void post(port, note('n3', 'While you were watching')); return m.some(x => x.type === 'event') && m.some(x => x.type === 'tick'); });
    assert.equal(heard[0].type, 'hello'); for (const m of heard) follower.receive(m);
    assert.equal(follower.needsHello, false);
    const at = heard.find(m => m.type === 'event').e.t + 2;
    assert.deepEqual(world.stateAt(at).cards.map(c => c.title), ['First', 'While you were watching']); assert.equal(world.stateAt(at).refused.length, 1);

    // kill it without warning, just after staging something it has not yet saved
    await post(port, note('n4', 'Staged just before the crash')); room.kill('SIGKILL'); await new Promise(r => room.once('exit', r));
    fs.appendFileSync(journal, '{"k":"e","seq":99,"now"');   // and it died mid-write
    room = await startRoom(port, journal);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.stage.seq, 4, 'four events were staged before the crash (one of them refused), and it remembers all four');
    const after = await (await post(port, note('n5', 'After the restart'))).json();
    assert.equal(after.results[0].staged[0].id, 'e5', 'ids carry on'); assert.ok(after.now > first.now, 'show time moved on');
    const again = D.makeWorld(), f2 = new F.Follower(again); for (const m of await readFeed(port, m => m.length >= 1)) f2.receive(m);
    assert.deepEqual(again.stateAt(after.now + 5).cards.map(c => c.title), ['First', 'While you were watching', 'Staged just before the crash', 'After the restart']);

    // the journal alone is enough to re-render any stretch of the show
    const text = await (await fetch(`http://127.0.0.1:${port}/journal?from=0&to=${after.now + 5}`)).text();
    const replay = D.makeWorld(); assert.ok(F.openJournal(replay, F.parseJournal(text), { from: 0, to: after.now + 5 }));
    assert.deepEqual(replay.stateAt(after.now + 5), again.stateAt(after.now + 5));
  } finally { room.kill('SIGKILL'); }
});
