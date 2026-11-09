/** Terminal: the same scene on a phosphor character grid. Positions come from the same frames and camera,
 * then snap to text cells; frames are box-drawing borders, things are glyph art, mouths are characters. */

import { smooth, toWorld, type Production, type Style, type Surface, type View, type Vec2 } from '../../../src/index.js';
import { drawOrder, type SceneState, type Thing } from '../scene.js';

const G = { bg: '#07110a', dim: '#1f6b35', mid: '#2fbf5a', hi: '#9dffb8', lit: '#e8ff7a', deny: '#ff6a4d' };
const ART: Record<string, string[]> = {
  machine: ['┌──────┐', '│ ░░░░ │', '│ ░░░░ │', '└──┬┬──┘', ' ══╧╧══ '],
  machineLit: ['┌──────┐', '│ >_▌  │', '│ ════ │', '└──┬┬──┘', ' ══╧╧══ '],
  core: [' /\\ ', '<{}>', ' \\/ '],
  lamp: ['  │  ', '  │  ', ' /▔\\ '],
};
const face = (eyes: string, mouth: string) => [' .---. ', `( ${eyes} )`, ` ( ${mouth} ) `, '/|   |\\', ' |___| ', ' /   \\ '];
const mouthOf = (lv: number) => (lv < .08 ? '_' : lv < .35 ? '-' : lv < .65 ? 'o' : 'O');

