#!/usr/bin/env node
// The Week's producer tools. An edition is a plan (demos/week/episodes/<monday>.json); these gather what goes
// into one, check one before it airs, send one to a control room, and list its cuts.
//
//   node tools/week.mjs gather --from 2026-11-02 --to 2026-11-09 [--newsletter <rss url>] [--youtube <channel id>]
//                              [--posts posts.json] [--handle @name] --out week.json
//       Receipts for one week: newsletter issues and channel videos from their feeds, and posts from a file of
//       archive records ({ id, url, user, created_at, text, likes, retweets, … }). Each gets a SHA-256 over
//       kind|date|url|quote. A source that can't be reached is recorded as missing, with why; it is not skipped.
//   node tools/week.mjs check <plan.json>
//       Every citation resolves, every receipt's hash matches its words, every factual line has something
//       behind it, every carried promise gets a verdict; then the plan is run through the show's own world
//       and anything it would refuse on air is listed.
//   node tools/week.mjs air <plan.json> [--room http://127.0.0.1:8790]
//       Check it, then send it to a control room as one signal. It starts a second later.
//   node tools/week.mjs cuts <plan.json> [--page <page url>]
//       The export commands for the full edition and for each segment as a vertical short.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const show = () => import(pathToFileURL(path.join(here, '../demos/week/dist/show.mjs')).href);

/** The Receipt Cuts hash: SHA-256 over kind|date|url|quote. */
export const receiptHash = r => crypto.createHash('sha256').update(`${r.kind}|${r.date}|${r.url}|${r.quote}`).digest('hex');

// ---------- feeds, without a dependency ----------
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const text = html => decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? m[1] : ''; };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Newsletter issues from an RSS feed (Substack and most others), as receipts. */
export function parseNewsletter(xml) {
  const channel = text(tag(xml.split(/<item[\s>]/)[0], 'title'));
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([item]) => {
    const title = text(tag(item, 'title')), blurb = text(tag(item, 'description')), when = new Date(text(tag(item, 'pubDate')));
    const r = { kind: 'newsletter', date: isNaN(when) ? '' : when.toISOString().slice(0, 10), at: isNaN(when) ? '' : when.toISOString(), url: text(tag(item, 'link')), author: text(tag(item, 'dc:creator')) || channel, quote: cut(blurb && blurb !== title ? `${title}\n${blurb}` : title, 420) };
    return { ...r, sha256: receiptHash(r) };
  }).filter(r => r.url && r.date);
}
/** Channel videos from YouTube's Atom feed (https://www.youtube.com/feeds/videos.xml?channel_id=…), as receipts. */
export function parseYouTube(xml) {
  return [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(([entry]) => {
    const when = new Date(text(tag(entry, 'published'))), id = text(tag(entry, 'yt:videoId')), views = entry.match(/<media:statistics[^>]*views="(\d+)"/), likes = entry.match(/<media:starRating[^>]*count="(\d+)"/);
    const r = { kind: 'video', date: isNaN(when) ? '' : when.toISOString().slice(0, 10), at: isNaN(when) ? '' : when.toISOString(), url: id ? `https://www.youtube.com/watch?v=${id}` : '', author: text(tag(tag(entry, 'author'), 'name')), quote: text(tag(entry, 'title')) };
    return { ...r, sha256: receiptHash(r), ...(views ? { views: +views[1] } : {}), ...(likes ? { likes: +likes[1] } : {}) };
  }).filter(r => r.url && r.date);
}
/** Archive post records as receipts, plus the week's count. */
export function postsToReceipts(posts, handle) {
  const receipts = posts.map(p => { const r = { kind: 'tweet', date: p.created_at.slice(0, 10), at: p.created_at, url: p.url, author: handle || '@' + p.user, quote: p.text }; return { ...r, sha256: receiptHash(r), likes: p.likes ?? 0, retweets: p.retweets ?? 0, form: p.retweet_of ? 'repost' : p.reply_to ? 'reply' : p.quoted_id ? 'quote' : 'post' }; });
  const own = receipts.filter(r => r.form !== 'repost'), by = k => receipts.filter(r => r.form === k).length, days = {};
  for (const r of receipts) days[r.date] = (days[r.date] ?? 0) + 1;
  return { receipts, stats: { posts: receipts.length, originals: by('post'), replies: by('reply'), quotes: by('quote'), reposts: by('repost'), likes: own.reduce((n, r) => n + r.likes, 0), perDay: days,
    top: [...own].sort((a, b) => (b.likes + 2 * b.retweets) - (a.likes + 2 * a.retweets)).slice(0, 10).map(r => ({ url: r.url, date: r.date, likes: r.likes, retweets: r.retweets, quote: cut(r.quote.replace(/\s+/g, ' '), 140) })) } };
}
const within = (r, from, to) => r.at >= from && r.at < to;

async function gather() {
  const from = new Date(opt('from')).toISOString(), to = new Date(opt('to')).toISOString(), out = opt('out', 'week.json');
  const sources = [], receipts = []; let stats = null;
  const feed = async (name, url, parse) => {
    if (!url) { sources.push({ name, status: 'missing', note: 'not configured' }); return; }
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'fold-week/1 (+https://github.com/leo-guinan/fold)' } }); if (!res.ok) throw new Error('HTTP ' + res.status);
      const all = parse(await res.text()), week = all.filter(r => within(r, from, to));
      receipts.push(...week); sources.push({ name, status: week.length ? 'ok' : 'missing', note: week.length ? `${week.length} this week` : `nothing published this week (${all.length} in the feed, newest ${all[0]?.date ?? 'none'})` });
    } catch (err) { sources.push({ name, status: 'missing', note: `could not be read: ${err.message}` }); }
  };
  await feed('newsletter', opt('newsletter'), parseNewsletter);
  await feed('channel', opt('youtube') && (/^https?:/.test(opt('youtube')) ? opt('youtube') : `https://www.youtube.com/feeds/videos.xml?channel_id=${opt('youtube')}`), parseYouTube);
  if (opt('posts')) {
    try {
      const raw = JSON.parse(fs.readFileSync(opt('posts'), 'utf8')), posts = (Array.isArray(raw) ? raw : raw.tweets).filter(p => p.created_at >= from && p.created_at < to);
      const got = postsToReceipts(posts, opt('handle')); receipts.push(...got.receipts); stats = got.stats;
      sources.push({ name: 'archive', status: posts.length ? 'ok' : 'missing', note: `${posts.length} posts` });
    } catch (err) { sources.push({ name: 'archive', status: 'missing', note: `could not be read: ${err.message}` }); }
  } else sources.push({ name: 'archive', status: 'missing', note: 'no posts file given' });
  receipts.sort((a, b) => a.at.localeCompare(b.at)).forEach((r, i) => { r.id = 'r' + String(i + 1).padStart(3, '0'); });
  fs.writeFileSync(out, JSON.stringify({ week: { from: from.slice(0, 10), to: to.slice(0, 10) }, sources, stats, receipts }, null, 1));
  console.log(`${receipts.length} receipts → ${out}`); for (const s of sources) console.log(`  ${s.status.padEnd(8)} ${s.name}: ${s.note}`);
}

