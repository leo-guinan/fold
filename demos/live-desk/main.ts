/** The Night Desk page. Live by default: it follows the control room's feed (tools/room.mjs) and never ends.
 * With ?replay=/journal&from=<s>&to=<s> it reopens a stretch of a past show from the journal, as a
 * finished scene that can be scrubbed and exported like any other. */
import { Cut, Follower, Player, exposeHooks, openJournal, parseJournal, type FeedMessage } from '../../src/index.js';
import { makeProduction, makeWorld, type DeskState } from './show.js';
import { nightDesk } from './style.js';

const q = new URLSearchParams(location.search);
const canvas = document.querySelector('canvas')!, status = document.querySelector('#status')!, sound = document.querySelector<HTMLButtonElement>('#sound')!;
const bare = q.has('export') || q.has('stream'); if (bare) document.body.classList.add('export');
const world = makeWorld();

if (q.has('replay')) {
  // a clip is a cut: one shot over the stretch asked for, so picture, sound and export all start at zero
  const from = +(q.get('from') ?? 0), to = +(q.get('to') ?? from + 30), journal = new URL(q.get('replay')!, location.href);
  journal.searchParams.set('from', String(from)); journal.searchParams.set('to', String(to));
  if (!openJournal(world, parseJournal<DeskState>(await (await fetch(journal)).text()), { from, to })) throw new Error('that journal has no checkpoint');
  const cut = new Cut({ shots: [{ T0: 0, T1: to - from, src0: from, rate: 1 }] });
  const production = { ...makeProduction(world, cut.end), cut };
  const player = new Player({ canvas, production, style: nightDesk, scale: devicePixelRatio, onFrame: v => { status.textContent = `replay: show time ${v.t.toFixed(1)} s (${from}–${to})`; } });
  await player.setup(); player.seek(0); player.draw();
  sound.textContent = 'Play'; sound.onclick = () => (player.playing ? player.pause() : player.play());
  exposeHooks(player.hooks({ style: nightDesk.name, from, to }));
  if (!q.has('export')) player.start();
} else {
  const follower = new Follower(world, { delay: +(q.get('delay') ?? .5) });
  const player = new Player({ canvas, production: makeProduction(world), style: nightDesk, scale: +(q.get('scale') ?? devicePixelRatio), clock: () => follower.clock(),
    onFrame: () => { if (!bare) status.textContent = `${world.log.events.length} events in memory · ${world.base?.dropped ?? 0} folded · ${follower.stats.late} late`; } });
  let source: EventSource | null = null;
  const connect = () => {
    source?.close(); source = new EventSource(q.get('feed') ?? '/feed');
    source.onmessage = m => { follower.receive(JSON.parse(m.data) as FeedMessage<DeskState>); if (follower.needsHello) connect(); };
    // EventSource reconnects by itself, and the room greets every connection with a fresh hello
  };
  connect();
  setInterval(() => follower.tick(), 1000);
  await player.setup();
  await new Promise<void>(ok => { const wait = () => (follower.ready ? ok() : setTimeout(wait, 50)); wait(); });
  player.playing = true; player.start();               // picture runs at once; sound needs a click (or ?stream)
  sound.onclick = async () => { await player.play(); sound.hidden = true; };
  if (q.has('stream')) await player.play();
  exposeHooks(player.hooks({ style: nightDesk.name, live: true, health: () => ({ ...follower.stats, seq: follower.seq, events: world.log.events.length, folded: world.base?.dropped ?? 0, t: follower.clock(), sound: player.audio.running }) }));
}
