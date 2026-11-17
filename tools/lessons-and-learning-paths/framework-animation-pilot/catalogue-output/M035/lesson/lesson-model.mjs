import * as Anatomy from '../../../../../ui/show/anatomy/iso-kit.mjs';

export const initialState = Object.freeze({
  sequenceIndex: 0,
  preparation: 'direct',
  task: 'explain',
  state: 'same',
  taskResult: 'unknown',
});

export function interpretationKey(state, taskResult) {
  return `${state}-${taskResult}`;
}

export function readout(content, state, taskResult) {
  const feeling = content.states.find(row => row.id === state)?.title;
  const result = content.taskResults.find(row => row.id === taskResult)?.title;
  return { feeling, result, explanation: content.interpretations[interpretationKey(state, taskResult)] };
}

const profile = [
  [177, 24], [214, 18], [249, 29], [275, 52], [291, 83], [297, 106],
  [314, 122], [296, 130], [289, 137], [302, 144], [288, 150], [282, 169],
  [267, 188], [244, 202], [218, 207], [192, 201], [172, 184], [159, 160],
  [152, 130], [153, 96], [160, 67], [174, 41], [177, 24],
];

const arrow = (points, tone) => {
  const tip = points.at(-1);
  const before = points.at(-2);
  const angle = Math.atan2(tip[1] - before[1], tip[0] - before[0]);
  const size = 12;
  const wing = offset => [tip[0] - size * Math.cos(angle + offset), tip[1] - size * Math.sin(angle + offset)];
  return [
    Anatomy.lineSvg(Anatomy.pathOf(points), { tone }),
    Anatomy.lineSvg(Anatomy.pathOf([tip, wing(-0.62)]), { tone }),
    Anatomy.lineSvg(Anatomy.pathOf([tip, wing(0.62)]), { tone }),
  ].join('');
};

const profileProjection = Object.freeze({ origin: [0, 0], scale: 1, azimuth: 90, elevation: 90 });
const profilePoint = point => Anatomy.iso([point[0], point[1], 3], profileProjection);
const projectPath = points => points.map(profilePoint);
const faceSilhouette = Anatomy.solidSvg(Anatomy.extrude(profile, 0, 3, profileProjection), { tone: 'lit', crease: 'none', flat: true, lit: true });

const landmarks = Object.freeze({
  noseTip: Object.freeze([314, 122]),
  nostril: Object.freeze([296, 130]),
  mouthEdge: Object.freeze([302, 144]),
});
const labelAnchors = Object.freeze({
  nose: Object.freeze([326, 108]),
  mouth: Object.freeze([326, 174]),
});

const base = [
  faceSilhouette,
  Anatomy.lineSvg(Anatomy.pathOf(projectPath([[194, 198], [190, 252]])), { tone: 'lo' }),
  Anatomy.lineSvg(Anatomy.pathOf(projectPath([[244, 198], [253, 252]])), { tone: 'lo' }),
  Anatomy.dotsSvg(projectPath([[225, 86], landmarks.nostril]), { size: 2.4, tone: 'lo' }),
  Anatomy.faceTextSvg(`translate(${profilePoint(labelAnchors.nose).join(' ')})`, 'NOSE', { size: 14, tone: 'mid' }),
  Anatomy.faceTextSvg(`translate(${profilePoint(labelAnchors.mouth).join(' ')})`, 'MOUTH', { size: 14, tone: 'mid' }),
].join('');

const flowSpecs = Object.freeze({
  nasalFirst: Object.freeze([[368, 118], landmarks.noseTip, landmarks.nostril, [245, 143]]),
  nasalSecondUpper: Object.freeze([[368, 110], [340, 117], landmarks.noseTip, landmarks.nostril, [245, 139]]),
  nasalSecondLower: Object.freeze([[368, 126], [340, 130], landmarks.noseTip, landmarks.nostril, [245, 149]]),
  mouthExhale: Object.freeze([[245, 159], [274, 153], landmarks.mouthEdge, [326, 151], [369, 151]]),
});
const flowPath = (name, points, tone) => {
  const projected = projectPath(points);
  return `<g data-m035-flow-path="${name}">${arrow(projected, tone)}</g>`;
};
export const sequenceGeometryEvidence = Object.freeze({
  projection: profileProjection,
  profile: Object.freeze(profile.map(point => Object.freeze(point))),
  labelAnchors: Object.freeze(Object.fromEntries(Object.entries(labelAnchors).map(([name, point]) => [name, Object.freeze({ sourcePoint: point, projectedPoint: Object.freeze(profilePoint(point)) })]))),
  landmarks: Object.freeze(Object.fromEntries(Object.entries(landmarks).map(([name, point]) => [name, Object.freeze({ sourcePoint: point, projectedPoint: Object.freeze(profilePoint(point)) })]))),
  paths: Object.freeze(Object.fromEntries(Object.entries(flowSpecs).map(([name, sourcePoints]) => [name, Object.freeze({ sourcePoints, projectedPoints: Object.freeze(projectPath(sourcePoints).map(point => Object.freeze(point))) })]))),
});

const inhaleOne = flowPath('nasalFirst', flowSpecs.nasalFirst, 'blue');
const inhaleTwo = [
  flowPath('nasalSecondUpper', flowSpecs.nasalSecondUpper, 'blue'),
  flowPath('nasalSecondLower', flowSpecs.nasalSecondLower, 'blue'),
].join('');
const exhale = flowPath('mouthExhale', flowSpecs.mouthExhale, 'red');

export const sequenceFigures = Object.freeze([
  { svg: Anatomy.figureSvg({ width: 520, height: 280, label: 'Side profile. A blue arrow enters through the nose and points inward for the first nasal inhale.', body: base + inhaleOne }), label: 'First nasal inhale: arrow enters through the nose.' },
  { svg: Anatomy.figureSvg({ width: 520, height: 280, label: 'Side profile. Two blue arrows enter through the nose, showing the second inhale added to the first.', body: base + inhaleTwo }), label: 'Second nasal inhale: a second inward arrow joins the first.' },
  { svg: Anatomy.figureSvg({ width: 520, height: 280, label: 'Side profile. A red arrow points outward through the mouth for the exhale.', body: base + exhale }), label: 'Mouth exhale: the arrow points outward through the mouth.' },
]);

export function sequenceFigure(index) {
  if (!Number.isInteger(index) || index < 0 || index >= sequenceFigures.length) throw new RangeError('Unknown breathing-sequence illustration.');
  return sequenceFigures[index];
}
