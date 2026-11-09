/** The Night Desk's look: a dark room, paper cards, one amber lamp. Everything it draws comes from the view
 * (time and state); it keeps no memory of its own, so any renderer joining at any moment draws the same frame. */

import { clamp, hashStr, smoothstep, type Production, type Style, type Surface, type View } from '../../src/index.js';
import { MAX_CARDS, type Card, type DeskState } from './show.js';

const C = { room: '#0d1014', wall: '#12161c', rule: '#232a33', paper: '#efe6d3', paperEdge: '#c9bda3', ink: '#1d1a16', faint: '#6c6557',
  amber: '#f2a93b', cold: '#7fb3c8', note: '#d98a6a', dim: '#5b6672', text: '#c8d0d8', deny: '#e2574c' };
const MONO = '500 13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SERIF = (px: number, w = 600) => `${w} ${px}px "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`;
const easeOut = (p: number) => 1 - Math.pow(1 - clamp(p), 3);
const COL = { x: 56, y: 96, w: 640, h: 132, gap: 14 };
const clock = (t: number) => { const s = Math.max(0, Math.floor(t)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };

function fit(ctx: Surface, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text; while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

function drawCard(ctx: Surface, c: Card, y: number, slide: number, alpha: number, t: number) {
  if (alpha <= 0) return;
  const tilt = ((hashStr(c.id) % 7) - 3) * .0016, edge = c.kind === 'lens' ? C.cold : c.kind === 'note' ? C.note : C.dim;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(COL.x + slide, y); ctx.rotate(tilt);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(5, 7, COL.w, COL.h);
  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, COL.w, COL.h);
  ctx.fillStyle = edge; ctx.fillRect(0, 0, 6, COL.h);
  ctx.textBaseline = 'alphabetic';
  ctx.font = MONO; ctx.fillStyle = C.faint;
  ctx.fillText(fit(ctx, c.source.toUpperCase(), 330), 24, 26);
  const stamp = `${c.receipt}  ·  ${clock(c.t0)}`; ctx.fillText(stamp, COL.w - 20 - ctx.measureText(stamp).width, 26);
  ctx.font = SERIF(24); ctx.fillStyle = C.ink; ctx.fillText(fit(ctx, c.title, COL.w - 48), 24, 60);
  ctx.font = SERIF(16, 400); ctx.fillStyle = '#4a443a';
  c.lines.slice(0, 2).forEach((l, i) => ctx.fillText(fit(ctx, l, COL.w - 48), 24, 86 + i * 20));
  // fresh ink: a line under the headline draws itself as the card lands
  const fresh = clamp((t - c.t0) / 1.6); if (fresh < 1) { ctx.fillStyle = edge; ctx.globalAlpha = alpha * (1 - fresh); ctx.fillRect(24, 68, (COL.w - 48) * easeOut(fresh * 1.4), 2); }
  ctx.restore();
}

export const nightDesk: Style<DeskState, Production<DeskState>> = {
  name: 'night-desk',
  draw(ctx, view: View<DeskState>) {
    const { t, state: S, stage } = view;
    ctx.setTransform(...view.matrix);
    ctx.fillStyle = C.room; ctx.fillRect(0, 0, stage.w, stage.h);
    ctx.fillStyle = C.wall; ctx.fillRect(752, 0, stage.w - 752, stage.h);
    ctx.fillStyle = C.rule; ctx.fillRect(752, 0, 1, stage.h);

    // header
    ctx.textBaseline = 'alphabetic'; ctx.font = MONO; ctx.fillStyle = C.dim;
    ctx.fillText('THE NIGHT DESK', COL.x, 52); ctx.fillText('posted as it happens', COL.x + 150, 52);
    ctx.fillStyle = C.rule; ctx.fillRect(COL.x, 66, COL.w, 1);

    // the column: the newest card lands on top and pushes the rest down; the oldest fades off the end
    const cards = S.cards, newest = cards[cards.length - 1], k = newest ? easeOut(newest.in) : 1, step = COL.h + COL.gap;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 70, 752, stage.h - 70); ctx.clip();
    for (let i = 0; i < cards.length; i++) {
      const j = cards.length - 1 - i, c = cards[i];
      if (j === 0) drawCard(ctx, c, COL.y, (1 - k) * 90, k, t);
      else drawCard(ctx, c, COL.y + (j - 1 + k) * step, 0, j >= MAX_CARDS - 1 ? 1 - k : 1, t);
    }
    if (!cards.length) { ctx.font = SERIF(20, 400); ctx.fillStyle = C.dim; ctx.fillText('Nothing yet. The desk is listening.', COL.x, COL.y + 40); }
    ctx.restore();

    // the lamp: on air, breathing slowly
    const X = 800, breathe = .75 + .25 * Math.sin(t * 1.3);
    ctx.fillStyle = C.amber; ctx.globalAlpha = .18 * breathe; ctx.beginPath(); ctx.arc(X + 9, 46, 18, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = .6 + .4 * breathe; ctx.beginPath(); ctx.arc(X + 9, 46, 6, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.font = MONO; ctx.fillStyle = C.amber; ctx.fillText('ON AIR', X + 30, 51);

    // show time
    ctx.font = '300 84px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; ctx.fillStyle = C.text; ctx.fillText(clock(t), X - 4, 168);
    ctx.font = MONO; ctx.fillStyle = C.dim; ctx.fillText('SHOW TIME', X, 196);
    ctx.fillText('CARDS POSTED', X, 250); ctx.fillText('LAST RECEIPT', X + 190, 250);
    ctx.font = SERIF(34, 400); ctx.fillStyle = C.text; ctx.fillText(String(S.posted), X, 290);
    ctx.font = '400 22px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; ctx.fillText(newest?.receipt || '—', X + 190, 288);

    // the line: a trace that is always moving, and jumps when the desk checks it or a card lands
    const L = { x: X, y: 400, w: 424, h: 110 }; ctx.fillStyle = C.rule; ctx.fillRect(L.x, L.y + L.h / 2, L.w, 1);
    ctx.font = MONO; ctx.fillStyle = C.dim; ctx.fillText('THE LINE', L.x, L.y - 22);
    const bump = (t0: number, width: number, x: number) => { const a = x - t0; return a < 0 || a > width ? 0 : Math.sin(Math.PI * a / width) * Math.sin(a * 22) * (1 - a / width); };
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i <= L.w; i += 2) {
      const x = t - (L.w - i) / 60;   // the trace scrolls: 60 px a second, now at the right edge
      let y = .06 * Math.sin(x * 2.1) + .03 * Math.sin(x * 5.3 + 1);
      if (S.pulse) y += .55 * bump(S.pulse.t0, S.pulse.dur, x);
      for (const c of cards) y += .9 * bump(c.t0, .9, x);
      ctx.lineTo(L.x + i, L.y + L.h / 2 - y * L.h / 2);
    }
    ctx.stroke();
    const quiet = newest ? t - newest.t0 : t; ctx.font = MONO; ctx.fillStyle = C.dim;
    ctx.fillText(S.pulse && t - S.pulse.t0 < S.pulse.dur ? 'checking the line…' : quiet > 12 ? `quiet for ${Math.floor(quiet)} s` : 'receiving', L.x, L.y + L.h + 26);

    // refusals stay on the record for a few seconds
    S.refused.forEach((r, i) => {
      const a = 1 - smoothstep((t - r.t0 - 5) / 2); if (a <= 0 || t < r.t0) return;
      ctx.globalAlpha = a; ctx.fillStyle = C.deny; ctx.font = MONO; ctx.fillText(fit(ctx, `REFUSED  ${r.reason}${r.title ? '  ·  ' + r.title : ''}`, 424), X, 600 + i * 24); ctx.globalAlpha = 1;
    });
  },
};
