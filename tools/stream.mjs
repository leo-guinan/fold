#!/usr/bin/env node
// Broadcast a live page: picture and sound, in real time, to an RTMP ingest (or a file, to check it first).
//   node tools/stream.mjs <page url> --to rtmp://…/key | out.flv | out.mp4 [--fps 30] [--vb 4500k] [--scale 1] [--seconds N]
//
// The page is opened in headless Chromium with ?stream (sound may start without a click). Its own hook,
// __fold.captureStream(), gives the canvas and the audio as one media stream; a MediaRecorder in the page
// cuts that into short WebM chunks, and ffmpeg re-encodes them as H.264/AAC for the ingest. Unlike
// tools/export.mjs this runs at the speed of the clock, not frame by frame: it is for shows that never end.
//
// It is built to be left running. If the page stops sending, the browser dies or ffmpeg exits, everything
// is torn down and started again after a pause. The page is only a follower, so nothing is lost: it greets
// the control room, gets the world as it is now, and carries on.
import { spawn } from 'node:child_process'; import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const pageUrl = argv[0], to = opt('to');
if (!pageUrl || !to) { console.error('usage: stream.mjs <page url> --to rtmp://…|file [--fps 30] [--vb 4500k] [--scale 1] [--seconds N]'); process.exit(2); }
const fps = +opt('fps', 30), vb = opt('vb', '4500k'), scale = +opt('scale', 1), seconds = opt('seconds') ? +opt('seconds') : Infinity;
const log = (...a) => console.error(new Date().toISOString(), ...a);
const format = /^rtmps?:/.test(to) ? 'flv' : to.endsWith('.mp4') ? 'mp4' : to.endsWith('.mkv') ? 'matroska' : 'flv';
let stopping = false, finish = () => {};
process.once('SIGINT', () => { stopping = true; finish(); }); process.once('SIGTERM', () => { stopping = true; finish(); });

/** One run: open the page, record, pipe to ffmpeg. Resolves with why it ended. */
async function run() {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  let ff = null, watchdog = null;
  try {
    const sep = pageUrl.includes('?') ? '&' : '?', url = `${pageUrl}${sep}stream&scale=${scale}`;
    const probe = await browser.newPage(); await probe.goto(url); await probe.waitForFunction(() => globalThis.__fold?.ready, null, { timeout: 60000 });
    const surf = await probe.evaluate(() => globalThis.__fold.surface()); await probe.close();
    const page = await (await browser.newContext({ viewport: { width: Math.ceil(surf.w), height: Math.ceil(surf.h) }, deviceScaleFactor: 1 })).newPage();
    page.on('pageerror', e => log('page error:', String(e)));
    let ended; const done = new Promise(r => { ended = r; }); finish = () => ended('stopped');
    page.on('crash', () => ended('the page crashed')); browser.on('disconnected', () => ended('the browser closed'));
    let last = Date.now(), bytes = 0;
    await page.exposeFunction('__foldChunk', b64 => {
      const buf = Buffer.from(b64, 'base64'); last = Date.now(); bytes += buf.length;
      if (ff && ff.stdin.writable) ff.stdin.write(buf);
    });
    await page.goto(url); await page.waitForFunction(() => globalThis.__fold?.ready, null, { timeout: 60000 });
    const audio = await page.evaluate(async ([fps, bits]) => {
      const stream = globalThis.__fold.captureStream(fps), hasAudio = stream.getAudioTracks().length > 0;
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits, audioBitsPerSecond: 160000 });
      let chain = Promise.resolve();   // chunks must leave in the order they were cut
      rec.ondataavailable = ev => { chain = chain.then(async () => { const u = new Uint8Array(await ev.data.arrayBuffer()); let bin = ''; for (let i = 0; i < u.length; i += 32768) bin += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); await globalThis.__foldChunk(btoa(bin)); }); };
      rec.start(250); globalThis.__foldRecorder = rec;
      return hasAudio;
    }, [fps, 12_000_000]);

    const args = ['-v', 'warning', '-y', '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0'];
    if (!audio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');   // ingests expect an audio track
    args.push('-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0', '-vf', `fps=${fps},scale=in_range=full:out_range=limited,format=yuv420p`,   // Chromium records full-range VP8 without saying so
     
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', vb, '-maxrate', vb, '-bufsize', String(parseInt(vb) * 2) + 'k', '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2');
    if (seconds !== Infinity) args.push('-t', String(seconds));
    if (format === 'mp4') args.push('-movflags', '+faststart');
    args.push('-f', format, to);
    ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    ff.stdin.on('error', () => {}); ff.on('close', code => ended(seconds !== Infinity && code === 0 ? 'done' : `ffmpeg exited (${code})`));
    log(`on air: ${surf.w}×${surf.h} @ ${fps} fps, ${audio ? 'with sound' : 'silent (no audio track from the page)'} → ${to}`);
    watchdog = setInterval(() => {
      if (Date.now() - last > 10000) ended('the page stopped sending');
      page.evaluate(() => globalThis.__fold.health?.()).then(h => log(`${(bytes / 1048576).toFixed(1)} MB sent`, h ? JSON.stringify(h) : ''), () => {});
    }, 30000);
    const why = await done;
    await page.evaluate(() => globalThis.__foldRecorder?.stop()).catch(() => {});
    return why;
  } finally {
    clearInterval(watchdog);
    if (ff) { ff.stdin.end(); await new Promise(r => { ff.once('close', r); setTimeout(() => { ff.kill('SIGKILL'); r(); }, 5000); if (ff.exitCode != null) r(); }); }
    await browser.close().catch(() => {});
  }
}

for (let pause = 2000; ; pause = Math.min(pause * 2, 60000)) {
  const began = Date.now(); let why;
  try { why = await run(); } catch (err) { why = err.message; }
  if (why === 'done' || stopping) { log('off air:', why); break; }
  if (Date.now() - began > 120000) pause = 2000;   // it ran for a while: this is a new problem, not the same one
  log(`off air: ${why}. Back in ${pause / 1000} s.`);
  await new Promise(r => setTimeout(r, pause));
}
process.exit(0);
