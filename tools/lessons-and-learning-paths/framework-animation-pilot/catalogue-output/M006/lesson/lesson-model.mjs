// M006 places one imagined attention cue in the real M004 activity contexts.
// The cue can be noticed, taken on a routine call, or left; it is never tallied.
import * as K from '../../../../../ui/show/anatomy/iso-kit.mjs';
import * as G from '../../../../../ui/show/anatomy/lathe.mjs';
import { anatomyMaterialStyle } from '../../../../../screen-look/show/anatomy/iso-style.mjs';
import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const MODES = Object.freeze(['routine-call', 'difficult-review', 'between-heavy-sets']);
export const DECISIONS_BY_MODE = Object.freeze({
  'routine-call': Object.freeze(['notice', 'take', 'leave']),
  'difficult-review': Object.freeze(['notice', 'leave']),
  'between-heavy-sets': Object.freeze(['notice', 'leave']),
});
export const WIDTH = 1920;
export const HEIGHT = 1080;

const CONTEXTS = Object.freeze({
  'routine-call': {
    cue: [38, 74, 30],
    scene(decision) {
      return { pose: decision === 'take' ? 'walking' : 'standing', held: ['phone'] };
    },
  },
  'difficult-review': {
    cue: [50, 90, 30],
    scene() { return { pose: 'seated', held: ['phone', 'notebook'] }; },
  },
  'between-heavy-sets': {
    cue: [46, 78, 30],
    scene() { return { pose: 'seated', held: [] }; },
  },
});

function markPart(svg, scenePart, partId) {
  const marker = `data-scene-part="${scenePart}"`;
  if (!svg.includes(marker)) throw new Error(`M006 Anatomy context is missing ${scenePart}`);
  return svg.replace(marker, `${marker} data-part="${partId}"`);
}

function personBounds(figure, { pose, held }) {
  const joints = figure.state.joints;
  const anchors = [joints.hip, joints.chest, joints.head, ...joints.hands, ...joints.ankles];
  const world = anchors.flatMap(([x, y, z]) => K.boxCorners({ x: x - 22, y: y - 22, w: 44, d: 44 }, z - 22, z + 22));

  // Bounds follow the dimensional parts rendered by renderPersonContext.
  world.push(...K.boxCorners({ x: -60, y: -40, w: 120, d: 140 }, -5, 0));
  if (pose === 'seated') {
    world.push(...K.boxCorners({ x: -23, y: -22, w: 46, d: 44 }, 48, 54));
    world.push(...K.boxCorners({ x: -23, y: -26, w: 46, d: 5 }, 49, 101));
    for (const x of [-18, 18]) for (const y of [-17, 17]) world.push([x, y, 1], [x, y, 49]);
  }
  if (held.includes('notebook')) {
    world.push(...K.boxCorners({ x: -42, y: 48, w: 84, d: 43 }, 66, 72));
    world.push(...K.boxCorners({ x: -20, y: 56, w: 40, d: 29 }, 72, 75));
    for (const x of [-35, 35]) for (const y of [54, 84]) world.push([x, y, 1], [x, y, 67]);
    world.push([-20, 56, 75], [20, 85, 75]);
  }
  if (held.includes('phone')) {
    const [x, y, z] = joints.hands[0];
    world.push(...K.boxCorners({ x: x - 4, y: y, w: 8, d: 2 }, z - 6, z + 8));
  }
  return world;
}

function coinGeometry(position, projection) {
  const [x, y, z] = position;
  const radius = 14;
  const thickness = 5;
  const rimRelief = 0.45;
  const faceRadius = radius * 0.68;
  const view = G.viewOf(projection);
  const axis = G.unit3([view[0], view[1], 0]);
  const frame = G.frameAlong(position, axis);
  const half = thickness / 2;
  const body = G.disc(-half, half, radius, frame, projection, { creaseAngle: 55 });
  const rim = G.ringBand(half - 0.08, half + rimRelief, faceRadius, radius, frame, projection, { creaseAngle: 55 });
  const face = G.disc(half - 0.16, half - 0.08, faceRadius, frame, projection, { creaseAngle: 55 });
  const style = anatomyMaterialStyle('brass', false, { lit: true });
  const svg = `<g data-part="coin-cue" style="${style}">${K.solidSvg(body, { tone: 'hi', crease: 'mid', lit: true, halo: true, className: 'coin-body' })}${K.solidSvg(rim, { tone: 'hi', crease: 'hi', lit: true, className: 'coin-rim' })}${K.solidSvg(face, { tone: 'hi', crease: 'faint', lit: true, className: 'coin-face' })}</g>`;

  // Exact AABB of the upright disc, annular rim and inset face from its local
  // orthonormal frame. The raised rim extends farther toward the camera.
  const axial = Math.max(Math.abs(-half), Math.abs(half + rimRelief));
  const extents = [0, 1, 2].map(index =>
    radius * Math.hypot(frame.u[index], frame.v[index]) + axial * Math.abs(frame.a[index]));
  const bounds = {
    min: [x - extents[0], y - extents[1], z - extents[2]],
    max: [x + extents[0], y + extents[1], z + extents[2]],
  };
  const world = K.boxCorners(
    { x: bounds.min[0], y: bounds.min[1], w: bounds.max[0] - bounds.min[0], d: bounds.max[1] - bounds.min[1] },
    bounds.min[2],
    bounds.max[2],
  );
  return {
    svg, world, position: [...position], axis, radius, thickness, faceRadius, rimRelief,
    bounds, primitive: 'Anatomy lathe.disc with annular rim and inset face',
  };
}

