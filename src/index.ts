/** fold: an event-sourced animation engine.
 *
 * The engine holds the connections: a log of checked events, the frames they make, the state they fold
 * into at any time, the clocks (camera tracks, timelines, envelopes, cuts), sound scheduling and the hooks
 * for exporting. Styles hold the details: what a character looks like, how a line is drawn, what a sound is. */

export * from './math.js';
export * from './log.js';
export * from './frames.js';
export * from './world.js';
export * from './time.js';
export * from './cut.js';
export * from './render.js';
export * from './sound.js';
export * from './host.js';
export * from './audit.js';
export * from './live.js';
