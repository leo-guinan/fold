/** The demo page: one production, the style chosen by ?style=geometric|terminal, the full scene or ?cut=teaser. */
import { Player, exposeHooks } from '../../src/index.js';
import { makeProduction } from './scene.js';
import { geometric } from './styles/geometric.js';
import { terminal } from './styles/terminal.js';

const q = new URLSearchParams(location.search);
const STYLES = { geometric, terminal } as const;
const style = STYLES[(q.get('style') as keyof typeof STYLES) || 'geometric'] ?? geometric;
const production = makeProduction({ cut: q.get('cut') === 'teaser' });
const exporting = q.has('export');
if (exporting) document.body.classList.add('export');

const canvas = document.querySelector('canvas')!;
const player = new Player({ canvas, production, style, scale: exporting ? devicePixelRatio : Math.max(1, devicePixelRatio),
  onFrame: v => { scrub.value = String(v.T); time.textContent = `${v.T.toFixed(1)} / ${production.duration().toFixed(1)} s`; } });
const scrub = document.querySelector<HTMLInputElement>('#scrub')!, time = document.querySelector('#time')!, play = document.querySelector<HTMLButtonElement>('#play')!;
scrub.max = String(production.duration());
scrub.oninput = () => player.seek(+scrub.value);
play.onclick = async () => { if (player.playing) player.pause(); else await player.play(); play.textContent = player.playing ? 'Pause' : 'Play'; };
document.querySelectorAll<HTMLAnchorElement>('nav a').forEach(a => { if (a.search === location.search.replace(/[&?]export/, '')) a.classList.add('on'); });

await player.setup();
player.seek(exporting ? 0 : 5.6); player.draw();
exposeHooks(player.hooks({ style: style.name, slips: () => production.slips }));
if (!exporting) player.start();
