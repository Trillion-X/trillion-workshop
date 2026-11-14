import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

const SCENE_MARGIN = 32;

/** Crop the real Anatomy scene to all rendered path geometry plus an edge margin. */
export function sceneViewport(scene) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let pathCount = 0;
  for (const match of scene.svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)) {
    pathCount++;
    const values = match[1].match(/[+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?/g) ?? [];
    for (let index = 0; index + 1 < values.length; index += 2) {
      const x = Number(values[index]);
      const y = Number(values[index + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  if (pathCount < 100 || !Object.values(bounds).every(Number.isFinite)) {
    throw new Error('M038 Anatomy scene does not contain a complete articulated person.');
  }
  const left = Math.floor(bounds.minX - SCENE_MARGIN);
  const top = Math.floor(bounds.minY - SCENE_MARGIN);
  const right = Math.ceil(bounds.maxX + SCENE_MARGIN);
  const bottom = Math.ceil(bounds.maxY + SCENE_MARGIN);
  return [left, top, right - left, bottom - top];
}

export function workPosition({ station, label }) {
  if (!['seated', 'standing'].includes(station)) throw new TypeError(`Unknown M038 work position: ${String(station)}`);
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('M038 scene needs caller-owned accessible words.');
  const scene = renderPersonContext({
    pose: station,
    held: station === 'seated' ? ['notebook'] : [],
    label,
    time: 0,
  });
  return { ...scene, viewport: sceneViewport(scene) };
}
