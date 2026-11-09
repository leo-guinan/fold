/** The Week's look: a ledger page. Paper, ink, and one chalk colour per voice. It draws the same scene in
 * two shapes, wide (16:9) and tall (the 9:16 centre column), from the same view: nothing here keeps time or
 * remembers anything, so a renderer joining mid-edition, a scrub and an export all draw the same frame. */

import { clamp, smoothstep, type Layout, type Production, type Style, type Surface, type View } from '../../src/index.js';
import { CAST, voiceLevel, type Exhibit, type Promise_, type Receipt, type WeekState, type Who } from './show.js';

const C = { paper: '#efe6d3', page: '#f8f2e4', rule: '#d8cbb0', ink: '#1f1b16', soft: '#5f5648', faint: '#9a8f7c', deny: '#b3261e', kept: '#3f7d4e', missed: '#b3261e',
  borges: '#2f5f66', leonardo: '#a8472e', agnolo: '#8c6d12' } as const;
const serif = (px: number, w = 400, it = false) => `${it ? 'italic ' : ''}${w} ${px}px "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`;
const mono = (px: number, w = 500) => `${w} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const out3 = (p: number) => 1 - Math.pow(1 - clamp(p), 3);
type Rect = { x: number; y: number; w: number; h: number };

/** Where things go, for a layout. Tall is the centre column of the same stage, rearranged top to bottom. */
function geometry(layout: Layout | undefined, stage: { w: number; h: number }) {
  if (layout?.name === '9x16') {
    const c = layout.crop, pad = 18, x = c.x + pad, w = c.w - 2 * pad;
    return { tall: true, frame: c, head: { x, y: 26, w, h: 70 }, cast: (['borges', 'leonardo', 'agnolo'] as Who[]).map((who, i) => ({ who, cx: c.x + c.w * (1 + 2 * i) / 6, cy: 150, r: 30 })),
      board: { x, y: 222, w, h: 282 }, caption: { x, y: 524, w, h: 176 }, k: .8 };
  }
  return { tall: false, frame: { x: 0, y: 0, w: stage.w, h: stage.h }, head: { x: 44, y: 22, w: stage.w - 88, h: 50 }, cast: (['borges', 'leonardo', 'agnolo'] as Who[]).map((who, i) => ({ who, cx: 104, cy: 168 + i * 150, r: 50 })),
    board: { x: 318, y: 100, w: 918, h: 410 }, caption: { x: 318, y: 532, w: 918, h: 160 }, k: 1 };
}

function wrap(ctx: Surface, text: string, max: number, maxLines = 99): string[] {
  const lines: string[] = []; let cur = '';
  for (const para of text.split('\n')) {
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? cur + ' ' + word : word;
      if (ctx.measureText(next).width <= max || !cur) cur = next; else { lines.push(cur); cur = word; }
    }
    if (cur) { lines.push(cur); cur = ''; }
  }
  if (lines.length > maxLines) { lines.length = maxLines; let last = lines[maxLines - 1]; while (last.length > 1 && ctx.measureText(last + '…').width > max) last = last.slice(0, -1); lines[maxLines - 1] = last.trimEnd() + '…'; }
  return lines;
}
const fit = (ctx: Surface, text: string, max: number) => wrap(ctx, text, max, 1)[0] ?? '';

// ---------- the three voices: an emblem each, drawn in their chalk ----------
function emblem(ctx: Surface, who: Who, cx: number, cy: number, r: number, level: number, on: boolean, t: number) {
  const col = C[who]; ctx.save(); ctx.translate(cx, cy);
  ctx.globalAlpha = on ? 1 : .42;
  ctx.fillStyle = C.page; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  if (on) { ctx.strokeStyle = col; ctx.globalAlpha = .25 + .5 * level; ctx.lineWidth = 2 + 5 * level; ctx.beginPath(); ctx.arc(0, 0, r + 5 + 3 * level, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.4, r * .045) * (1 + .5 * level);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  if (who === 'borges') {          // a labyrinth: rings with a gap each, turning slowly against one another
    for (let i = 0; i < 4; i++) { const rr = r * (.2 + .18 * i), a = t * (.12 + .05 * i) * (i % 2 ? -1 : 1) + i * 1.7; ctx.beginPath(); ctx.arc(0, 0, rr, a + .5, a + Math.PI * 2 - .2); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(0, 0, r * .06, 0, Math.PI * 2); ctx.fill();
  } else if (who === 'leonardo') {  // a circle in a square, and a compass arm that never stops measuring
    const s = r * .56; ctx.strokeRect(-s, -s, 2 * s, 2 * s); ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.stroke();
    const a = t * .5 + level * .8; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, s * .45, a - .7, a + .7); ctx.stroke();
  } else {                          // an abacus: three rods, beads that shift when he counts
    for (let i = 0; i < 3; i++) {
      const y = (i - 1) * r * .36, w = r * .62; ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(w, y); ctx.stroke();
      const n = 2 + i, shift = (.5 + .5 * Math.sin(t * .6 + i * 2.1)) * (1 - n * .17) * (on ? .4 + .6 * level : .3);
      for (let b = 0; b < n; b++) { ctx.beginPath(); ctx.arc(-w + r * .1 + b * r * .2 + shift * w * 1.2, y, r * .075, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  ctx.restore();
}

// ---------- the board ----------
function drawReceipt(ctx: Surface, r: Receipt, B: Rect, k: number, a: number) {
  const pad = 22 * k, x = B.x + pad, w = B.w - 2 * pad;
  ctx.fillStyle = C.page; ctx.fillRect(B.x, B.y, B.w, B.h); ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.strokeRect(B.x + .5, B.y + .5, B.w - 1, B.h - 1);
  ctx.fillStyle = C.ink; ctx.fillRect(B.x, B.y, 5, B.h);
  ctx.font = mono(13 * k); ctx.fillStyle = C.soft; ctx.textBaseline = 'alphabetic';
  const kind = r.kind === 'tweet' ? 'POST' : r.kind === 'video' ? 'VIDEO' : 'NEWSLETTER';
  ctx.fillText(fit(ctx, `${kind}  ·  ${r.date}  ·  ${r.author}`, w - 90 * k), x, B.y + 32 * k);
  // the stamp lands a moment after the slip
  const s = out3((a - .35) / .4); if (s > 0) { ctx.save(); ctx.globalAlpha *= s; ctx.translate(B.x + B.w - 62 * k, B.y + 30 * k); ctx.rotate(-.08); ctx.scale(1.6 - .6 * s, 1.6 - .6 * s); ctx.strokeStyle = C.deny; ctx.fillStyle = C.deny; ctx.lineWidth = 1.5; ctx.strokeRect(-44 * k, -13 * k, 88 * k, 24 * k); ctx.font = mono(12 * k, 700); ctx.textAlign = 'center'; ctx.fillText('ON FILE', 0, 4 * k); ctx.restore(); }
  const size = (r.quote.length > 420 ? 17 : r.quote.length > 200 ? 20 : 25) * k, lh = size * 1.36, top = B.y + 62 * k, foot = 40 * k;
  ctx.font = serif(size); ctx.fillStyle = C.ink;
  wrap(ctx, r.quote.replace(/\n{2,}/g, '\n'), w, Math.max(1, Math.floor((B.h - (top - B.y) - foot) / lh))).forEach((l, i) => ctx.fillText(l, x, top + size + i * lh));
  ctx.font = mono(12 * k); ctx.fillStyle = C.faint;
  const counts = r.views != null ? `${r.views.toLocaleString('en-US')} views` : r.likes != null ? `${r.likes} likes · ${r.retweets ?? 0} reposts` : '';
  ctx.fillText(fit(ctx, [counts, `sha256 ${r.sha256.slice(0, 12)}`, r.url.replace(/^https?:\/\//, '')].filter(Boolean).join('   ·   '), w), x, B.y + B.h - 16 * k);
}

function drawChart(ctx: Surface, c: Extract<Exhibit, { chart: unknown }>['chart'], B: Rect, k: number, a: number, col: string) {
  ctx.textBaseline = 'alphabetic'; ctx.font = serif(24 * k, 600); ctx.fillStyle = C.ink; ctx.fillText(fit(ctx, c.title, B.w), B.x, B.y + 28 * k);
  const top = B.y + 52 * k, bottom = B.y + B.h - (c.note ? 44 * k : 10 * k), n = c.bars.length, row = Math.min(46 * k, (bottom - top) / n), max = Math.max(...c.bars.map(b => b.value), 1);
  ctx.font = mono(13 * k); const labelW = Math.min(B.w * .34, Math.max(...c.bars.map(b => ctx.measureText(b.label).width)) + 14 * k), x0 = B.x + labelW, room = B.w - labelW - 70 * k;
  c.bars.forEach((b, i) => {
    const y = top + i * row, grow = out3((a - i * .07) / .7), w = Math.max(b.value > 0 ? 2 : 0, room * (b.value / max) * grow);
    ctx.font = mono(13 * k); ctx.fillStyle = C.soft; ctx.fillText(fit(ctx, b.label, labelW - 8 * k), B.x, y + row * .62);
    ctx.fillStyle = b.mark ? col : C.ink; ctx.globalAlpha *= b.mark ? 1 : .78; ctx.fillRect(x0, y + row * .2, w, row * .56); ctx.globalAlpha /= b.mark ? 1 : .78;
    ctx.fillStyle = C.ink; ctx.font = mono(13 * k, 700); ctx.fillText(`${Math.round(b.value * grow)}${c.unit ? ' ' + c.unit : ''}`, x0 + w + 8 * k, y + row * .62);
  });
  if (c.note) { ctx.font = serif(16 * k, 400, true); ctx.fillStyle = C.soft; wrap(ctx, c.note, B.w, 2).forEach((l, i) => ctx.fillText(l, B.x, bottom + 22 * k + i * 19 * k)); }
}

function drawStats(ctx: Surface, s: Extract<Exhibit, { stats: unknown }>['stats'], B: Rect, k: number, a: number, tall: boolean) {
  ctx.textBaseline = 'alphabetic'; let top = B.y;
  if (s.title) { ctx.font = serif(24 * k, 600); ctx.fillStyle = C.ink; ctx.fillText(fit(ctx, s.title, B.w), B.x, B.y + 28 * k); top += 48 * k; }
  const cols = tall ? 2 : Math.min(4, s.items.length), rows = Math.ceil(s.items.length / cols), gw = B.w / cols, gh = Math.min(150 * k, (B.y + B.h - top) / rows);
  s.items.forEach((it, i) => {
    const x = B.x + (i % cols) * gw, y = top + Math.floor(i / cols) * gh, p = out3((a - i * .09) / .5); if (p <= 0) return;
    ctx.save(); ctx.globalAlpha *= p; ctx.translate(0, (1 - p) * 10);
    ctx.fillStyle = C.rule; ctx.fillRect(x, y + 6 * k, gw - 16 * k, 1);
    ctx.font = serif(Math.min(56 * k, gh * .42), 600); ctx.fillStyle = C.ink; ctx.fillText(fit(ctx, it.value, gw - 18 * k), x, y + gh * .56);
    ctx.font = mono(12 * k); ctx.fillStyle = C.soft; wrap(ctx, it.label.toUpperCase(), gw - 18 * k, 2).forEach((l, j) => ctx.fillText(l, x, y + gh * .56 + 22 * k + j * 15 * k));
    ctx.restore();
  });
}

function drawLedger(ctx: Surface, ledger: Promise_[], filed: Record<string, Receipt>, B: Rect, k: number, t: number, heading: string) {
  ctx.textBaseline = 'alphabetic'; ctx.font = serif(24 * k, 600); ctx.fillStyle = C.ink; ctx.fillText(heading, B.x, B.y + 28 * k);
  ctx.fillStyle = C.rule; ctx.fillRect(B.x, B.y + 40 * k, B.w, 1);
  if (!ledger.length) { ctx.font = serif(18 * k, 400, true); ctx.fillStyle = C.soft; ctx.fillText('Nothing on the record yet.', B.x, B.y + 76 * k); return; }
  const shown = ledger.slice(-6), row = Math.min(64 * k, (B.h - 50 * k) / shown.length);
  shown.forEach((p, i) => {
    const y = B.y + 52 * k + i * row, fresh = clamp((t - p.t0) / .6), v = p.verdict, vp = v ? clamp((t - v.t0) / .5) : 0;
    ctx.save(); ctx.globalAlpha *= p.carried ? 1 : out3(fresh);
    const bx = B.x + 2, by = y + 6 * k, bs = 18 * k; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.strokeRect(bx, by, bs, bs);
    if (v && vp > 0) { ctx.strokeStyle = v.result === 'kept' ? C.kept : v.result === 'missed' ? C.missed : C.faint; ctx.lineWidth = 3; ctx.beginPath();
      if (v.result === 'kept') { ctx.moveTo(bx + 3, by + bs * .55); ctx.lineTo(bx + bs * .4, by + bs - 3); ctx.lineTo(bx + bs * .4 + (bs * .75) * vp, by + bs - 3 - bs * vp); }
      else if (v.result === 'missed') { ctx.moveTo(bx + 3, by + 3); ctx.lineTo(bx + 3 + (bs - 6) * vp, by + 3 + (bs - 6) * vp); ctx.moveTo(bx + bs - 3, by + 3); ctx.lineTo(bx + bs - 3 - (bs - 6) * vp, by + 3 + (bs - 6) * vp); }
      else { ctx.moveTo(bx + 4, by + bs / 2); ctx.lineTo(bx + 4 + (bs - 8) * vp, by + bs / 2); }
      ctx.stroke(); }
    const tx = bx + bs + 14 * k, tw = B.w - (tx - B.x);
    ctx.font = serif(19 * k); ctx.fillStyle = C.ink; ctx.fillText(fit(ctx, p.text, tw), tx, y + 20 * k);
    ctx.font = mono(11.5 * k); ctx.fillStyle = v ? (v.result === 'kept' ? C.kept : v.result === 'missed' ? C.missed : C.soft) : C.soft;
    const said = filed[p.cite]; ctx.fillText(fit(ctx, `${v ? v.result.toUpperCase() + '  ·  ' : ''}due ${p.due}${said ? `  ·  said ${said.date}  ·  sha256 ${said.sha256.slice(0, 8)}` : ''}`, tw), tx, y + 38 * k);
    ctx.restore();
  });
}

export const ledgerPage: Style<WeekState, Production<WeekState>> = {
  name: 'ledger-page',
  draw(ctx, view: View<WeekState>) {
    const { t, state: S, stage } = view, G = geometry(view.layout, stage), k = G.k, F = G.frame;
    ctx.setTransform(...view.matrix);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, stage.w, stage.h);
    ctx.fillStyle = C.rule; ctx.globalAlpha = .45; for (let y = 96; y < stage.h; y += 32) ctx.fillRect(F.x, y, F.w, 1); ctx.globalAlpha = 1;   // ledger rules
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';

    // header: the show, the week, and where we are in the edition
    const E = S.edition, H = G.head;
    ctx.font = mono(13 * k, 700); ctx.fillStyle = C.ink; ctx.fillText('FUTURE RADIO  ·  THE WEEK', H.x, H.y + 14);
    if (E) {
      ctx.font = mono(13 * k); ctx.fillStyle = C.soft;
      if (G.tall) ctx.fillText(fit(ctx, E.week.label, H.w), H.x, H.y + 34); else { const w = ctx.measureText(E.week.label).width; ctx.fillText(E.week.label, H.x + H.w - w, H.y + 14); }
      const ty = G.tall ? H.y + 50 : H.y + 34, gap = 6, tw = (H.w - gap * (E.segments - 1)) / E.segments, idx = S.segment ? S.segment.index : -1;
      for (let i = 0; i < E.segments; i++) { ctx.fillStyle = i < idx || E.closed != null ? C.ink : i === idx ? C.ink : C.rule; ctx.globalAlpha = i === idx && E.closed == null ? .55 + .45 * Math.sin(t * 3) ** 2 : 1; ctx.fillRect(H.x + i * (tw + gap), ty, tw, 3); }
      ctx.globalAlpha = 1;
    }

    // the cast
    const L = S.line && t >= S.line.t0 && t < S.line.t0 + S.line.dur + .25 ? S.line : null;
    for (const c of G.cast) {
      const on = L?.who === c.who, level = on ? voiceLevel(L!.text, t - L!.t0, L!.dur) : 0;
      emblem(ctx, c.who, c.cx, c.cy, c.r, level, on || !L, t);
      ctx.globalAlpha = on || !L ? 1 : .5; ctx.fillStyle = C[c.who];
      if (G.tall) { ctx.textAlign = 'center'; ctx.font = serif(15, 600); ctx.fillText(CAST[c.who].name, c.cx, c.cy + c.r + 20); ctx.font = mono(9.5); ctx.fillStyle = C.soft; ctx.fillText(CAST[c.who].role.toUpperCase(), c.cx, c.cy + c.r + 34); ctx.textAlign = 'left'; }
      else { ctx.font = serif(24, 600); ctx.fillText(CAST[c.who].name, c.cx + c.r + 18, c.cy + 2); ctx.font = mono(11.5); ctx.fillStyle = C.soft; ctx.fillText(CAST[c.who].role.toUpperCase(), c.cx + c.r + 18, c.cy + 22); }
      ctx.globalAlpha = 1;
    }

    // the board
    const B = G.board, X = S.exhibit, col = L ? C[L.who] : C.ink;
    if (!E) {
      ctx.font = serif(34 * k, 600); ctx.fillStyle = C.ink; ctx.fillText('Between editions.', B.x, B.y + 60 * k);
      ctx.font = serif(19 * k, 400, true); ctx.fillStyle = C.soft; wrap(ctx, 'The next one is read from the week’s receipts: the newsletter, the channel, the archive.', B.w, 3).forEach((l, i) => ctx.fillText(l, B.x, B.y + 100 * k + i * 26 * k));
    } else if (X && t >= X.t0) {
      const a = t - X.t0, show = X.show; ctx.save(); ctx.globalAlpha = out3(a / .45); ctx.translate(0, (1 - out3(a / .45)) * 14);
      if ('receipt' in show) { const r = S.filed[show.receipt]; if (r) drawReceipt(ctx, r, B, k, a); }
      else if ('chart' in show) drawChart(ctx, show.chart, B, k, a, col);
      else if ('stats' in show) drawStats(ctx, show.stats, B, k, a, G.tall);
      else drawLedger(ctx, S.ledger, S.filed, B, k, t, E.closed != null ? 'On the record for next week' : 'The ledger');
      ctx.restore();
    } else if (S.segment) {
      const a = t - S.segment.t0, p = out3(a / .6);
      ctx.save(); ctx.globalAlpha = p; ctx.font = mono(13 * k, 700); ctx.fillStyle = C.soft; ctx.fillText(`${String(S.segment.index + 1).padStart(2, '0')}  ·  ${S.segment.kind.toUpperCase()}`, B.x, B.y + 40 * k);
      ctx.font = serif((G.tall ? 38 : 60), 600); ctx.fillStyle = C.ink; wrap(ctx, S.segment.title, B.w, 3).forEach((l, i) => ctx.fillText(l, B.x + (1 - p) * 30, B.y + (G.tall ? 92 : 120) + i * (G.tall ? 44 : 68)));
      if (S.segment.kind === 'open') {   // what each source gave this week, gaps included
        E.sources.forEach((src, i) => { const y = B.y + (G.tall ? 190 : 250) + i * 30 * k, q = out3((a - .5 - i * .15) / .4); ctx.globalAlpha = q;
          ctx.fillStyle = src.status === 'ok' ? C.kept : src.status === 'partial' ? C.agnolo : C.deny; ctx.beginPath(); ctx.arc(B.x + 6, y - 5 * k, 5 * k, 0, Math.PI * 2); ctx.fill();
          ctx.font = mono(13 * k, 700); ctx.fillStyle = C.ink; ctx.fillText(src.name.toUpperCase(), B.x + 22, y); const nx = B.x + 22 + ctx.measureText(src.name.toUpperCase() + '  ').width;
          ctx.font = mono(13 * k); ctx.fillStyle = C.soft; ctx.fillText(fit(ctx, src.note, B.x + B.w - nx), nx, y); });
      }
      ctx.restore();
    }

    // the line being spoken: words darken as they are said
    const P = G.caption;
    if (L) {
      const prog = clamp((t - L.t0) / L.dur), size = G.tall ? 21 : 30, lh = size * 1.3;
      ctx.fillStyle = C[L.who]; ctx.fillRect(P.x, P.y, 4, Math.min(P.h, 22 + lh * 3)); ctx.font = mono(12 * k, 700); ctx.fillText(`${CAST[L.who].name.toUpperCase()}${L.cite ? `   ·   on receipt ${L.cite}` : ''}`, P.x + 16, P.y + 12);
      ctx.font = serif(size); const lines = wrap(ctx, L.text, P.w - 16, G.tall ? 6 : 4), total = lines.join(' ').split(' ').length; let n = 0;
      lines.forEach((line, i) => { let x = P.x + 16; for (const word of line.split(' ')) { ctx.fillStyle = C.ink; ctx.globalAlpha = n / total <= prog ? 1 : .28; ctx.fillText(word, x, P.y + 22 + size + i * lh); x += ctx.measureText(word + ' ').width; n++; } });
      ctx.globalAlpha = 1;
    }
    // a refusal stays on the page for a few seconds
    const R = S.refused[S.refused.length - 1];
    if (R && t >= R.t0) { const a = 1 - smoothstep((t - R.t0 - 5) / 1.5); if (a > 0) { ctx.globalAlpha = a; ctx.fillStyle = C.deny; ctx.font = mono(12.5 * k, 700); ctx.fillText(fit(ctx, `REFUSED  ·  ${R.who}: ${R.reason}`, P.w), P.x, P.y + P.h - 4); ctx.globalAlpha = 1; } }
  },
};
