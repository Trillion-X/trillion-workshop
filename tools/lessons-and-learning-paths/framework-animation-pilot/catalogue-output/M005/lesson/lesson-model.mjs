// Anatomy geometry for interpreting the two different meanings of "3" in a
// training log. The body is the same illustrative rep in each view; the load
// settings show the counted unit described by the selected record.
import * as K from '../../../../parts/ui/show/anatomy/iso-kit.mjs';
import * as G from '../../../../parts/ui/show/anatomy/lathe.mjs';
import { anatomyMaterialStyle } from '../../../../parts/screen-look/show/anatomy/iso-style.mjs';
import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const MODES = Object.freeze(['ordinary-sets', 'descending-pyramids']);
export const WIDTH = 1920;
export const HEIGHT = 1080;

const BODY_TRANSFORM = { x: -470, y: -170, scale: 1.24 };
// This is the existing body() source camera. Unlike renderPersonContext,
// renderContext's body state does not expose a projection field.
const BODY_PROJECTION = K.fitProjection(
  [-80, 80].flatMap(x => [-70, 60].flatMap(y => [0, 160].map(z => [x, y, z]))),
  WIDTH, HEIGHT, { pad: 100, azimuth: 215, elevation: 20 },
);
const PLATE = Object.freeze({ outerRadius: 9, innerRadius: 2.6, thickness: 3, gap: 0.45, floor: 5 });
const SETTING_ROW = Object.freeze([[50, -32], [50, -3], [50, 26]]);
const BODY_GROUND = { x: -75, y: -60, w: 150, d: 120, r: 8 };
const BOUNDS_PAD = 24;

function markPart(svg, scenePart, partId) {
  const marker = `data-scene-part="${scenePart}"`;
  if (!svg.includes(marker)) throw new Error(`M005 Anatomy rep is missing ${scenePart}`);
  return svg.replace(marker, `${marker} data-part="${partId}"`);
}

function bodyFigure(label) {
  // This bent-knee frame matches the retained film's illustrative repetition.
  const figure = renderContext({ mode: 'body', time: 4.65, focus: 'all' });
  const sourceBody = figure.svg.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/)?.[1];
  if (!sourceBody) throw new Error('M005 Anatomy body asset must remain an SVG figure');

  let body = sourceBody;
  for (const [scenePart, partId] of [
    ['femur', 'femur'],
    ['tibia', 'tibia'],
    ['quadriceps', 'quadriceps'],
    ['patella', 'patella'],
    ['knee-joint', 'knee-joint'],
    ['quadriceps-tendon', 'quadriceps-tendon'],
    ['patellar-tendon', 'patellar-tendon'],
    ['tibial-tuberosity', 'tibial-tuberosity'],
  ]) body = markPart(body, scenePart, partId);

  const { x, y, scale } = BODY_TRANSFORM;
  return {
    body: `<g transform="translate(${x} ${y}) scale(${scale})"><g data-part="knee-extensor-rep">${body}</g></g>`,
    state: figure.state,
    partIds: [
      'knee-extensor-rep', 'femur', 'tibia', 'quadriceps', 'patella',
      'quadriceps-tendon', 'patellar-tendon', 'knee-joint', 'tibial-tuberosity',
    ],
  };
}

function bodyScreenPoint(point) {
  const [x, y] = K.iso(point, BODY_PROJECTION);
  return [BODY_TRANSFORM.x + x * BODY_TRANSFORM.scale, BODY_TRANSFORM.y + y * BODY_TRANSFORM.scale];
}

function rodPoints(from, to, radius0, radius1) {
  const delta = to.map((value, index) => value - from[index]);
  const length = Math.hypot(...delta);
  if (length < 0.01) return [];
  const frame = G.frameAlong(from, delta.map(value => value / length));
  const profile = [
    [0, radius0 * 0.6], [length * 0.08, radius0], [length * 0.38, radius0 * 0.98],
    [length * 0.78, radius1], [length, radius1 * 0.65],
  ];
  const steps = 24;
  return profile.flatMap(([along, radius]) => Array.from({ length: steps }, (_, index) =>
    G.pointOf(frame, along, radius, index / steps * Math.PI * 2)));
}