function projectedViewport(figure, person, coin) {
  const projection = figure.state.projection;
  const world = [...personBounds(figure, person), ...coin.world];
  const pixels = world.map(point => K.iso(point, projection));
  const padding = 24;
  const left = Math.min(...pixels.map(([x]) => x)) - padding;
  const top = Math.min(...pixels.map(([, y]) => y)) - padding;
  const right = Math.max(...pixels.map(([x]) => x)) + padding;
  const bottom = Math.max(...pixels.map(([, y]) => y)) + padding;
  const viewport = [Math.floor(left), Math.floor(top), Math.ceil(right - left), Math.ceil(bottom - top)];
  if (viewport[0] < 0 || viewport[1] < 0 || viewport[0] + viewport[2] > WIDTH || viewport[1] + viewport[3] > HEIGHT) {
    throw new RangeError('M006 projected Anatomy context and cue bounds exceed the source frame');
  }
  return viewport;
}

export function coinScene({ mode = 'routine-call', decision = 'notice', figureLabel } = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`Unknown M006 context: ${String(mode)}`);
  if (!DECISIONS_BY_MODE[mode].includes(decision)) throw new TypeError(`Decision ${String(decision)} is unavailable in ${mode}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) throw new TypeError('M006 scene needs a content-owned figure label');

  const context = CONTEXTS[mode];
  const person = context.scene(decision);
  const coinVisible = decision !== 'leave';
  const figure = renderPersonContext({ ...person, time: 0, focus: 'all', label: figureLabel, ground: true });
  const sourceBody = figure.svg.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/)?.[1];
  if (!sourceBody) throw new Error('M006 Anatomy context must remain an SVG figure');
  let body = sourceBody;
  const partIds = ['person-figure'];
  if (person.held.includes('phone')) {
    body = markPart(body, 'person-phone', 'phone');
    partIds.push('phone');
  }
  if (person.held.includes('notebook')) {
    body = markPart(body, 'notebook-cover', 'notebook');
    partIds.push('notebook');
    for (const scenePart of ['desk-top', 'chair-seat']) {
      body = markPart(body, scenePart, scenePart);
      partIds.push(scenePart);
    }
  } else if (person.pose === 'seated') {
    body = markPart(body, 'chair-seat', 'chair-seat');
    partIds.push('chair-seat');
  }

  const coin = coinGeometry(context.cue, figure.state.projection);
  const visibleCoin = coinVisible ? coin.svg : '';
  if (coinVisible) partIds.push('coin-cue');
  const viewport = projectedViewport(figure, person, coinVisible ? coin : { ...coin, world: [] });
  const visibleState = {
    mode,
    decision,
    availableDecisions: [...DECISIONS_BY_MODE[mode]],
    pose: person.pose,
    held: [...person.held],
    coinCueVisible: coinVisible,
    coinCueKind: 'imagined-opportunity-cue',
    coinCuePosition: coinVisible ? [...coin.position] : null,
    coinGeometry: coinVisible ? {
      primitive: coin.primitive,
      orientation: 'upright',
      axis: [...coin.axis],
      radius: coin.radius,
      thickness: coin.thickness,
      faceRadius: coin.faceRadius,
      rimInnerRadius: coin.faceRadius,
      rimOuterRadius: coin.radius,
      rimRelief: coin.rimRelief,
      worldBounds: { min: [...coin.bounds.min], max: [...coin.bounds.max] },
    } : null,
    movementAction: decision === 'take' ? 'walk' : decision === 'leave' ? 'stay' : null,
    illustrative: true,
    evidenceStatus: 'illustration-no-measured-activity-outcome',
    figureAsset: 'anatomy-contact-replacement/context-model.mjs#renderPersonContext',
    sourceBounds: viewport,
    outcome: null,
    score: null,
    moneyValue: null,
    physiologyScore: null,
    prescription: null,
    projection: figure.state.projection,
    joints: figure.state.joints,
  };

  return {
    svg: K.figureSvg({
      width: WIDTH,
      height: HEIGHT,
      label: figureLabel,
      body: `<g data-part="person-figure">${body}</g>${visibleCoin}`,
    }),
    viewport,
    partIds,
    state: visibleState,
  };
}
