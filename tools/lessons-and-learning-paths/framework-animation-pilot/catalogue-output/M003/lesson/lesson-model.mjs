// The M003 scene reuses the actual Anatomy people and extensor-chain art. It
// visualizes the framework's physical subject without predicting a person's
// response or inferring health from appearance.
import * as K from '../../../../parts/ui/show/anatomy/iso-kit.mjs';
import { renderContext, renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const MODES = Object.freeze(['capability-contrast', 'control-map', 'forecast-review']);
export const GOALS = Object.freeze(['gain', 'maintain', 'lose']);
export const CAPABILITIES = Object.freeze(['strength', 'mobility', 'fitness']);

const WIDTH = 1920;
const HEIGHT = 1080;
const PERSON_SCALE = 0.83;
const PERSON_PAD = 30;

function cropForPerson(figure) {
  const joints = Object.values(figure.state.joints).flatMap(value => typeof value[0] === 'number' ? [value] : value);
  // The source body's widest shirt radius is 18, and its shoes extend 11
  // from an ankle. A 22-unit envelope also contains the bent elbows between
  // the declared chest/hand joints without reserving an empty whole stage.
  const points = joints.flatMap(([x, y, z]) => K.boxCorners({ x: x - 22, y: y - 22, w: 44, d: 44, r: 0 }, z - 22, z + 22))
    .map(point => K.iso(point, figure.state.projection));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.floor(Math.min(...xs) - PERSON_PAD);
  const y = Math.floor(Math.min(...ys) - PERSON_PAD);
  const width = Math.ceil(Math.max(...xs) - Math.min(...xs) + PERSON_PAD * 2);
  const height = Math.ceil(Math.max(...ys) - Math.min(...ys) + PERSON_PAD * 2);
  return { x, y, width, height };
}

function actorViewport(actors, square = false) {
  const left = Math.min(...actors.map(actor => actor.screenBounds.x)) - 48;
  const top = Math.min(...actors.map(actor => actor.screenBounds.y)) - 48;
  let width = Math.max(...actors.map(actor => actor.screenBounds.x + actor.screenBounds.width)) - left + 48;
  const height = Math.max(...actors.map(actor => actor.screenBounds.y + actor.screenBounds.height)) - top + 48;
  const extraWidth = square ? Math.max(0, height - width) : 0;
  width += extraWidth;
  return [Math.floor(left - extraWidth / 2), Math.floor(top), Math.ceil(width), Math.ceil(height)];
}

function placePerson({ id, pose, time = 0, target, scale = PERSON_SCALE, label }) {
  const figure = renderPersonContext({ pose, time, label, ground: false });
  const crop = cropForPerson(figure);
  const origin = figure.state.personScreen;
  const croppedSvg = figure.svg
    .replace('<svg ', `<svg x="0" y="0" width="${crop.width}" height="${crop.height}" `)
    .replace('viewBox="0 0 1920 1080"', `viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}"`);
  const anchor = [origin[0] - crop.x, origin[1] - crop.y];
  return {
    id,
    at: target,
    sourceBounds: crop,
    screenBounds: { x: target[0] - anchor[0] * scale, y: target[1] - anchor[1] * scale,
      width: crop.width * scale, height: crop.height * scale },
    html: `<g data-part="${id}" transform="translate(${target[0]} ${target[1]}) scale(${scale}) translate(${-anchor[0]} ${-anchor[1]})">${croppedSvg}</g>`,
  };
}

function personComparison(figureLabel) {
  const left = placePerson({ id: 'person-standing', pose: 'standing', target: [560, 570], label: figureLabel });
  const right = placePerson({ id: 'person-walking', pose: 'walking', time: 1.2, target: [1360, 570], label: figureLabel });
  const body = K.figureSvg({ width: WIDTH, height: HEIGHT, label: figureLabel, body: `${left.html}${right.html}` });
  return {
    svg: body,
    viewport: actorViewport([left, right]),
    partIds: [left.id, right.id],
    state: {
      actors: [
        { asset: 'context-model.renderPersonContext', pose: 'standing', mapping: 'source-bounds-crop-and-chest-anchor' },
        { asset: 'context-model.renderPersonContext', pose: 'walking', mapping: 'source-bounds-crop-and-chest-anchor' },
      ],
      sourceBounds: [left.sourceBounds, right.sourceBounds],
    },
  };
}

const BODY_PROJECTION = K.fitProjection(
  [-80, 80].flatMap(x => [-70, 60].flatMap(y => [0, 160].map(z => [x, y, z]))),
  WIDTH, HEIGHT,
  { pad: 100, azimuth: 215, elevation: 20 },
);

function bodyView(scene) {
  const state = scene.state;
  const floorCorners = [-75, 75].flatMap(x => [-60, 60].flatMap(y => [-5, 0].map(z => [x, y, z])));
  const anatomyPoints = [
    ...Object.values(state.joints),
    ...Object.values(state.attachments),
    [-35, 28, 6],
    [state.joints.hip[0] - 14, state.joints.hip[1] - 8, state.joints.hip[2] - 12],
  ];
  const projected = [...floorCorners, ...anatomyPoints].map(point => K.iso(point, BODY_PROJECTION));
  const pad = 52;
  const minX = Math.min(...projected.map(([x]) => x)) - pad;
  const minY = Math.min(...projected.map(([, y]) => y)) - pad;
  const maxX = Math.max(...projected.map(([x]) => x)) + pad;
  const maxY = Math.max(...projected.map(([, y]) => y)) + pad;
  const viewport = [Math.floor(minX), Math.floor(minY), Math.ceil(maxX - minX), Math.ceil(maxY - minY)];
  const inner = scene.svg.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/)?.[1];
  if (!inner) throw new Error('M003 Anatomy body asset must remain an SVG figure');
  const svg = K.figureSvg({ width: WIDTH, height: HEIGHT, label: scene.svg.match(/aria-label="([^"]*)"/)?.[1] ?? 'Anatomy illustration', body: `<g data-part="body-art">${inner}</g>` });
  return { svg, viewport, partIds: ['body-art'], sourceBounds: viewport };
}

function singlePerson(figureLabel) {
  const actor = placePerson({ id: 'person-walking', pose: 'walking', time: 1.2, target: [960, 570], scale: 1.0, label: figureLabel });
  return {
    svg: K.figureSvg({ width: WIDTH, height: HEIGHT, label: figureLabel, body: actor.html }),
    viewport: actorViewport([actor], true),
    partIds: [actor.id],
    sourceBounds: actor.sourceBounds,
  };
}

/**
 * Render a source-backed M003 view. The selected goal and preserved capability
 * stay as choices in state; the figure creates no body outcome or score.
 */
export function bodyScene({ mode = 'capability-contrast', goal = 'maintain', capability = 'strength', figureLabel } = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`Unknown M003 mode: ${String(mode)}`);
  if (!GOALS.includes(goal)) throw new TypeError(`Unknown M003 goal: ${String(goal)}`);
  if (!CAPABILITIES.includes(capability)) throw new TypeError(`Unknown M003 capability: ${String(capability)}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) throw new TypeError('M003 scene needs a content-owned figure label');

  let scene;
  let figureAsset;
  if (mode === 'capability-contrast') {
    scene = personComparison(figureLabel);
    figureAsset = 'anatomy-contact-replacement/context-model.mjs#renderPersonContext';
  } else if (mode === 'control-map') {
    const rendered = renderContext({ mode: 'body', time: 0, focus: 'all' });
    scene = bodyView(rendered);
    figureAsset = 'anatomy-contact-replacement/context-model.mjs#renderContext(mode=body)';
  } else {
    scene = singlePerson(figureLabel);
    figureAsset = 'anatomy-contact-replacement/context-model.mjs#renderPersonContext';
  }

  return {
    svg: scene.svg,
    viewport: scene.viewport,
    partIds: scene.partIds,
    state: {
      mode,
      goal,
      capability,
      illustrative: true,
      evidenceStatus: 'source-illustration-no-measured-or-predicted-body-outcome',
      figureAsset,
      actors: scene.state?.actors ?? null,
      sourceBounds: scene.sourceBounds ?? null,
      bodyResponse: null,
      forecast: null,
      score: null,
      prescription: null,
    },
  };
}

export const lessonScene = bodyScene;
