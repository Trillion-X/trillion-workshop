// One staged tennis point, shown through two actual Anatomy camera projections.
// The point remains content-owned here; only the camera view changes.
import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const VIEW_IDS = Object.freeze(['player', 'wide']);
export const DEFAULT_VIEW = 'player';
export const EVENT_TIME = 0;
export const SHOT_TIME = 0.62;
const VIEWPORT_MARGIN = 28;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// An illustrative, caller-staged point. These are model coordinates, not a
// recording or a claim about a real player's match, score or result.
export const COURT_EVENT = deepFreeze({
  near: { x: 64, y: -215 },
  far: { x: -30, y: 212 },
  shot: {
    from: [-72, 167, 88],
    to: [120, -225, 12],
    progress: 0.82,
    arcHeight: 55,
  },
});

// Read the rendered Anatomy paths so the camera box includes the court slab,
// fences, people, ball and trail. The racket is transformed as a nested model,
// so include its projected grip/hoop anchors with room for the full hoop.
export function sceneViewport(scene) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (x, y, margin = 0) => {
    bounds.minX = Math.min(bounds.minX, x - margin);
    bounds.minY = Math.min(bounds.minY, y - margin);
    bounds.maxX = Math.max(bounds.maxX, x + margin);
    bounds.maxY = Math.max(bounds.maxY, y + margin);
  };
  let pathCount = 0;
  for (const match of scene.svg.matchAll(/\bd="([^"]+)"/g)) {
    pathCount++;
    const coordinates = match[1].match(/[+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?/g) ?? [];
    for (let index = 0; index + 1 < coordinates.length; index += 2) {
      const x = Number(coordinates[index]);
      const y = Number(coordinates[index + 1]);
      if (Number.isFinite(x) && Number.isFinite(y)) include(x, y);
    }
  }
  if (pathCount < 1000) throw new Error('M010 camera figure is missing whole-scene Anatomy paths');
  for (const point of [scene.state.racketGripScreen, scene.state.racketHoopScreen]) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
      throw new Error('M010 racket projection is missing from the camera figure');
    }
    include(point[0], point[1], 42);
  }
  const left = Math.floor(bounds.minX - VIEWPORT_MARGIN);
  const top = Math.floor(bounds.minY - VIEWPORT_MARGIN);
  const right = Math.ceil(bounds.maxX + VIEWPORT_MARGIN);
  const bottom = Math.ceil(bounds.maxY + VIEWPORT_MARGIN);
  return [left, top, right - left, bottom - top];
}

export function sceneForView(view, figureLabel) {
  if (!VIEW_IDS.includes(view)) throw new TypeError(`Unknown M010 camera view: ${String(view)}`);
  const scene = renderContext({
    mode: 'court',
    time: EVENT_TIME,
    shotTime: SHOT_TIME,
    variant: 'normal',
    focus: 'all',
    courtState: COURT_EVENT,
    view,
    ...(figureLabel === undefined ? {} : { figureLabel }),
  });
  return { ...scene, viewport: sceneViewport(scene) };
}
