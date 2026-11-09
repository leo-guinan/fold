#!/usr/bin/env node
// The control room: the one process that writes a live show's log.
//   node tools/room.mjs <show.mjs> [--port 8790] [--journal data/show.ndjson] [--signals <sse url>]… [--lead 1] [--keep 30]
//
// It loads a show (its world, and its rules for what signals mean), takes signals in, stages them as events
// a moment in the future, and serves the result as a feed that any number of renderers follow.
//
//   POST /signal    a signal, or a list of them: { id, kind, source?, at?, data }   (local clients only)
//   GET  /feed      server-sent events: hello (the whole world), then each event and a clock tick a second
//   GET  /health    what the stage, the director and the signal sources are doing
//   GET  /journal   the journal, or with ?from=&to= (show seconds) just enough of it to re-render that stretch
//   GET  /…         files from the repo, so a show's page can be opened from the same origin
//
// Every event is journaled as it is staged, and the world is saved every two seconds, so the show carries
// on after a restart: show time has moved on by however long the room was down, the same cards are on the
// desk, and nothing is staged twice.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import { pathToFileURL } from 'node:url';
import { Stage, Director, parseJournal } from '../dist/esm/index.js';
import { sendFile, repoRoot } from './serve.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const all = k => argv.flatMap((a, i) => (a === '--' + k ? [argv[i + 1]] : []));
const showPath = argv[0];
if (!showPath || showPath.startsWith('--')) { console.error('usage: room.mjs <show.mjs> [--port 8790] [--journal file.ndjson] [--signals <sse url>]… [--lead 1] [--keep 30]'); process.exit(2); }
const PORT = +opt('port', 8790), HOST = opt('host', '127.0.0.1'), JOURNAL = opt('journal') ? path.resolve(opt('journal')) : null, LATEST = JOURNAL ? JOURNAL + '.latest.json' : null;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- the show ----------
const show = (await import(pathToFileURL(path.resolve(showPath)).href)).makeShow();
let base = 0, started = performance.now(); const clock = () => base + (performance.now() - started) / 1000;
let journal = null;   // a file descriptor: records are written before the signal is answered, so a kill can't lose one
if (JOURNAL) {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  // a crash mid-write leaves half a line: start the next record on a line of its own
  let torn = false;
  if (fs.existsSync(JOURNAL) && fs.statSync(JOURNAL).size > 0) { const fd = fs.openSync(JOURNAL, 'r'), last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, fs.statSync(JOURNAL).size - 1); fs.closeSync(fd); torn = last[0] !== 10; }
  journal = fs.openSync(JOURNAL, 'a'); if (torn) fs.writeSync(journal, '\n');
}
const stage = new Stage(show.world, { clock, lead: +opt('lead', 1), keep: +opt('keep', 30), journal: journal != null ? r => fs.writeSync(journal, JSON.stringify(r) + '\n') : undefined });
const cursors = {};   // where each signal source had got to (its last event id)

// carry on from the last run, if there was one: from the latest save, or failing that the journal's last checkpoint
if (JOURNAL && fs.statSync(JOURNAL).size > 0) {
  try {
    const size = fs.statSync(JOURNAL).size, tailBytes = Math.min(size, 8 << 20), buf = Buffer.alloc(tailBytes);
    fs.readSync(fs.openSync(JOURNAL, 'r'), buf, 0, tailBytes, size - tailBytes);
    const tail = parseJournal(buf.toString('utf8'));
    let saved = [...tail].reverse().find(r => r.k === 'cp') ?? null;
    if (fs.existsSync(LATEST)) { try { const latest = JSON.parse(fs.readFileSync(LATEST, 'utf8')); if (!saved || latest.now >= saved.now) saved = latest; } catch { /* a bad save: use the journal */ } }
    if (saved) {
      const later = tail.filter(r => r.k === 'e' && r.seq > saved.seq);   // staged after that save
      // show time keeps pace with the wall clock across the gap, so renderers that kept running don't see time
      // step backwards; whatever was staged for the gap has simply already happened
      base = Math.max(saved.now + Math.max(0, Date.now() - saved.wall) / 1000, ...later.map(r => r.now));
      stage.resume(saved, later); Object.assign(cursors, saved.cursors || {});
      log(`resumed at show time ${base.toFixed(1)} s, seq ${stage.seq} (${later.length} events from the journal's tail)`);
    }
  } catch (err) { log('could not resume, starting a new show:', err.message); }
}
const director = new Director(stage, { rules: show.rules, idle: show.idle, perMinute: show.perMinute, remember: show.remember });
stage.mark();