/** Everything wrong with a plan. Empty means it can air. */
export async function checkPlan(plan) {
  const S = await show(), problems = S.auditPlan(plan);
  for (const r of plan.receipts) if (receiptHash(r) !== r.sha256) problems.push(`receipt ${r.id}: the words don't match the hash (${r.url})`);
  const edition = S.makeEdition(plan), report = edition.world.report();
  for (const d of report.denied) problems.push(`the world refuses ${d.e.op} by ${d.e.actor} at ${d.e.t.toFixed(1)} s: ${d.reason}`);
  return { problems, edition };
}
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (cmd === 'gather') await gather();
  else if (cmd === 'check' || cmd === 'air' || cmd === 'cuts') {
    const file = argv[1], plan = JSON.parse(fs.readFileSync(file, 'utf8')), { problems, edition } = await checkPlan(plan), T = edition.timeline;
    if (cmd !== 'cuts') {
      console.log(`${plan.title}: ${plan.receipts.length} receipts, ${plan.segments.length} segments, ${plan.segments.reduce((n, s) => n + s.lines.length, 0)} lines, ${fmt(T.duration)} long`);
      for (const s of T.segments) console.log(`  ${fmt(s.t0)}  ${s.kind.padEnd(9)} ${s.title}`);
      const cited = new Set(plan.segments.flatMap(s => s.lines).flatMap(l => [l.cite, l.show?.receipt, l.promise?.cite].filter(Boolean)));
      const unused = plan.receipts.filter(r => !cited.has(r.id)).map(r => r.id); if (unused.length) console.log(`  filed but never cited: ${unused.join(', ')}`);
      if (problems.length) { console.error(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}:`); for (const p of problems) console.error('  ✗ ' + p); process.exit(1); }
      console.log('  clean: every citation resolves, every hash matches, the world refuses nothing');
    }
    if (cmd === 'air') {
      const room = opt('room', 'http://127.0.0.1:8790'), id = `edition-${plan.week.from}-${Date.now().toString(36)}`;
      const res = await fetch(room + '/signal', { method: 'POST', body: JSON.stringify({ id, kind: 'week.edition', source: 'week.mjs', data: plan }) }), body = await res.json();
      const r = body.results?.[0]; if (!res.ok || r?.skipped) { console.error('not aired:', r?.skipped ?? body.error); process.exit(1); }
      console.log(`on air at show time ${r.staged[0].t.toFixed(1)} s: ${r.staged.length} events staged, ${r.staged.filter(e => e.result === 'denied').length} refused`);
    }
    if (cmd === 'cuts') {
      const page = opt('page', 'demos/week/index.html'), rel = path.relative(path.join(here, '../demos/week'), path.resolve(file)), base = `${page}?plan=${rel}`, stem = `out/week-${plan.week.from}`;
      console.log(`node tools/export.mjs "${base}" --out ${stem}.mp4`);
      for (const s of T.segments) if (!['open', 'close'].includes(s.kind)) console.log(`node tools/export.mjs "${base}&only=${s.id}" --layout 9x16 --out ${stem}-${s.id}-9x16.mp4    # ${s.title}, ${fmt(s.t1 - s.t0)}`);
    }
  } else { console.error('usage: week.mjs gather|check|air|cuts …  (see the top of this file)'); process.exit(2); }
}
