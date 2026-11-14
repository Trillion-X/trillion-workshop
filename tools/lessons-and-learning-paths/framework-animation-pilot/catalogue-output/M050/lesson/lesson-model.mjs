import * as K from '../../../../parts/ui/show/anatomy/iso-kit.mjs';
import * as G from '../../../../parts/ui/show/anatomy/lathe.mjs';
import { anatomyMaterialStyle } from '../../../../parts/screen-look/show/anatomy/iso-style.mjs';

const WIDTH = 920;
const HEIGHT = 500;
const projectBase = { x: -292, y: -62, w: 218, d: 124, r: 8 };
const floor = { x: -340, y: -122, w: 650, d: 244, r: 8 };
const bounds = [
  ...K.boxCorners(floor, -10, 0),
  ...K.boxCorners(projectBase, 0, 118),
  ...K.boxCorners({ x: 175, y: -38, w: 68, d: 76 }, 80, 220),
  [165, -2, 270], [250, 2, 0],
];
const projection = K.fitProjection(bounds, WIDTH, HEIGHT, { pad: 48, azimuth: 42, elevation: 30 });
const rect = (x, y, w, d, r = 2) => ({ x, y, w, d, r });
const solid = (shape, tone, extra = {}) => K.solidSvg(shape, { tone, ...extra });
const box = (plan, z, height, tone, extra = {}) => solid(K.slabOf(plan, z, height, projection, 8, 2), tone, extra);
const L = (from, to, tone = 'lo', width = 2) => {
  const d = K.segment(from, to, projection);
  return `<path d="${d}" fill="none" stroke="var(--anatomy-${tone})" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
};
const person = () => {
  const head = solid(G.sphereOf([204, 0, 241], 28, projection, { steps: 48 }), 'hi', { crease: 'none', lit: true });
  const shirt = [
    box(rect(169, -37, 70, 74, 5), 112, 92, 'mid', { crease: 'lo' }),
    L([175, 0, 184], [150, 0, 130], 'mid', 10),
    L([233, 0, 184], [258, 0, 130], 'mid', 10),
  ].join('');
  const hips = box(rect(176, -34, 57, 68, 3), 84, 28, 'lo', { crease: 'mid' });
  const legs = [
    K.cylinder(189, 0, 11, 5, 80, projection, 28, 1),
    K.cylinder(221, 0, 11, 5, 80, projection, 28, 1),
  ].map(shape => solid(shape, 'blue', { crease: 'lo' })).join('');
  const hands = [149, 259].map(x => solid(G.sphereOf([x, 0, 126], 10, projection, { steps: 32 }), 'hi', { crease: 'none' })).join('');
  const shoes = [
    box(rect(176, -19, 28, 36, 3), 0, 8, 'lo'),
    box(rect(208, -19, 28, 36, 3), 0, 8, 'lo'),
  ].join('');
  return `<g data-part="same-person">${legs}${shoes}${hips}<g style="${anatomyMaterialStyle('shirt')}">${shirt}</g><g style="${anatomyMaterialStyle('skin')}">${head}${hands}</g></g>`;
};

function project(outcome) {
  const body = `<g style="${anatomyMaterialStyle('wood')}">${box(projectBase, 0, 100, 'mid', { crease: 'lo' })}</g>`;
  const floorBody = `<g style="${anatomyMaterialStyle('ground')}">${box(floor, -10, 10, 'lo', { crease: 'none' })}</g>`;
  const frontSeam = [
    L([-280, -62, 56], [-86, -62, 56], 'lo', 2),
    L([-281, -62, 27], [-190, -62, 27], 'faint', 1.5),
    L([-185, -62, 27], [-92, -62, 27], 'faint', 1.5),
  ].join('');
  const closedLid = box(rect(-302, -72, 238, 144, 5), 100, 16, 'hi', { lit: true, crease: 'lo' });
  const displacedLid = box(rect(-44, 38, 176, 108, 5), 34, 14, 'hi', { crease: 'lo' });
  const readyMark = [
    L([-258, -63, 65], [-239, -63, 47], 'green', 6),
    L([-239, -63, 47], [-207, -63, 78], 'green', 6),
  ].join('');
  const repairMark = [
    L([-265, -63, 65], [-244, -63, 43], 'red', 6),
    L([-244, -63, 43], [-219, -63, 70], 'red', 6),
  ].join('');
  const projectState = outcome === 'ready'
    ? `<g data-part="project-ready">${body}${closedLid}${frontSeam}${readyMark}</g>`
    : `<g data-part="project-needs-repair">${body}${displacedLid}${frontSeam}${repairMark}</g>`;
  return { floor: floorBody, state: projectState };
}

export function renderProjectComparison(outcome = 'repair', labels = {}) {
  if (!['ready', 'repair'].includes(outcome)) throw new TypeError('Unknown project outcome');
  const projectParts = project(outcome);
  const personMarkup = person();
  const label = labels.figureDescription ?? 'An illustrative project box changes from a closed, ready-to-ship state to a displaced-panel state that needs repair. The same person figure is unchanged across both states. The scene asks whether the project result establishes the quoted proposition; it does not answer the question.';
  const body = `${projectParts.floor}${projectParts.state}${personMarkup}`;
  return {
    svg: K.figureSvg({ width: WIDTH, height: HEIGHT, label, body }),
    label,
    outcome,
    personMarkup,
    projectMarkup: projectParts.state,
    parts: ['project-ready', 'project-needs-repair', 'same-person'],
  };
}
