import { renderContext, renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const ARRANGEMENTS = Object.freeze(['familiar', 'question-check']);
export const INITIAL_ARRANGEMENT = 'familiar';
const SCENE_MARGIN = 32;

/** Crop a person scene to its complete Anatomy path geometry with room for its edges. */
export function sceneViewport(scene) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let pathCount = 0;
  for (const match of scene.svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)) {
    pathCount++;
    const coordinates = match[1].match(/[+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?/g) ?? [];
    for (let index = 0; index + 1 < coordinates.length; index += 2) {
      const x = Number(coordinates[index]);
      const y = Number(coordinates[index + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  if (pathCount < 100 || !Object.values(bounds).every(Number.isFinite)) {
    throw new Error('M023 Anatomy scene is missing complete projected path geometry.');
  }
  const left = Math.floor(bounds.minX - SCENE_MARGIN);
  const top = Math.floor(bounds.minY - SCENE_MARGIN);
  const right = Math.ceil(bounds.maxX + SCENE_MARGIN);
  const bottom = Math.ceil(bounds.maxY + SCENE_MARGIN);
  return [left, top, right - left, bottom - top];
}

function fitScene(scene) {
  return { ...scene, viewport: sceneViewport(scene) };
}

function checkedArrangement(value) {
  if (!ARRANGEMENTS.includes(value)) throw new TypeError(`Unknown M023 study arrangement: ${String(value)}`);
  return value;
}

/** Render the selected, illustrative study arrangement through the installed Anatomy owner. */
export function arrangementScene({ arrangement = INITIAL_ARRANGEMENT, label } = {}) {
  const selected = checkedArrangement(arrangement);
  if (typeof label !== 'string' || !label.trim()) {
    throw new TypeError('M023 scene needs caller-owned accessible words.');
  }

  if (selected === 'question-check') {
    return fitScene(renderPersonContext({
      pose: 'seated',
      held: ['notebook'],
      time: 0,
      label,
    }));
  }

  return fitScene(renderPersonContext({
    pose: 'seated',
    held: ['phone'],
    phoneUse: 'reading',
    time: 0,
    label,
  }));
}

export function recallScene({ experience = 'conversation', label } = {}) {
  if (!['conversation', 'puzzle', 'return'].includes(experience)) {
    throw new TypeError(`Unknown M023 remembered experience: ${String(experience)}`);
  }
  if (typeof label !== 'string' || !label.trim()) {
    throw new TypeError('M023 scene needs caller-owned accessible words.');
  }

  if (experience === 'return') {
    return fitScene(renderContext({ mode: 'court', time: 0, focus: 'all', shotTime: 0.47, figureLabel: label }));
  }
  return fitScene(renderPersonContext({
    pose: 'seated',
    held: experience === 'puzzle' ? ['notebook'] : ['phone'],
    ...(experience === 'conversation' ? { phoneUse: 'reading' } : {}),
    time: 0,
    label,
  }));
}

export { checkedArrangement };