export const terminal: Style<SceneState, Production<SceneState>> = {
  name: 'terminal',
  draw(ctx, view, p) {
    const S = view.state, tree = view.frames, k = view.scale, [a, , , d, e, f] = view.matrix;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = G.bg; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // the cell size follows the camera, so zooming in makes the type bigger
    const cw = 9.6 * view.camera[0] * k, ch = 18 * view.camera[0] * k;
    ctx.font = `${Math.round(16 * view.camera[0] * k)}px "DejaVu Sans Mono", "IBM Plex Mono", ui-monospace, monospace`; ctx.textBaseline = 'top';
    const cell = (w: Vec2): [number, number] => [Math.round((a * w[0] + e) / cw), Math.round((d * w[1] + f) / ch)];
    const put = (c: number, r: number, s: string, col: string, glow = 0) => { ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = glow * k; ctx.fillText(s, c * cw, r * ch); ctx.shadowBlur = 0; };
    const reveal = (s: string, prog: number) => s.slice(0, Math.ceil(s.length * Math.max(0, Math.min(1, prog))));
    // each frame (a border that types itself in, blanking what's behind it), then what's in it
    const speaker = p.envelopes?.speaker(view.t);
    for (const fr of drawOrder(tree)) {
      if (fr.hidden) continue; const st = S.frames[fr.id]; if (fr.parent && !st) continue;
      if (fr.parent) {
      const [c0, r0] = cell(toWorld(tree, fr.id, [0, 0])), [c1, r1] = cell(toWorld(tree, fr.id, [fr.lw, fr.lh])); const w = c1 - c0, h = r1 - r0;
      if (w >= 2 && h >= 1) {
      const pr = smooth(0, 1, st.prog);
      if (pr > 0) { ctx.fillStyle = G.bg; ctx.fillRect(c0 * cw, r0 * ch, w * cw, (h + 1) * ch); }
      put(c0, r0, reveal('╔' + '═'.repeat(w - 2) + '╗', pr * 2), G.mid, 6);
      for (let r = 1; r < h; r++) if (pr > r / h) { put(c0, r0 + r, '║', G.mid, 6); put(c1 - 1, r0 + r, '║', G.mid, 6); }
      if (pr >= 1) { put(c0, r1, '╚' + '═'.repeat(w - 2) + '╝', G.mid, 6); put(c0 + 2, r0, ` ${String(fr.name ?? fr.id)} `, G.hi); }
      } }
    for (const o of Object.values(S.things) as Thing[]) {
      if (o.frame !== fr.id || o.prog <= 0) continue;
      const lit = o.lit != null && view.t >= o.lit;
      let art: string[]; let col = lit ? G.lit : G.hi;
      if (o.kind === 'character') {
        const who = o.id.toUpperCase(), other = speaker && speaker !== who ? S.things[speaker.toLowerCase()] : undefined;
        const dir = other ? Math.sign(toWorld(tree, other.frame, other.at)[0] - toWorld(tree, o.frame, o.at)[0]) : 0;
        art = face(dir < 0 ? '< <' : dir > 0 ? '> >' : 'o o', mouthOf(p.envelopes?.level(who, view.t) ?? 0));
        col = lit ? G.lit : o.id === 'maker' ? G.hi : G.mid;
      } else art = ART[o.kind === 'machine' && lit ? 'machineLit' : o.kind] ?? ['[?]'];
      const [cc, rr] = cell(toWorld(tree, o.frame, o.at)); const w0 = Math.max(...art.map(l => l.length));
      art.forEach((l, i) => put(cc - Math.floor(w0 / 2), rr - Math.floor(art.length / 2) + i, reveal(l, o.prog * 1.6 - i * .1), col, lit ? 12 : 5));
    } }
    // refusals, where they were aimed
    for (const r of S.refusals) {
      const al = 1 - smooth(r.t + 1.2, r.t + 1.8, view.t); if (al <= 0) continue;
      const at = tree[r.e.frame] && r.e.args?.at ? toWorld(tree, r.e.frame, r.e.args.at) : [640, 400] as Vec2; const [cc, rr] = cell(at);
      ctx.globalAlpha = al; const msg = ` ✗ REFUSED: ${r.reason} `, c0 = cc - Math.floor(msg.length / 2);
      ctx.fillStyle = G.bg; ctx.fillRect(c0 * cw, (rr + 2) * ch, msg.length * cw, ch); ctx.strokeStyle = G.deny; ctx.lineWidth = k; ctx.strokeRect(c0 * cw, (rr + 2) * ch, msg.length * cw, ch);
      put(c0, rr + 2, msg, G.deny, 10); ctx.globalAlpha = 1;
    }
    // caption line, typed out, inside the layout's region; then scanlines
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const crop = view.layout?.crop ?? { x: 0, y: 0, w: view.stage.w, h: view.stage.h }; const narrow = crop.w < 600;
    const cap = p.captions?.at(view.t);
    if (cap) {
      const fs = narrow ? 13 : 20; ctx.font = `${fs}px "DejaVu Sans Mono", "IBM Plex Mono", ui-monospace, monospace`;
      const full = `> ${cap.who}: ${cap.text}`, n = Math.ceil(full.length * smooth(cap.t0, Math.min(cap.t1, cap.t0 + full.length / 28), view.t));
      const maxc = Math.floor((crop.w - 40) / (fs * .6)); const shown = full.slice(0, n) + (Math.floor(view.t * 2.5) % 2 ? '█' : ' ');
      const rows = shown.match(new RegExp(`.{1,${maxc}}`, 'g')) || []; const y0 = (narrow ? crop.h * .74 : crop.h - 36 - rows.length * fs * 1.3);
      ctx.fillStyle = 'rgba(7,17,10,.85)'; ctx.fillRect(crop.x + 12, y0 - 10, crop.w - 24, rows.length * fs * 1.3 + 20);
      rows.forEach((l, i) => { ctx.fillStyle = G.hi; ctx.shadowColor = G.hi; ctx.shadowBlur = 8; ctx.fillText(l, crop.x + 22, y0 + i * fs * 1.3); }); ctx.shadowBlur = 0;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = 'rgba(0,0,0,.22)'; for (let y = 0; y < ctx.canvas.height; y += 3 * k) ctx.fillRect(0, y, ctx.canvas.width, 1.2 * k);
    const fade = 1 - smooth(0, .6, view.T); if (fade > 0) { ctx.fillStyle = `rgba(7,17,10,${fade})`; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
  },
};

export type { Surface, View };
