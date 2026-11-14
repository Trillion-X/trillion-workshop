// One ordinary outer message-reply scene; mode choice changes only the copy lens.
import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const MODE_IDS = Object.freeze(['glimpse', 'return', 'stay', 'challenge', 'focus', 'act']);
export const DEFAULT_MODE = 'glimpse';
export const SCENE = Object.freeze({ pose: 'standing', held: Object.freeze(['phone']), phoneUse: 'reading', time: 0 });
export const SCENE_KIND = 'illustrative-message-reply';

function svgViewport(svg, padding = 32) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (x, y, rx = 0, ry = rx) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rx) || !Number.isFinite(ry)) return;
    bounds.minX = Math.min(bounds.minX, x - rx);
    bounds.minY = Math.min(bounds.minY, y - ry);
    bounds.maxX = Math.max(bounds.maxX, x + rx);
    bounds.maxY = Math.max(bounds.maxY, y + ry);
  };
  let pathCount = 0;
  for (const match of svg.matchAll(/\bd="([^"]+)"/g)) {
    pathCount++;
    const numbers = match[1].match(/[+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?/g) ?? [];
    for (let index = 0; index + 1 < numbers.length; index += 2) include(Number(numbers[index]), Number(numbers[index + 1]));
  }
  for (const match of svg.matchAll(/<(circle|ellipse|rect)\b([^>]*)>/g)) {
    const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]+)"/g)].map(item => [item[1], Number(item[2])]).filter(([, value]) => Number.isFinite(value)));
    if (match[1] === 'circle') include(attributes.cx, attributes.cy, attributes.r);
    else if (match[1] === 'ellipse') include(attributes.cx, attributes.cy, attributes.rx, attributes.ry);
    else include(attributes.x + attributes.width / 2, attributes.y + attributes.height / 2, attributes.width / 2, attributes.height / 2);
  }
  if (!pathCount || !Number.isFinite(bounds.minX)) throw new Error('M013 scene is missing projected Anatomy geometry');
  const left = Math.floor(bounds.minX - padding);
  const top = Math.floor(bounds.minY - padding);
  const right = Math.ceil(bounds.maxX + padding);
  const bottom = Math.ceil(bounds.maxY + padding);
  return [left, top, right - left, bottom - top];
}

/** The six selectable modes share one ordinary scene; none advances a sequence. */
export function sceneForMode(mode, figureLabel) {
  if (!MODE_IDS.includes(mode)) throw new TypeError(`Unknown M013 observation mode: ${String(mode)}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) {
    throw new TypeError('M013 scene needs caller-owned outer-scene accessibility words');
  }
  const figure = renderPersonContext({ ...SCENE, focus: 'all', label: figureLabel, ground: true });
  return {
    svg: figure.svg,
    label: figureLabel,
    viewport: svgViewport(figure.svg),
    partIds: figure.partIds,
    state: {
      mode,
      scene: SCENE_KIND,
      figureAsset: 'anatomy-contact-replacement/context-model.mjs#renderPersonContext',
      pose: SCENE.pose,
      held: [...SCENE.held],
      phoneUse: SCENE.phoneUse,
      illustrative: true,
      score: null,
      outcome: null,
    },
  };
}
