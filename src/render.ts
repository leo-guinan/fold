/** Productions and styles. A production gathers what a film needs over time (a world, its camera, its
 * timeline, an optional cut and a sound source). A style is everything about how it looks: given a view
 * (time, state, frames, camera, layout), it draws. The engine never draws; styles never keep time. */

import type { EngineEvent } from './log.js';
import type { FrameTree } from './frames.js';
import type { World } from './world.js';
import { cameraMatrix, type Envelopes, type Timeline, type Track } from './time.js';
import type { Cut, Layout, Shot } from './cut.js';
import type { SoundSource } from './sound.js';

export interface Production<S, E extends EngineEvent = EngineEvent> {
  world: World<S, E>;
  /** Stage size in stage units. Styles draw in these. */
  stage: { w: number; h: number };
  /** Scene length in seconds (the cut's length, when there is a cut). */
  duration(): number;
  /** Camera at scene time t: [zoom, cx, cy]. */
  camera?: Track | ((t: number) => number[]);
  captions?: Timeline<any>;
  envelopes?: Envelopes;
  cut?: Cut;
  sound?: SoundSource;
  layouts?: Layout[];
}

export interface View<S> {
  /** Output time (what the viewer's clock says). */
  T: number;
  /** Scene time (after the cut). */
  t: number;
  state: S;
  frames: FrameTree;
  camera: number[];
  /** The camera as a canvas transform, including the surface scale. */
  matrix: [number, number, number, number, number, number];
  layout: Layout | undefined;
  shot: Shot | undefined;
  stage: { w: number; h: number };
  /** Device pixels per stage unit on the surface. */
  scale: number;
}

/** Anything that draws on a 2D canvas context. */
export type Surface = CanvasRenderingContext2D;

export interface Style<S, P extends Production<S, any> = Production<S, any>> {
  name: string;
  /** Load fonts, textures, glyphs. Called once before the first frame. */
  setup?(surface: Surface, production: P): void | Promise<void>;
  draw(surface: Surface, view: View<S>, production: P): void;
}

/** Work out the view at output time T without drawing. */
export function viewAt<S>(p: Production<S, any>, T: number, opts: { layout?: Layout; scale?: number } = {}): View<S> {
  const mapped = p.cut ? p.cut.map(T) : { t: T, shot: undefined };
  const t = mapped.t, shot = mapped.shot;
  const frames = p.world.frames(t);
  const state = p.world.stateAt(t);
  const shotCam = shot && opts.layout ? shot.cams?.[opts.layout.name] : undefined;
  const camera = shotCam ? shotCam.slice() : typeof p.camera === 'function' ? p.camera(t) : p.camera ? p.camera.at(t) : [1, p.stage.w / 2, p.stage.h / 2];
  const scale = opts.scale ?? 1;
  return { T, t, state, frames, camera, matrix: cameraMatrix(camera, p.stage, scale), layout: opts.layout, shot, stage: p.stage, scale };
}

/** Draw output time T with a style. Clears the surface first. */
export function renderFrame<S>(surface: Surface, p: Production<S, any>, style: Style<S, any>, T: number, opts: { layout?: Layout; scale?: number } = {}): View<S> {
  const view = viewAt(p, T, opts);
  surface.setTransform(1, 0, 0, 1, 0, 0);
  surface.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  style.draw(surface, view, p);
  return view;
}