function spherePoints(center, radius) {
  const frame = G.frameAlong(center, G.viewOf(BODY_PROJECTION));
  const steps = 40;
  return Array.from({ length: steps }, (_, index) =>
    G.pointOf(frame, 0, radius, index / steps * Math.PI * 2));
}

function bodyWorldPoints(bodyState) {
  const { hip, knee, ankle } = bodyState.joints;
  const { quadricepsEnd, quadricepsTendonEnd, patella, patellarTendonStart, patellarTendonEnd, tibialTuberosity } = bodyState.attachments;
  const toe = [-35, 28, 6];
  const muscleStart = [hip[0] - 14, hip[1] - 8, hip[2] - 12];
  const calfStart = [knee[0] + 10, knee[1] + 4, knee[2] - 8];
  const calfEnd = [ankle[0] + 7, ankle[1] + 3, ankle[2] + 16];
  const rods = [
    [hip, knee, 13, 10], [knee, ankle, 10, 7], [ankle, toe, 9, 12],
    [muscleStart, quadricepsEnd, 16, 12], [quadricepsEnd, quadricepsTendonEnd, 4.2, 3.5],
    [patellarTendonStart, patellarTendonEnd, 3.5, 2.8], [calfStart, calfEnd, 12, 5],
  ];
  const points = rods.flatMap(([from, to, radius0, radius1]) => rodPoints(from, to, radius0, radius1));
  points.push(...spherePoints(knee, 9), ...spherePoints(patella, 8), ...spherePoints(tibialTuberosity, 3.8));
  const groundRing = K.ringOf(BODY_GROUND, 8);
  for (const z of [-5, 5]) for (const [x, y] of groundRing) points.push([x, y, z]);
  return points;
}

function plateWorldPoints(frame, count) {
  const points = [];
  const steps = G.stepsFor(PLATE.outerRadius, 24, 32, G.scaleOf(BODY_PROJECTION));
  const stride = PLATE.thickness + PLATE.gap;
  for (let index = 0; index < count; index++) {
    const z0 = PLATE.floor + index * stride;
    const z1 = z0 + PLATE.thickness;
    for (const z of [z0, z1]) {
      for (const radius of [PLATE.innerRadius, PLATE.outerRadius]) {
        for (let step = 0; step < steps; step++) {
          points.push(G.pointOf(frame, z, radius, step / steps * Math.PI * 2));
        }
      }
    }
  }
  return points;
}

function loadSetting({ id, position, plates }) {
  const frame = G.frameAlong([position[0], position[1], 0], [0, 0, 1]);
  const steps = G.stepsFor(PLATE.outerRadius, 24, 32, G.scaleOf(BODY_PROJECTION));
  const parts = [];
  const stride = PLATE.thickness + PLATE.gap;
  for (let index = 0; index < plates; index++) {
    const z0 = PLATE.floor + index * stride;
    const z1 = z0 + PLATE.thickness;
    const shape = G.ringBand(z0, z1, PLATE.innerRadius, PLATE.outerRadius, frame, BODY_PROJECTION, {
      steps, hole: [z1, PLATE.innerRadius], bevel: 1.5, rims: 'all',
    });
    const partId = `${id}-plate-${index + 1}`;
    parts.push(K.groupSvg(K.solidSvg(shape, { tone: 'lo', crease: 'faint', className: 'weight-plate' }), {
      'data-part': partId,
      style: anatomyMaterialStyle('metal'),
    }));
  }
  const world = plateWorldPoints(frame, plates);
  const screen = world.map(bodyScreenPoint);
  const center = bodyScreenPoint([position[0], position[1], PLATE.floor]);
  return {
    id, position, origin: center, plates, center, svg: K.groupSvg(parts, { 'data-part': id }),
    world, screen,
  };
}

