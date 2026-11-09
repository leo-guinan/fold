# fold

An animation engine that holds the connections, not the details.

A scene is a **log of events**. Each event says who does what, to what, in which frame, when, and for how long. The engine checks every event against the world's rules. It works out the frame tree and the state at any time `t` by folding the log. It maps output time to scene time through an edit, and keeps sound locked to picture. What anything *looks* or *sounds* like belongs to a **style** and a **sound source**, and the engine knows nothing about either. Draw the same log as flat shapes, as a phosphor terminal, or as Leonardo's pencil drawing in Future Radio.

```
log ──fold(t)──▶ state ─┐
 │                      ├─▶ style.draw(surface, view, production) ─▶ pixels
 └─layout(t)──▶ frames ─┘
cut: output T ──▶ scene t        envelopes / captions / camera: tracks over t
sound source ──▶ sounder.schedule(t0, t1, at, rate) ──▶ live (lookahead) or offline (export)
```

CC0. TypeScript, no runtime dependencies.

## Why a log

- **Scrub anywhere.** `state = fold(log, t)` is pure, so any frame can be drawn at any time. Frame rate doesn't matter and nothing drifts.
- **Refusals are part of the story.** A refused event stays in the log, marked `denied` with its reason, and a style can show it.
- **Replays are audited.** Every event is checked again on every fold. If a hand-edited log claims something the rules would refuse, the fold reports a mismatch.
- **One source of truth.** Picture, sound, captions and export all read the same log, so what you scrub is what you export.

## The pieces

