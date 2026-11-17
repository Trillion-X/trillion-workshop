import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';
import * as K from '../../../../../ui/show/anatomy/iso-kit.mjs';

const W = 1920;
const H = 1080;
const SCENE_MARGIN = 32;

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
    throw new Error('M044 Anatomy scene does not contain a complete desk and articulated person.');
  }
  const left = Math.floor(bounds.minX - SCENE_MARGIN);
  const top = Math.floor(bounds.minY - SCENE_MARGIN);
  const right = Math.ceil(bounds.maxX + SCENE_MARGIN);
  const bottom = Math.ceil(bounds.maxY + SCENE_MARGIN);
  return [left, top, right - left, bottom - top];
}

function polygon(points, projection, fill, stroke = '#53645f', width = 1.3) {
  const d = K.pathOf(points.map(point => K.iso(point, projection)), true);
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"/>`;
}

function line(points, projection, color = '#53645f', width = 1) {
  const d = K.pathOf(points.map(point => K.iso(point, projection)));
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}

function overlay(scene, label, body, state) {
  const source = scene.svg;
  const bodyStart = source.indexOf('>') + 1;
  const bodyEnd = source.lastIndexOf('<');
  if (bodyStart <= 0 || bodyEnd < bodyStart || !scene.state?.projection) {
    throw new TypeError('M044 needs a complete seated Anatomy desk scene and projection.');
  }
  const svg = K.figureSvg({ width: W, height: H, label, body: [source.slice(bodyStart, bodyEnd), ...body] });
  return {
    ...scene,
    svg,
    viewport: sceneViewport({ ...scene, svg }),
    state: { ...scene.state, arrangement: state },
  };
}

/** Reuses the seated Anatomy desk and changes the real task materials/phone in its projected workspace. */
export function focusArrangement({ materialsReady, alertsPaused, label }) {
  if (typeof materialsReady !== 'boolean' || typeof alertsPaused !== 'boolean') {
    throw new TypeError('M044 arrangement choices must be boolean.');
  }
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('M044 scene needs caller-owned accessible words.');
  const scene = renderPersonContext({ pose: 'seated', held: ['notebook'], label, time: 0 });
  const P = scene.state.projection;
  const items = [];

  // A task card and pen move into the desk's usable area when materials are prepared.
  const cardX = materialsReady ? -37 : 24;
  const cardY = 54;
  items.push(polygon([[cardX, cardY, 73], [cardX + 12, cardY, 73], [cardX + 12, cardY + 18, 73], [cardX, cardY + 18, 73]], P, '#f4f1e8', '#42534e', 1.8));
  items.push(line([[cardX + 2, cardY + 4, 74], [cardX + 10, cardY + 4, 74]], P, '#39746a', 1.7));
  items.push(line([[cardX + 2, cardY + 7, 74], [cardX + 9, cardY + 7, 74]], P, '#75817b', 1.2));
  items.push(line([[cardX + 2, cardY + 10, 74], [cardX + 10, cardY + 10, 74]], P, '#75817b', 1.2));
  const penStart = materialsReady ? [-16, 55, 75] : [36, 56, 75];
  const penEnd = materialsReady ? [-6, 66, 75] : [29, 66, 75];
  items.push(line([penStart, penEnd], P, '#28618a', 2.2));

  // The phone remains on the desk. Only unrelated alerts disappear; reviewer feedback stays available.
  const phoneX = 30, phoneY = 52, phoneZ = 73.2;
  items.push(polygon([[phoneX, phoneY, phoneZ], [phoneX + 11, phoneY, phoneZ], [phoneX + 11, phoneY + 18, phoneZ], [phoneX, phoneY + 18, phoneZ]], P, '#34423f', '#26332f', 2));
  items.push(polygon([[phoneX + 1.5, phoneY + 2, phoneZ + .8], [phoneX + 9.5, phoneY + 2, phoneZ + .8], [phoneX + 9.5, phoneY + 15, phoneZ + .8], [phoneX + 1.5, phoneY + 15, phoneZ + .8]], P, '#e8f0eb', '#d5e1dc', .8));
  items.push(line([[phoneX + 2.5, phoneY + 5, phoneZ + 1], [phoneX + 8.5, phoneY + 5, phoneZ + 1]], P, '#39746a', 1.8));
  items.push(line([[phoneX + 2.5, phoneY + 7.5, phoneZ + 1], [phoneX + 8, phoneY + 7.5, phoneZ + 1]], P, '#75817b', 1.2));
  if (!alertsPaused) {
    const alert1 = K.iso([phoneX + 10, phoneY + 2, phoneZ + 2], P);
    const alert2 = K.iso([phoneX + 10, phoneY + 5, phoneZ + 2], P);
    items.push(`<circle cx="${alert1[0]}" cy="${alert1[1]}" r="7" fill="#b24e3c" stroke="#fff" stroke-width="2"/>`);
    items.push(`<circle cx="${alert2[0]}" cy="${alert2[1]}" r="7" fill="#b24e3c" stroke="#fff" stroke-width="2"/>`);
  }
  return overlay(scene, label, items, { materialsReady, alertsPaused });
}
