/** Frames: nested coordinate spaces. A frame is a rectangle (x, y, w, h) in its parent, holding a local space
 * of size lw × lh. Anything placed in a frame moves, scales and hides with it. The root has no parent.
 * Frames are derived from the log at a time t (see World.frames), never stored separately. */

import type { Vec2 } from './math.js';

export interface FrameNode {
  id: string;
  parent: string | null;
  x: number; y: number; w: number; h: number;
  /** Size of the frame's own (local) coordinate space. */
  lw: number; lh: number;
  /** Nesting depth; the root is 0. Filled in by the world. */
  depth?: number;
  /** Set when the frame has been put away. */
  hidden?: boolean;
  [extra: string]: unknown;
}

export type FrameTree = Record<string, FrameNode>;

const parentOf = (tree: FrameTree, f: FrameNode): FrameNode | undefined => (f.parent == null ? undefined : tree[f.parent]);

export const toParent = (f: FrameNode, p: Vec2): Vec2 => [f.x + p[0] * f.w / f.lw, f.y + p[1] * f.h / f.lh];
export const fromParent = (f: FrameNode, p: Vec2): Vec2 => [(p[0] - f.x) * f.lw / f.w, (p[1] - f.y) * f.lh / f.h];

/** A point in frame `fid`'s local space, in world (root) coordinates. */
export function toWorld(tree: FrameTree, fid: string, p: Vec2): Vec2 {
  let f = tree[fid];
  while (f && f.parent) { p = toParent(f, p); f = tree[f.parent]; }
  return p;
}
/** The chain of frames from the root down to `fid`. */
export function chain(tree: FrameTree, fid: string): FrameNode[] {
  const c: FrameNode[] = []; let f: FrameNode | undefined = tree[fid];
  while (f) { c.unshift(f); f = parentOf(tree, f); }
  return c;
}
/** A world point, in frame `fid`'s local space. */
export function worldTo(tree: FrameTree, fid: string, p: Vec2): Vec2 {
  for (const f of chain(tree, fid)) if (f.parent) p = fromParent(f, p);
  return p;
}
/** How much one local unit of `fid` measures in world units. */
export function frameScale(tree: FrameTree, fid: string): number {
  let s = 1, f = tree[fid];
  while (f && f.parent) { s *= f.w / f.lw; f = tree[f.parent]; }
  return s;
}
/** True if `a` is `b` or contains it. */
export function isAncestor(tree: FrameTree, a: string, b: string): boolean {
  let f: FrameNode | undefined = tree[b];
  while (f) { if (f.id === a) return true; f = parentOf(tree, f); }
  return false;
}
export const pathOf = (tree: FrameTree, fid: string): string => (tree[fid] ? chain(tree, fid).map(f => f.id).join(' › ') : fid);
/** Fill in every node's depth. */
export function setDepths(tree: FrameTree): void {
  for (const f of Object.values(tree)) { let d = 0, p: FrameNode | undefined = f; while (p.parent) { d++; p = tree[p.parent]; if (!p) break; } f.depth = d; }
}
