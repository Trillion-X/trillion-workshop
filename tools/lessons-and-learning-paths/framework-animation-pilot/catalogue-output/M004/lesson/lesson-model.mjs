// One source-backed scene per activity. Each view asks whether movement fits
// the primary task; none scores the person or turns movement into a target.
import * as K from '../../../../parts/ui/show/anatomy/iso-kit.mjs';
import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const MODES = Object.freeze(['routine-call', 'difficult-review', 'between-heavy-sets']);
const WIDTH = 1920;
const HEIGHT = 1080;

const SCENES = Object.freeze({
  'routine-call': { pose: 'walking', held: ['phone'], time: 0.55, action: 'walk' },
  'difficult-review': { pose: 'seated', held: ['phone', 'notebook'], time: 0, action: 'sit-and-write' },
  'between-heavy-sets': { pose: 'seated', held: [], time: 0, action: 'rest' },
});

function boundsForFigure(figure, { pose, held }) {
  const joints = figure.state.joints;
  const anchors = [joints.hip, joints.chest, joints.head, ...joints.hands, ...joints.ankles];
  const world = anchors.flatMap(([x, y, z]) => K.boxCorners({ x: x - 22, y: y - 22, w: 44, d: 44, r: 2 }, z - 22, z + 22));

  // Include the actual floor, chair and writing surface when the source pose
  // renders them, rather than framing the larger unused source viewBox.
  if (figure.state.mode === 'person' && figure.state.projection) {
    world.push(...K.boxCorners({ x: -60, y: -40, w: 120, d: 140, r: 8 }, -5, 0));
  }
  if (pose === 'seated') {
    world.push(...K.boxCorners({ x: -23, y: -22, w: 46, d: 44, r: 4 }, 48, 54));
    world.push(...K.boxCorners({ x: -23, y: -26, w: 46, d: 5, r: 3 }, 49, 101));
    for (const x of [-18, 18]) for (const y of [-17, 17]) world.push([x, y, 1], [x, y, 49]);
  }
  if (held.includes('notebook')) {
    world.push(...K.boxCorners({ x: -42, y: 48, w: 84, d: 43, r: 4 }, 66, 72));
    world.push(...K.boxCorners({ x: -20, y: 56, w: 40, d: 29, r: 1 }, 72, 75));
    for (const x of [-35, 35]) for (const y of [54, 84]) world.push([x, y, 1], [x, y, 67]);
    world.push([-20, 56, 75], [20, 85, 75]);
  }

  const pixels = world.map(point => K.iso(point, figure.state.projection));
  const pad = 24;
  const minX = Math.min(...pixels.map(([x]) => x)) - pad;
  const minY = Math.min(...pixels.map(([, y]) => y)) - pad;
  const maxX = Math.max(...pixels.map(([x]) => x)) + pad;
  const maxY = Math.max(...pixels.map(([, y]) => y)) + pad;
  const viewport = [Math.floor(minX), Math.floor(minY), Math.ceil(maxX - minX), Math.ceil(maxY - minY)];
  if (viewport[0] < 0 || viewport[1] < 0 || viewport[0] + viewport[2] > WIDTH || viewport[1] + viewport[3] > HEIGHT) {
    throw new RangeError('M004 projected pose and prop bounds exceed the Anatomy source frame');
  }
  return viewport;
}

function markPart(svg, scenePart, partId) {
  const marker = `data-scene-part="${scenePart}"`;
  if (!svg.includes(marker)) throw new Error(`M004 Anatomy pose is missing ${scenePart}`);
  return svg.replace(marker, `${marker} data-part="${partId}"`);
}

export function activityScene({ mode = 'routine-call', figureLabel } = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`Unknown M004 activity: ${String(mode)}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) throw new TypeError('M004 scene needs a content-owned figure label');
  const scene = SCENES[mode];
  const figure = renderPersonContext({ ...scene, focus: 'all', label: figureLabel, ground: true });
  const viewport = boundsForFigure(figure, scene);
  const body = figure.svg.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/)?.[1];
  if (!body) throw new Error('M004 Anatomy person asset must remain an SVG figure');
  let sourceBody = body;
  const partIds = ['person-figure'];
  if (scene.held.includes('phone')) {
    sourceBody = markPart(sourceBody, 'person-phone', 'phone');
    partIds.push('phone');
  }
  if (scene.held.includes('notebook')) {
    sourceBody = markPart(sourceBody, 'notebook-cover', 'notebook');
    partIds.push('notebook');
  }

  return {
    svg: K.figureSvg({
      width: WIDTH,
      height: HEIGHT,
      label: figureLabel,
      body: `<g data-part="person-figure">${sourceBody}</g>`,
    }),
    viewport,
    partIds,
    state: {
      mode,
      action: scene.action,
      illustrative: true,
      evidenceStatus: 'illustration-no-measured-activity-result',
      figureAsset: 'anatomy-contact-replacement/context-model.mjs#renderPersonContext',
      pose: scene.pose,
      held: [...scene.held],
      ground: true,
      sourceBounds: viewport,
      outcome: null,
      score: null,
      prescription: null,
    },
  };
}
