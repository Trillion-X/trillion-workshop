// The physical book is a reusable Anatomy source model. Its opening angle
// represents closer inspection of the same work artifact; it never encodes a
// person's feelings, belief, success, or private experience.
import { renderBook } from '../../../anatomy-contact-replacement/book-model.mjs';

export const STEP_IDS = Object.freeze(['notice', 'receive', 'observe', 'return']);
export const DEFAULT_STEP = 'notice';
const BOOK_FRAME_MARGIN = 26;

const OPEN_BY_STEP = Object.freeze({
  notice: 0.12,
  receive: 0.32,
  observe: 0.72,
  return: 0.72,
});

function sceneViewport(figure) {
  const points = [];
  for (const match of figure.svg.matchAll(/\bd="([^"]+)"/g)) {
    const coordinates = match[1].match(/[+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?/g) ?? [];
    if (coordinates.length % 2 !== 0) throw new Error('M012 book contains an unmatched path coordinate');
    for (let index = 0; index < coordinates.length; index += 2) {
      const point = [Number(coordinates[index]), Number(coordinates[index + 1])];
      if (!point.every(Number.isFinite)) throw new Error('M012 book contains a non-finite path coordinate');
      points.push(point);
    }
  }
  for (const match of figure.svg.matchAll(/<circle\b([^>]*)\/>/g)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/(cx|cy|r)="([^"]+)"/g)].map(item => [item[1], Number(item[2])]));
    if (![attributes.cx, attributes.cy, attributes.r].every(Number.isFinite)) continue;
    points.push([attributes.cx - attributes.r, attributes.cy - attributes.r], [attributes.cx + attributes.r, attributes.cy + attributes.r]);
  }
  points.push(...figure.state.projectedCover);
  if (!points.length) throw new Error('M012 book has no painted geometry to frame');
  const left = Math.floor(Math.min(...points.map(([x]) => x)) - BOOK_FRAME_MARGIN);
  const top = Math.floor(Math.min(...points.map(([, y]) => y)) - BOOK_FRAME_MARGIN);
  const right = Math.ceil(Math.max(...points.map(([x]) => x)) + BOOK_FRAME_MARGIN);
  const bottom = Math.ceil(Math.max(...points.map(([, y]) => y)) + BOOK_FRAME_MARGIN);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    throw new RangeError('M012 book viewport is invalid');
  }
  return [left, top, right - left, bottom - top];
}

/** Return a stable dimensional draft view for one practice move. */
export function sceneForStep(step, figureLabel) {
  if (!STEP_IDS.includes(step)) throw new TypeError(`Unknown M012 practice step: ${String(step)}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) {
    throw new TypeError('M012 figure needs caller-owned accessibility words');
  }
  const figure = renderBook({
    id: 'm012-draft',
    open: OPEN_BY_STEP[step],
    ink: 1,
    label: figureLabel,
  });
  return {
    ...figure,
    viewport: sceneViewport(figure),
    state: { ...figure.state, step, illustrative: true },
  };
}
