// A still Anatomy figure for the source's attention/return distinction.
// Geometry is illustrative; the shared Anatomy kit owns projection and painting.
import * as K from '../../../../parts/ui/show/anatomy/iso-kit.mjs';
import * as G from '../../../../parts/ui/show/anatomy/lathe.mjs';
import { anatomyMaterialStyle } from '../../../../parts/screen-look/show/anatomy/iso-style.mjs';

export const WIDTH = 800;
export const HEIGHT = 1000;
const target = [0, 0, -375];
const thought = [0, 0, 0];
const judgment = [-180, 0, 240];
const notice = [180, 0, -150];
const bounds = [
  [-380, 0, -460], [380, 0, -460], [-380, 0, 420], [380, 0, 420],
  target, thought, judgment, notice,
];
const projection = K.fitProjection(bounds, WIDTH, HEIGHT, { pad: 40, azimuth: 90, elevation: 0 });
const at = ([x, y, z]) => K.iso([x, y, z], projection);
const xy = ([x, y]) => `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
const tones = { strain: 'red', returnPath: 'green' };

function line(from, to, via, tone) {
  const source = at(from);
  const destination = at(to);
  const route = via.map(at);
  return `${K.wireSvg(source, destination, { via: route, tone, ends: 'none' })}${arrowHead(route.at(-1) ?? source, destination, tone)}`;
}

function arrowHead(from, to, tone) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const baseX = to[0] - ux * 14;
  const baseY = to[1] - uy * 14;
  const sideX = -uy * 6;
  const sideY = ux * 6;
  const points = [[to[0], to[1]], [baseX + sideX, baseY + sideY], [baseX - sideX, baseY - sideY]];
  return `<path d="${K.pathOf(points, true)}" fill="var(--anatomy-${tone})"/>`;
}

function ellipse(center3, rx, rz, { fill, stroke, width = 3, opacity = 1 } = {}) {
  const center = at(center3);
  const scale = K.cameraOf(projection).k;
  const points = Array.from({ length: 64 }, (_, index) => {
    const angle = (index / 64) * Math.PI * 2;
    return [center[0] + Math.cos(angle) * rx * scale, center[1] + Math.sin(angle) * rz * scale];
  });
  return `<path d="${K.pathOf(points, true)}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function textAt(center3, words, { size = 19, tone = 'hi', y = 0 } = {}) {
  const [x, cy] = at(center3);
  return K.faceTextSvg(`translate(${xy([x, cy + y])})`, words, { size, tone, anchor: 'middle' });
}

function group(part, content, opacity = 1) {
  return `<g data-part="${part}" opacity="${opacity}">${content}</g>`;
}

export function renderAttentionDiagram(highlight = 'returnPath', labels = {}) {
  if (!Object.hasOwn(tones, highlight)) throw new TypeError('Unknown attention response path');
  const tone = tones[highlight];
  const inactiveOpacity = 0.58;
  const strainOpacity = highlight === 'strain' ? 1 : inactiveOpacity;
  const returnOpacity = highlight === 'returnPath' ? 1 : inactiveOpacity;

  const targetScreen = at(target);
  const targetGeometry = `<g style="${anatomyMaterialStyle('brass')}">${K.solidSvg(G.sphereOf(target, 18, projection, { steps: 36 }), { tone: 'hi', crease: 'none', lit: true })}</g>`;
  const thoughtBubble = `${ellipse(thought, 220, 86, { fill: 'var(--anatomy-paper)', stroke: 'var(--anatomy-lo)' })}${textAt(thought, "Tomorrow's", { size: 34, y: -20 })}${textAt(thought, 'appointment', { size: 34, y: 20 })}`;
  const judgmentBubble = `${ellipse(judgment, 178, 86, { fill: 'var(--anatomy-paper)', stroke: 'var(--anatomy-red)', width: 4 })}${textAt(judgment, "I shouldn't be", { size: 28, tone: 'red', y: -22 })}${textAt(judgment, 'thinking this', { size: 28, tone: 'red', y: 22 })}`;
  const noticeBubble = `${ellipse(notice, 192, 86, { fill: 'var(--anatomy-paper)', stroke: 'var(--anatomy-green)', width: 4 })}${textAt(notice, 'Notice wandering', { size: 30, tone: 'green' })}`;

  const common = group('chosen-point-to-thought', line([0, 0, -348], [0, 0, -48], [[0, 0, -210]], 'mid'));
  const strainLinks = group('straining-loop', [
    line([0, 0, 55], [-12, 0, 230], [[-18, 0, 110], [-16, 0, 180]], 'red'),
    line([-345, 0, 270], [0, 0, 58], [[-370, 0, 335], [-300, 0, 400], [-80, 0, 390], [24, 0, 210]], 'red'),
  ].join(''), strainOpacity);
  const returnLinks = group('notice-and-return', [
    line([20, 0, -55], [-4, 0, -150], [[65, 0, -72], [95, 0, -112]], 'green'),
    line([180, 0, -236], [0, 0, -360], [[300, 0, -290], [300, 0, -430], [100, 0, -450]], 'green'),
  ].join(''), returnOpacity);
  const samePoint = `${targetGeometry}<g style="${anatomyMaterialStyle('brass')}"><circle cx="${targetScreen[0]}" cy="${targetScreen[1]}" r="14" fill="var(--anatomy-hi)" stroke="var(--anatomy-lo)" stroke-width="2"/></g>`;
  const pointLabel = textAt([-112, 0, -392], 'Chosen point', { size: 24, tone: 'hi' });
  const body = [
    common,
    strainLinks,
    returnLinks,
    group('thought-example', thoughtBubble),
    group('judgment', judgmentBubble, strainOpacity),
    group('notice', noticeBubble, returnOpacity),
    group('same-visual-point', `${samePoint}${pointLabel}`),
  ];
  return {
    svg: K.figureSvg({ width: WIDTH, height: HEIGHT, label: labels.diagramDescription ?? 'The same visual point anchors both response paths.', body }),
    label: labels.diagramDescription ?? 'The same visual point anchors both response paths.',
    parts: ['chosen-point-to-thought', 'straining-loop', 'notice-and-return', 'thought-example', 'judgment', 'notice', 'same-visual-point'],
    highlighted: highlight,
    returnTarget: 'same-visual-point',
    activeTone: tone,
  };
}