function save() {
  if (!LATEST) return;
  const rec = { k: 'cp', seq: stage.seq, now: clock(), wall: Date.now(), cp: show.world.checkpoint(), cursors };
  fs.writeFileSync(LATEST + '.tmp', JSON.stringify(rec)); fs.renameSync(LATEST + '.tmp', LATEST);   // whole or not at all
}
let ticks = 0;
const timer = setInterval(() => {
  try {
    director.tick(); const r = stage.tick(); ticks++;
    if (r && !r.ok) log('compaction refused:', r.reason);
    if (ticks % 2 === 0) save();
    if (ticks % 60 === 0) stage.mark();
  } catch (err) { log('tick failed:', err.message); }
}, 1000);

// ---------- signal sources: other servers' event streams ----------
const sources = all('signals').map(url => ({ url, connected: false, received: 0, lastError: null }));
async function follow(src) {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 30000)) {
    try {
      const headers = { accept: 'text/event-stream' }; if (cursors[src.url]) headers['last-event-id'] = String(cursors[src.url]);
      const res = await fetch(src.url, { headers }); if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      src.connected = true; src.lastError = null; wait = 1000; log('signals: connected to', src.url);
      let buf = ''; const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let id = null; const data = [];
          for (const line of block.split('\n')) { if (line.startsWith('id:')) id = line.slice(3).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
          if (!data.length) continue;
          try { const msg = JSON.parse(data.join('\n')); const r = director.accept(msg.signal ?? msg); src.received++; if (r.skipped) log(`signals: skipped (${r.skipped})`); } catch { /* not a signal */ }
          if (id != null) cursors[src.url] = id;
        }
      }
      throw new Error('stream ended');
    } catch (err) { src.connected = false; src.lastError = err.message; }
    await new Promise(r => setTimeout(r, wait));
  }
}
for (const s of sources) void follow(s);

// ---------- http ----------
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/feed') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const send = m => res.write(`data: ${JSON.stringify(m)}\n\n`);
      send(stage.hello()); const off = stage.subscribe(send); req.on('close', off); return;
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, stage: stage.health(), director: director.stats, sources, journal: JOURNAL });
    if (req.method === 'POST' && url.pathname === '/signal') {
      // a page in someone's browser must not be able to put words on air: local, non-browser clients only
      if (!local(req) || req.headers.origin) return json(res, 403, { error: 'signals are accepted from local non-browser clients only' });
      let body = ''; for await (const c of req) { body += c; if (body.length > 65536) return json(res, 413, { error: 'too large' }); }
      let input; try { input = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      const results = (Array.isArray(input) ? input : [input]).slice(0, 50).map(s => { const r = director.accept(s); return { id: s?.id ?? null, staged: r.staged.map(e => ({ id: e.id, t: e.t, result: e.result, reason: e.reason })), skipped: r.skipped }; });
      return json(res, 200, { now: clock(), results });
    }
    if (req.method === 'GET' && url.pathname === '/journal') {
      if (!JOURNAL || !fs.existsSync(JOURNAL)) return json(res, 404, { error: 'no journal' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      if (!url.searchParams.has('from')) { fs.createReadStream(JOURNAL).pipe(res); return; }
      // the last checkpoint at or before `from`, then every event up to `to`
      const from = +url.searchParams.get('from'), to = +(url.searchParams.get('to') ?? Infinity); let cp = null; const events = [];
      for await (const line of readline.createInterface({ input: fs.createReadStream(JOURNAL) })) {
        if (line.startsWith('{"k":"cp"')) { try { const r = JSON.parse(line); if (r.now <= from || !cp) { cp = line; events.length = 0; } } catch { /* torn */ } }
        else if (line.startsWith('{"k":"e"')) { try { if (JSON.parse(line).e.t <= to) events.push(line); } catch { /* torn */ } }
      }
      res.end([cp, ...events].filter(Boolean).join('\n') + '\n'); return;
    }
    if (req.method === 'GET') return sendFile(repoRoot, req, res);
    json(res, 405, { error: 'method not allowed' });
  } catch (err) { log('request failed:', err.message); if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end(); }
});
server.listen(PORT, HOST, () => log(`control room on http://${HOST}:${PORT}  (feed: /feed, signals: POST /signal, health: /health)`));

let closing = false;
function stop() {
  if (closing) return; closing = true; clearInterval(timer);
  try { save(); stage.mark(); } catch { /* best effort */ }
  server.closeAllConnections?.(); server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
// a rule or an op that throws is a bug in the show, not a reason to go off the air
process.on('uncaughtException', err => log('uncaught:', err.stack || err.message));
process.on('unhandledRejection', err => log('unhandled:', err?.stack || err));