| Module | What it holds |
|---|---|
| `log` | `Log`: an append-only list of events in time order, with snapshot, restore, `keepUntil` and dump |
| `world` | `World`: ops (`check`, `apply`, `layout`), rules, `frames(t)`, `stateAt(t)`, `emit()` and `report()` |
| `frames` | nested coordinate spaces: `toWorld`, `worldTo`, `frameScale`, `isAncestor` |
| `time` | `Track` (eased keyframes, such as a camera), `Timeline` (what's active at t), `Envelopes` (loudness that drives mouths and meters), `Stager` (one action at a time, on cue) and `cameraMatrix` |
| `cut` | `Cut`, which maps output T to scene t shot by shot, and `Layout`s (`fullStage`, `centreColumn` for 9:16) |
| `render` | the `Production`, `View` and `Style` contracts, plus `renderFrame` |
| `sound` | `SoundSource` and `Sounder`; `LiveAudio` (the audio clock drives scene time), `renderOffline` (cut-aware) and `encodeWav` |
| `host` | `Player` for the browser and `EngineHooks` (`window.__fold`) for the export tools |
| `audit` | checks a production should pass: clean replay, determinism, one action at a time, captioned, on cue, cut fits |
| `live` | a show with no end: `Stage` (the one writer, on show time), `Director` (signals to beats), `Follower` (a renderer's copy, a moment behind), journals |

## Quick start

```ts
import { World, Track, Envelopes, type Style } from 'fold-engine';

const world = new World({
  initial: () => ({ things: {} as Record<string, { frame: string; at: [number, number] }> }),
  root: { id: 'stage', parent: null, x: 0, y: 0, w: 1280, h: 720, lw: 1280, lh: 720 },
  ops: {
    OPEN:  { layout: { pass: 0, apply: (tree, e) => { tree[e.args.id] = { id: e.args.id, parent: e.frame, ...e.args.box }; } } },
    PLACE: { check: (S, e, { frames }) => (frames[e.frame] ? null : 'no such frame'),
             apply: (S, e) => { S.things[e.target!] = { frame: e.frame, at: e.args.at }; } },
  },
});
world.emit({ t: 0, dur: .8, actor: 'maker', op: 'OPEN', frame: 'stage', args: { id: 'bench', box: { x: 100, y: 80, w: 600, h: 400, lw: 600, lh: 400 } } });
world.emit({ t: 1, dur: .5, actor: 'maker', op: 'PLACE', target: 'lamp', frame: 'bench', args: { at: [300, 200] } });
world.emit({ t: 2, dur: .5, actor: 'maker', op: 'PLACE', target: 'cup', frame: 'drawer', args: { at: [0, 0] } }); // refused: no such frame

const S = world.stateAt(1.2);       // { things: { lamp: … } }
const tree = world.frames(1.2);     // stage › bench
```

A style is a single function:

```ts
const flat: Style<MyState> = {
  name: 'flat',
  draw(ctx, view, production) {
    ctx.setTransform(...view.matrix);          // camera × scale, already worked out
    for (const thing of Object.values(view.state.things)) { /* draw it in its frame via toWorld(view.frames, …) */ }
  },
};
```

## Writing a style

A style receives `view`, which contains:
- `t`: scene time
- `T`: output time
- `state`
- `frames`
- `camera`
- `matrix`
- `layout`
- `scale`
- `stage`

It also receives `production`, which carries captions, envelopes and whatever else the scene exposes. Everything a style needs is a function of those two. A style never reads the clock and never mutates state. That is why two styles can render the same log frame-for-frame, and why export is deterministic.

## Live

The same log can be written while it plays. A control room takes signals from outside, stages them as events a second in the future, and serves the log as a feed. Any number of pages follow the feed and draw it; one of them can be recorded and sent to an RTMP ingest. Finished events are folded into a checkpoint as the show goes, so the log stays a few events long however many days it runs, and any stretch of a past show can be reopened from the journal and exported frame by frame.

```
signals ──▶ Director ──▶ Stage ──▶ feed ──▶ Follower ──▶ Player ──▶ pixels ──▶ stream
            what it      when it            a renderer's copy of the world,
            means here   happens            a moment behind
```

```sh
npm run live                                                     # the Night Desk demo's control room, on :8790
open http://127.0.0.1:8790/demos/live-desk/index.html
curl -X POST http://127.0.0.1:8790/signal -d '{"id":"n1","kind":"note","source":"me","data":{"title":"Hello","text":"First card."}}'
node tools/stream.mjs http://127.0.0.1:8790/demos/live-desk/index.html --to out/check.mp4 --seconds 30
```

One rule makes this work: once an event has ended, its effect must not depend on time. `world.compact(t)` checks that before it drops anything, and refuses with the reason if it doesn't hold. [docs/LIVE.md](docs/LIVE.md) has the architecture, the time model, what survives a restart, and what has and hasn't been tested.

## Tools

- `npm run build`: compiles to `dist/esm` and bundles `dist/fold.iife.js` (global `Fold`) plus each demo.
- `npm test`: core tests, scene audits, and browser determinism (needs Playwright).
- `node tools/serve.mjs`: serves the repo, so you can open `demos/two-builders/index.html?style=terminal`.
- `node tools/export.mjs <page> --out film.mp4 --layout 9x16 --scale 1`: renders an MP4 frame by frame (Playwright and ffmpeg) and muxes `renderAudio()`.
- `node tools/stills.mjs <page> --times 1,4,8 --out sheet.png`: stills and contact sheets.
- `node tools/room.mjs <show.mjs> [--journal file] [--signals <sse url>]`: the control room for a live show.
- `node tools/stream.mjs <page url> --to rtmp://…|file`: broadcasts a live page in real time (Playwright and ffmpeg).

Any page that sets `window.__fold` (see `EngineHooks`) can be exported. The export tools also take a full `http://` URL, which is how a clip of a live show is cut from its control room's journal.

## Demo: two builders

`demos/two-builders` is a 16-second scene with two styles, `geometric` and `terminal`. One builder sets up a bench. The other asks "Can I try?" and is refused: the drawer is already closed. Both styles draw the same log, and so do both layouts (16:9 and a 9:16 teaser cut).

## Demo: the Night Desk

`demos/live-desk` is a show with no end. A signal arrives (a watched page changed, someone sent a note) and a card is posted on the desk; a card with no headline is refused, and the refusal is shown; when nothing happens the desk checks the line. `show.ts` holds the ops and the rules for what signals mean, and runs in both the control room and the page. `style.ts` holds the look.

## In production

[Future Radio studio](https://github.com/leo-guinan/future-radio-studio) runs on fold. Its log, frame tree, fold, replay checks, camera, trailer cut and offline audio all go through the engine. The studio itself defines only its ops and its pencil-and-ink style. The port was verified by comparing before and after: all 89 reference frames are pixel-identical, the event logs are identical, and the audio matches to within float noise (−120 dB).

## License

CC0 1.0. No rights reserved.
