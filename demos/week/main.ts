/** The Week's page, three ways:
 *   ?plan=episodes/<file>.json[&only=<segment id>]   a finished edition laid out from its plan: scrub it, export it
 *   (nothing)                                        live: follows a control room's feed and never ends
 *   ?replay=/journal&from=<s>&to=<s>                 a stretch of a past live show, reopened from the journal
 * Add &layout=9x16 to look at the tall cut. */
import { Cut, Follower, Player, exposeHooks, openJournal, parseJournal, type FeedMessage, type Production } from '../../src/index.js';
import { auditPlan, makeEdition, makeProduction, makeWorld, type Plan, type WeekState } from './show.js';
import { ledgerPage } from './style.js';

const q = new URLSearchParams(location.search);
const canvas = document.querySelector('canvas')!, status = document.querySelector('#status')!, button = document.querySelector<HTMLButtonElement>('#sound')!, scrub = document.querySelector<HTMLInputElement>('#scrub')!;
const bare = q.has('export') || q.has('stream'); if (bare) document.body.classList.add('export');

/** A finished production: a scrubber, play and pause, and the export hooks. */
async function finished(production: Production<WeekState>, extra: Record<string, unknown>) {
  const player = new Player({ canvas, production, style: ledgerPage, scale: devicePixelRatio, onFrame: v => { scrub.value = String(v.T); status.textContent = `${v.T.toFixed(1)} / ${production.duration().toFixed(1)} s`; } });
  if (q.get('layout')) player.layout = production.layouts?.find(l => l.name === q.get('layout')) ?? player.layout;
  scrub.hidden = false; scrub.max = String(production.duration()); scrub.oninput = () => player.seek(+scrub.value);
  button.textContent = 'Play'; button.onclick = async () => { if (player.playing) player.pause(); else await player.play(); button.textContent = player.playing ? 'Pause' : 'Play'; };
  await player.setup(); player.seek(+(q.get('t') ?? 0)); player.draw();
  exposeHooks(player.hooks({ style: ledgerPage.name, ...extra }));
  if (!q.has('export')) player.start();
}

if (q.has('plan')) {
  const plan = await (await fetch(q.get('plan')!)).json() as Plan, problems = auditPlan(plan);
  if (problems.length) console.warn('plan problems:', problems);
  const edition = makeEdition(plan, q.get('only') ?? undefined);
  await finished(edition, { problems: () => problems, segments: () => edition.timeline.segments, refused: () => edition.world.report().denied.map(d => ({ id: d.e.id, op: d.e.op, reason: d.reason })) });
} else if (q.has('replay')) {
  const from = +(q.get('from') ?? 0), to = +(q.get('to') ?? from + 30), journal = new URL(q.get('replay')!, location.href), world = makeWorld();
  journal.searchParams.set('from', String(from)); journal.searchParams.set('to', String(to));
  if (!openJournal(world, parseJournal<WeekState>(await (await fetch(journal)).text()), { from, to })) throw new Error('that journal has no checkpoint');
  const cut = new Cut({ shots: [{ T0: 0, T1: to - from, src0: from, rate: 1 }] });
  await finished({ ...makeProduction(world), duration: () => cut.end, cut }, { from, to });
} else {
  const world = makeWorld(), follower = new Follower(world, { delay: +(q.get('delay') ?? .5) }), production = makeProduction(world);
  const player = new Player({ canvas, production, style: ledgerPage, scale: +(q.get('scale') ?? devicePixelRatio), clock: () => follower.clock(),
    onFrame: () => { if (!bare) status.textContent = `live · ${world.log.events.length} events in memory · ${world.base?.dropped ?? 0} folded · ${follower.stats.late} late`; } });
  if (q.get('layout')) player.layout = production.layouts?.find(l => l.name === q.get('layout')) ?? player.layout;
  let source: EventSource | null = null;
  const connect = () => { source?.close(); source = new EventSource(q.get('feed') ?? '/feed'); source.onmessage = m => { follower.receive(JSON.parse(m.data) as FeedMessage<WeekState>); if (follower.needsHello) connect(); }; };
  connect(); setInterval(() => follower.tick(), 1000);
  await player.setup();
  await new Promise<void>(ok => { const wait = () => (follower.ready ? ok() : setTimeout(wait, 50)); wait(); });
  player.playing = true; player.start();
  button.onclick = async () => { await player.play(); button.hidden = true; };
  if (q.has('stream')) await player.play();
  exposeHooks(player.hooks({ style: ledgerPage.name, live: true, health: () => ({ ...follower.stats, seq: follower.seq, events: world.log.events.length, folded: world.base?.dropped ?? 0, t: follower.clock(), sound: player.audio.running }) }));
}
