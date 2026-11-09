#!/usr/bin/env node
// Frame-exact MP4 export of any engine page, in any of its layouts, with the page's own audio.
//   node tools/export.mjs <page> --out out/film.mp4 [--layout 16x9] [--fps 30] [--start 0] [--end D] [--scale 2] [--audio file.wav|none]
// The page draws each frame at its exact time through the hooks (seek), so the result doesn't depend on
// how fast the machine is. The layout's crop is cut from the stage at the render scale, then sized to the output.
import { spawn, spawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { openPage } from './page.mjs';
const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const pagePath = argv[0]; const out = opt('out'); if (!pagePath || !out) { console.error('usage: export.mjs <page> --out file.mp4 [--layout name] [--fps 30] [--start s] [--end s] [--scale k] [--audio file|none]'); process.exit(2); }
const fps = +opt('fps', 30);
const P = await openPage(pagePath, { scale: +opt('scale', 2) });
try {
  const layouts = await P.H('layouts'); const L = layouts.find(l => l.name === opt('layout', layouts[0]?.name)) || null;
  if (L) await P.H('setLayout', L.name);
  const dur = await P.H('duration'); const start = +opt('start', 0), end = Math.min(+opt('end', dur), dur);
  const k = P.surf.scale; const crop = L ? L.crop : { x: 0, y: 0, w: P.surf.w, h: P.surf.h };
  const outSize = L ? L.output : { w: Math.round(P.surf.w * k), h: Math.round(P.surf.h * k) };
  const vf = `crop=${Math.round(crop.w * k)}:${Math.round(crop.h * k)}:${Math.round(crop.x * k)}:${Math.round(crop.y * k)},scale=${outSize.w}:${outSize.h}:flags=lanczos`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-export-')); const vid = path.join(tmp, 'v.mp4');
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', vid], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((end - start) * fps);
  for (let i = 0; i < n; i++) {
    await P.H('seek', start + i / fps);
    const jpg = await P.page.screenshot({ type: 'jpeg', quality: 95, clip: { x: 0, y: 0, width: P.surf.w, height: P.surf.h } });
    if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % (fps * 5) === 0) process.stdout.write(`\r${(i / fps).toFixed(0)}/${(n / fps).toFixed(0)} s`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r)); process.stdout.write('\n');
  let audio = opt('audio');
  if (!audio && (await P.page.evaluate(() => !!globalThis.__fold.renderAudio))) {
    const r = await P.page.evaluate(() => globalThis.__fold.renderAudio(48000)); audio = path.join(tmp, 'a.wav'); fs.writeFileSync(audio, Buffer.from(r.b64, 'base64'));
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const mux = ['-v', 'error', '-y', '-i', vid];
  if (audio && audio !== 'none') mux.push('-ss', String(start), '-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  spawnSync('ffmpeg', [...mux, '-c:v', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' });
  console.log(`wrote ${out} (${L ? L.name + ', ' : ''}${outSize.w}×${outSize.h}, ${(end - start).toFixed(2)} s)`);
  if (P.errors.length) console.error('page errors:', P.errors);
} finally { await P.close(); }
