import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const CASE_IDS = Object.freeze(['unclear-request', 'overchecking', 'uncomfortable-reply']);
export const INITIAL_CASE = CASE_IDS[0];
const MARGIN = 32;

/** Fit the full projected Anatomy figure, including room around its paths. */
export function sceneViewport(scene) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let paths = 0;
  for (const match of scene.svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)) {
    paths++;
    const values = match[1].match(/[+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?/g) ?? [];
    for (let i = 0; i + 1 < values.length; i += 2) {
      const x = Number(values[i]); const y = Number(values[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  if (paths < 100 || !Object.values(bounds).every(Number.isFinite)) throw new Error('M025 Anatomy scene lacks complete projected paths.');
  const left = Math.floor(bounds.minX - MARGIN); const top = Math.floor(bounds.minY - MARGIN);
  const right = Math.ceil(bounds.maxX + MARGIN); const bottom = Math.ceil(bounds.maxY + MARGIN);
  return [left, top, right - left, bottom - top];
}

export function evidenceScene({ caseId = INITIAL_CASE, label } = {}) {
  if (!CASE_IDS.includes(caseId)) throw new TypeError(`Unknown M025 evidence case: ${String(caseId)}`);
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('M025 scene needs caller-owned accessible words.');
  const scene = renderPersonContext({
    pose: 'seated', held: ['phone'], phoneUse: 'reading', time: 0, label,
  });
  return { ...scene, viewport: sceneViewport(scene) };
}