function settingsFor(mode) {
  const counts = mode === 'ordinary-sets' ? [2] : [3, 2, 1];
  return counts.map((plates, index) => loadSetting({
    id: mode === 'ordinary-sets' ? 'ordinary-setting' : ['heavier-setting', 'lower-setting', 'lightest-setting'][index],
    position: mode === 'ordinary-sets' ? SETTING_ROW[1] : SETTING_ROW[index],
    plates,
  }));
}

function boundsOf(points) {
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
  return { x: left, y: top, width: right - left, height: bottom - top, right, bottom };
}

function worldBoundsOf(points) {
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y), zs = points.map(([, , z]) => z);
  return {
    x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs),
    right: Math.max(...xs), bottom: Math.max(...ys), back: Math.max(...zs),
  };
}

function viewportFor(bodyState, settings) {
  const bodyScreen = bodyWorldPoints(bodyState).map(bodyScreenPoint);
  const geometry = boundsOf([...bodyScreen, ...settings.flatMap(setting => setting.screen)]);
  const x = Math.floor(geometry.x - BOUNDS_PAD);
  const y = Math.floor(geometry.y - BOUNDS_PAD);
  const width = Math.ceil(geometry.width + BOUNDS_PAD * 2);
  const height = Math.ceil(geometry.height + BOUNDS_PAD * 2);
  if (x < 0 || y < 0 || x + width > WIDTH || y + height > HEIGHT) {
    throw new RangeError('M005 projected Anatomy pose and weight-plate bounds exceed the source frame');
  }
  return { viewport: [x, y, width, height], geometry };
}

export function pyramidScene({ mode = 'ordinary-sets', figureLabel } = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`Unknown M005 record interpretation: ${String(mode)}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) throw new TypeError('M005 scene needs a content-owned figure label');

  const body = bodyFigure(figureLabel);
  const settings = settingsFor(mode);
  const { viewport, geometry } = viewportFor(body.state, settings);
  const descent = mode === 'descending-pyramids'
    ? K.lineSvg(K.pathOf(settings.map(setting => setting.center)), { tone: 'hi', dashed: true })
    : '';
  // The plates are authored in the body camera's world coordinates. Apply the
  // same projection transform as the figure; only the connector is already in
  // final screen coordinates.
  const { x, y, scale } = BODY_TRANSFORM;
  const settingsGroup = K.groupSvg(settings.map(setting => setting.svg), {
    transform: `translate(${x} ${y}) scale(${scale})`,
  });
  const bodyParts = [body.body, descent, settingsGroup];
  const partIds = [...body.partIds, ...settings.flatMap(setting => [
    setting.id,
    ...Array.from({ length: setting.plates }, (_, index) => `${setting.id}-plate-${index + 1}`),
  ])];

  return {
    svg: K.figureSvg({ width: WIDTH, height: HEIGHT, label: figureLabel, body: bodyParts }),
    viewport,
    partIds,
    state: {
      mode,
      illustrative: true,
      evidenceStatus: 'illustration-no-measured-training-outcome',
      figureAsset: 'anatomy-contact-replacement/context-model.mjs#renderContext(mode=body)',
      pose: 'one illustrative knee-extensor repetition',
      countedUnit: mode === 'ordinary-sets' ? 'one ordinary set' : 'one complete descending pyramid',
      loadSettingCount: settings.length,
      loadSettings: settings.map(({ id, position, origin, plates, center, world }) => ({
        id,
        worldPosition: [position[0], position[1], PLATE.floor],
        origin: [...origin],
        center: [...center],
        worldBounds: worldBoundsOf(world),
        plates,
      })),
      connectedDescent: mode === 'descending-pyramids',
      visualEncoding: 'Equal ring plates with a center bore show each setting; fewer plates denote a lighter setting qualitatively and have no calibrated load mapping.',
      plateGeometry: { outerRadius: PLATE.outerRadius, boreRadius: PLATE.innerRadius, thickness: PLATE.thickness },
      calibratedLoadMapping: null,
      sourceBounds: viewport,
      geometryBounds: geometry,
      outcome: null,
      dose: null,
      prescription: null,
      body: body.state,
    },
  };
}
