/** Cuts and layouts. A cut is an edit list over a scene: output time T maps to scene time t, shot by shot,
 * each shot with its own speed and its own camera per layout. Trailers, recaps and alternate edits are cuts,
 * not new scenes, so everything in them (mouths, eye-lines, sound) stays in sync with the original.
 * A layout is an output shape: which part of the stage is shown, and at what size. */

export interface Shot {
  /** Output time span. */
  T0: number; T1: number;
  /** Scene time at T0. */
  src0: number;
  /** Scene seconds per output second. */
  rate: number;
  /** Camera per layout name, e.g. { '16x9': [zoom, cx, cy], '9x16': [...] }. Missing: use the scene's camera. */
  cams?: Record<string, number[]>;
  [extra: string]: unknown;
}

export interface CutSpec { shots: Shot[]; end?: number; [extra: string]: unknown }

export class Cut {
  readonly shots: Shot[];
  readonly end: number;
  constructor(readonly spec: CutSpec) {
    this.shots = spec.shots;
    this.end = spec.end ?? (this.shots.length ? this.shots[this.shots.length - 1].T1 : 0);
  }
  /** The shot showing at output time T (the last shot holds past the end). */
  shotAt(T: number): Shot { for (const s of this.shots) if (T < s.T1) return s; return this.shots[this.shots.length - 1]; }
  /** Scene time at output time T. */
  map(T: number): { t: number; shot: Shot } {
    const shot = this.shotAt(T);
    return { t: shot.src0 + Math.max(0, T - shot.T0) * shot.rate, shot };
  }
  /** Gaps or overlaps between consecutive shots (should be empty). */
  seams(eps = 1e-6): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.shots.length; i++) if (Math.abs(this.shots[i].T0 - this.shots[i - 1].T1) > eps) out.push(i);
    return out;
  }
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface Layout {
  name: string;
  /** The region of the stage that is shown, in stage units. */
  crop: Rect;
  /** Output size in pixels. */
  output: { w: number; h: number };
}

/** The whole stage, scaled to an output size. */
export const fullStage = (name: string, stage: { w: number; h: number }, output: { w: number; h: number }): Layout =>
  ({ name, crop: { x: 0, y: 0, w: stage.w, h: stage.h }, output });

/** A full-height column of the stage at a given aspect (w/h), centred: a vertical cut of a landscape stage. */
export const centreColumn = (name: string, stage: { w: number; h: number }, aspect: number, output: { w: number; h: number }): Layout => {
  const w = stage.h * aspect;
  return { name, crop: { x: (stage.w - w) / 2, y: 0, w, h: stage.h }, output };
};
