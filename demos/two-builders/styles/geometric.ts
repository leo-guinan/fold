/** Geometric: flat shapes, soft shadows, a warm palette. Everything it knows about the scene comes from the
 * view (state, frames, camera, layout) and the production (captions, envelopes). */

import { clamp, smooth, toWorld, type FrameTree, type Production, type Style, type Surface, type View } from '../../../src/index.js';
import { drawOrder, type SceneState, type Thing } from '../scene.js';

const C = { bg: '#efe6d6', floor: '#e2d5bf', ink: '#2b2622', frame: '#fffaf1', frameEdge: '#c9b79c', maker: '#e0703b', guest: '#3d8a8f', machine: '#5d6b8a', screen: '#1f2433', lit: '#ffd166', core: '#9c6ade', deny: '#d64545' };
const popIn = (p: number) => { const c = 1.70158; const x = clamp(p) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };

/** A frame's local space as a canvas transform (frames scale per axis; no rotation). */
function frameXform(ctx: Surface, view: View<SceneState>, tree: FrameTree, fid: string) {
  const o = toWorld(tree, fid, [0, 0]), px = toWorld(tree, fid, [1, 0]), py = toWorld(tree, fid, [0, 1]);
  const [a, , , d, e, f] = view.matrix;
  ctx.setTransform(a * (px[0] - o[0]), 0, 0, d * (py[1] - o[1]), a * o[0] + e, d * o[1] + f);
}

function drawThing(ctx: Surface, o: Thing, view: View<SceneState>, p: Production<SceneState>) {
  const k = popIn(o.prog) * o.size; if (k <= 0) return;
  ctx.save(); ctx.translate(o.at[0], o.at[1]); ctx.scale(k, k);
  const lit = o.lit != null && view.t >= o.lit ? smooth(o.lit, o.lit + .4, view.t) : 0;
  ctx.fillStyle = 'rgba(43,38,34,.12)'; ctx.beginPath(); ctx.ellipse(0, o.kind === 'character' ? 92 : 44, 46, 9, 0, 0, Math.PI * 2); ctx.fill();
  if (o.kind === 'machine') {
    ctx.fillStyle = C.machine; ctx.beginPath(); ctx.roundRect(-52, -40, 104, 74, 12); ctx.fill();
    ctx.fillStyle = lit ? `rgba(255,209,102,${.35 + .65 * lit})` : C.screen; ctx.beginPath(); ctx.roundRect(-40, -30, 80, 46, 7); ctx.fill();
    if (lit) { ctx.fillStyle = `rgba(31,36,51,${lit})`; ctx.fillRect(-26, -16, 30, 4); ctx.fillRect(-26, -6, 44, 4); }
    ctx.fillStyle = C.machine; ctx.fillRect(-10, 34, 20, 8); ctx.beginPath(); ctx.roundRect(-30, 42, 60, 6, 3); ctx.fill();
  } else if (o.kind === 'core') {
    ctx.fillStyle = C.core; ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; ctx.lineTo(Math.cos(a) * 26, Math.sin(a) * 26); } ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
  } else if (o.kind === 'lamp') {
    ctx.fillStyle = C.ink; ctx.fillRect(-1.5, -200, 3, 180); ctx.fillStyle = '#c4553a'; ctx.beginPath(); ctx.moveTo(-34, 0); ctx.lineTo(34, 0); ctx.lineTo(18, -26); ctx.lineTo(-18, -26); ctx.closePath(); ctx.fill();
  } else if (o.kind === 'character') {
    const col = o.id === 'maker' ? C.maker : C.guest, who = o.id.toUpperCase();
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(-38, -10, 76, 96, 30); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -46, 40, 0, Math.PI * 2); ctx.fill();
    if (lit) { ctx.strokeStyle = `rgba(255,209,102,${lit})`; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(0, -46, 50 + 4 * Math.sin(view.t * 4), 0, Math.PI * 2); ctx.stroke(); }
    // eyes follow whoever is speaking
    const sp = p.envelopes?.speaker(view.t); const other = sp && sp !== who ? view.state.things[sp.toLowerCase()] : undefined;
    const look = other ? Math.sign(toWorld(view.frames, other.frame, other.at)[0] - toWorld(view.frames, o.frame, o.at)[0]) * 5 : 0;
    for (const ex of [-14, 14]) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, -52, 10, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(ex + look, -51, 4.5, 0, Math.PI * 2); ctx.fill(); }
    const lv = p.envelopes?.level(who, view.t) ?? 0;
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.roundRect(-11, -30 - 7 * lv, 22, 3 + 15 * lv, 6); ctx.fill();
  }
  ctx.restore();
}

