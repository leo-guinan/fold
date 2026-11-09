#!/usr/bin/env node
// Stills of any engine page at chosen times, in a layout, plus a contact sheet.
//   node tools/stills.mjs <page> --times 1,2.5,8 --out out/stills [--layout 16x9] [--scale 1]
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { openPage } from './page.mjs';
const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const P = await openPage(argv[0], { scale: +opt('scale', 1) }); const out = opt('out', 'out/stills'); fs.mkdirSync(out, { recursive: true });
try {
  const layouts = await P.H('layouts'); const L = layouts.find(l => l.name === opt('layout', layouts[0]?.name));
  if (L) await P.H('setLayout', L.name);
  const dur = await P.H('duration'); const times = opt('times') ? opt('times').split(',').map(Number) : Array.from({ length: 8 }, (_, i) => +(dur * (i + .5) / 8).toFixed(2));
  const k = P.surf.scale; const crop = L ? L.crop : { x: 0, y: 0, w: P.surf.w, h: P.surf.h }; const files = [];
  for (const t of times) {
    await P.H('seek', t); const f = path.join(out, `${L ? L.name + '-' : ''}${t.toFixed(2)}.png`);
    await P.page.screenshot({ path: f, clip: { x: crop.x, y: crop.y, width: crop.w, height: crop.h } }); files.push(f);
  }
  const cols = Math.min(4, files.length); const sheet = path.join(out, `${L ? L.name + '-' : ''}contact.png`);
  spawnSync('ffmpeg', ['-v', 'error', '-y', ...files.flatMap(f => ['-i', f]), '-filter_complex', `${files.map((_, i) => `[${i}:v]scale=480:-2[s${i}]`).join(';')};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % cols) ? Array.from({ length: i % cols }, () => 'w0').join('+') : '0'}_${Math.floor(i / cols) ? Array.from({ length: Math.floor(i / cols) }, () => 'h0').join('+') : '0'}`).join('|')}:fill=black`, sheet], { stdio: 'inherit' });
  console.log(`${files.length} stills → ${out}`); if (P.errors.length) console.error('page errors:', P.errors);
} finally { await P.close(); }