function drawRefusal(ctx: Surface, r: SceneState['refusals'][number], view: View<SceneState>) {
  const a = 1 - smooth(r.t + 1.2, r.t + 1.8, view.t); if (a <= 0) return;
  const at = view.frames[r.e.frame] && r.e.args?.at ? toWorld(view.frames, r.e.frame, r.e.args.at) : [640, 400];
  ctx.save(); ctx.globalAlpha = a; ctx.translate(at[0], at[1]);
  ctx.strokeStyle = C.deny; ctx.lineWidth = 7; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-18, -18); ctx.lineTo(18, 18); ctx.moveTo(18, -18); ctx.lineTo(-18, 18); ctx.stroke();
  ctx.font = '600 18px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const msg = 'refused: ' + r.reason, w = ctx.measureText(msg).width + 28;
  ctx.fillStyle = C.deny; ctx.beginPath(); ctx.roundRect(-w / 2, 34, w, 32, 16); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(msg, 0, 51); ctx.restore();
}

export const geometric: Style<SceneState, Production<SceneState>> = {
  name: 'geometric',
  draw(ctx, view, p) {
    const S = view.state, tree = view.frames, [a, , , d, e, f] = view.matrix, k = view.scale;
    ctx.setTransform(a, 0, 0, d, e, f);
    ctx.fillStyle = C.bg; ctx.fillRect(-2000, -2000, 6000, 6000);
    ctx.fillStyle = C.floor; ctx.fillRect(-2000, 560, 6000, 3000);
    // each frame, then what's in it: later frames cover earlier ones, so a frame slid under another is hidden by it
    for (const fr of drawOrder(tree)) {
      if (fr.hidden) continue; const st = S.frames[fr.id]; if (fr.parent && !st) continue;
      frameXform(ctx, view, tree, fr.id);
      if (fr.parent) {
        const g = popIn(st.prog);
        ctx.save(); ctx.translate(fr.lw / 2, fr.lh / 2); ctx.scale(g, g); ctx.translate(-fr.lw / 2, -fr.lh / 2);
        ctx.fillStyle = 'rgba(43,38,34,.10)'; ctx.beginPath(); ctx.roundRect(6, 10, fr.lw, fr.lh, 18); ctx.fill();
        ctx.fillStyle = C.frame; ctx.strokeStyle = C.frameEdge; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect(0, 0, fr.lw, fr.lh, 18); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      for (const o of Object.values(S.things)) if (o.frame === fr.id) { frameXform(ctx, view, tree, fr.id); drawThing(ctx, o, view, p); }
    }
    ctx.setTransform(a, 0, 0, d, e, f);
    for (const r of S.refusals) drawRefusal(ctx, r, view);
    // overlay in output space: fade in, caption
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const crop = view.layout?.crop ?? { x: 0, y: 0, w: view.stage.w, h: view.stage.h };
    const fade = 1 - smooth(0, .6, view.T); if (fade > 0) { ctx.fillStyle = `rgba(239,230,214,${fade})`; ctx.fillRect(0, 0, view.stage.w, view.stage.h); }
    const cap = p.captions?.at(view.t);
    if (cap) {
      const narrow = crop.w < 600, fs = narrow ? 17 : 26; ctx.font = `600 ${fs}px system-ui, sans-serif`;
      const words = cap.text.split(' '), lines: string[] = []; let cur = '';
      for (const w of words) { const n = cur ? cur + ' ' + w : w; if (ctx.measureText(n).width > crop.w - 70 && cur) { lines.push(cur); cur = w; } else cur = n; } lines.push(cur);
      const lh = fs * 1.25, bh = lines.length * lh + 44, cx = crop.x + crop.w / 2, by = narrow ? crop.h * .72 : crop.h - bh - 28;
      const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 48;
      ctx.fillStyle = cap.who === 'MAKER' ? C.maker : C.guest; ctx.beginPath(); ctx.roundRect(cx - bw / 2, by, bw, bh, 16); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = `700 ${narrow ? 11 : 13}px system-ui, sans-serif`; ctx.fillText(cap.who, cx, by + 10);
      ctx.font = `600 ${fs}px system-ui, sans-serif`; lines.forEach((l, i) => ctx.fillText(l, cx, by + 30 + i * lh));
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  },
};
