// M002's school and reusable-lesson contrast is illustrative. The scenario
// shows work moving through each arrangement; it does not score a winner.
import * as K from '../../../../../ui/show/anatomy/iso-kit.mjs';
import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const ARRANGEMENTS = Object.freeze(['founder-queue', 'shared-lesson']);
export const LEARNER_CASES = Object.freeze(['can-use-lesson', 'needs-human-support']);

const WIDTH = 1920;
const HEIGHT = 1080;
const bounds = [
  [-650, -500, 0], [-650, 500, 0], [650, -500, 0], [650, 500, 0],
];
const projection = K.fitProjection(bounds, WIDTH, HEIGHT, { pad: 48, azimuth: 38, elevation: 30 });
const plan = (x, y, w, d, r = 2) => ({ x, y, w, d, r });

// `renderPersonContext` fits these declared source-world bounds. Project those
// bounds about the real ankle midpoint, then combine them with the common
// school platform and every actor anchor used by either arrangement. The
// resulting view is stable across learner count and support choices.
const personBounds = { x: -65, y: -45, w: 130, d: 150, r: 0 };
const sourcePersonExtents = [
  { pose: 'standing', held: [] },
  { pose: 'seated', held: ['notebook'] },
].map(({ pose, held }) => {
  const reference = renderPersonContext({ pose, held, label: `Viewport ${pose} person`, ground: false });
  const ankles = reference.state.joints.ankles;
  const foot = K.iso([
    (ankles[0][0] + ankles[1][0]) / 2,
    (ankles[0][1] + ankles[1][1]) / 2,
    0,
  ], reference.state.projection);
  return K.boxCorners(personBounds, 0, 145)
    .map(point => K.iso(point, reference.state.projection).slice(0, 2).map((coordinate, axis) => coordinate - foot[axis]));
}).flat();
const relativePersonExtents = {
  minX: Math.min(...sourcePersonExtents.map(([x]) => x)) * 0.69,
  maxX: Math.max(...sourcePersonExtents.map(([x]) => x)) * 0.69,
  minY: Math.min(...sourcePersonExtents.map(([, y]) => y)) * 0.69,
  maxY: Math.max(...sourcePersonExtents.map(([, y]) => y)) * 0.69,
};
const actorFootPoints = [
  [-520, -20],
  [-280, 150], [-60, 70], [160, -10], [380, -90],
  [150, 190], [420, 190], [150, -190], [420, -190],
  [380, -330], [420, -430],
];
const outerWorldCorners = K.boxCorners({ x: -640, y: -490, w: 1280, d: 980, r: 0 }, -8, 75)
  .map(point => K.iso(point, projection));
const actorScreenCorners = actorFootPoints.flatMap(([x, y]) => {
  const [screenX, screenY] = K.iso([x, y, 0], projection);
  return [
    [screenX + relativePersonExtents.minX, screenY + relativePersonExtents.minY],
    [screenX + relativePersonExtents.maxX, screenY + relativePersonExtents.maxY],
  ];
});
const viewportPoints = [...outerWorldCorners, ...actorScreenCorners];
const viewportPad = 48;
const minViewportX = Math.min(...viewportPoints.map(([x]) => x)) - viewportPad;
const minViewportY = Math.min(...viewportPoints.map(([, y]) => y)) - viewportPad;
const maxViewportX = Math.max(...viewportPoints.map(([x]) => x)) + viewportPad;
const maxViewportY = Math.max(...viewportPoints.map(([, y]) => y)) + viewportPad;
export const SCENE_VIEWPORT = Object.freeze([
  Math.floor(minViewportX), Math.floor(minViewportY),
  Math.ceil(maxViewportX - minViewportX), Math.ceil(maxViewportY - minViewportY),
]);

// Match the mapped-anchor composition used by instruction-case.mjs. Every
// person, desk, chair and notebook comes from the existing Anatomy context
// asset; this file only positions those complete figures in the school scene.
function person(id, x, y, role = 'learner', arrangement = 'founder-queue') {
  const seated = role === 'founder' ? arrangement === 'shared-lesson' : role === 'learner' ? arrangement === 'shared-lesson' : false;
  const held = seated ? ['notebook'] : [];
  const label = role === 'founder' ? 'Founder at work' : role === 'support' ? 'Person offering human support' : 'Learner';
  const figure = renderPersonContext({ pose: seated ? 'seated' : 'standing', held, time: 0, label, ground: false });
  const ankles = figure.state.joints.ankles;
  const foot = [
    (ankles[0][0] + ankles[1][0]) / 2,
    (ankles[0][1] + ankles[1][1]) / 2,
    0,
  ];
  const origin = K.iso(foot, figure.state.projection);
  const target = K.iso([x, y, 0], projection);
  // The person context occupies the same figure scale as the curated
  // instruction-case composition. Anchor soles to the shared floor plane.
  const scale = 0.69;
  const copyId = role === 'learner' && arrangement === 'shared-lesson' ? `lesson-copy-${id}` : null;
  const personSvg = copyId
    ? figure.svg.replace('data-scene-part="notebook-cover"', `data-scene-part="notebook-cover" data-part="${copyId}"`)
    : figure.svg;
  const mapped = `<g transform="translate(${target[0]} ${target[1]}) scale(${scale}) translate(${-origin[0]} ${-origin[1]})">${personSvg}</g>`;
  return {
    at: [x, y, 0],
    id,
    html: mapped,
    copyId,
    source: { asset: 'context-model.renderPersonContext', pose: seated ? 'seated' : 'standing', held, ground: false, mapping: 'grounded-foot-anchor' },
  };
}

/**
 * Render the two source-backed school arrangements.
 * learnerCount is an illustrative cohort size, not observed data.
 */
export function lessonScene({ arrangement = 'founder-queue', learnerCase = 'can-use-lesson', learnerCount = 3 } = {}) {
  if (!ARRANGEMENTS.includes(arrangement)) throw new TypeError(`Unknown M002 arrangement: ${String(arrangement)}`);
  if (!LEARNER_CASES.includes(learnerCase)) throw new TypeError(`Unknown M002 learner case: ${String(learnerCase)}`);
  if (!Number.isInteger(learnerCount) || learnerCount < 1 || learnerCount > 4) throw new RangeError('learnerCount must be an illustrative integer from 1 to 4');

  const parts = [];
  const partIds = [];
  const add = (id, at, html) => {
    parts.push({ id, at, html: K.groupSvg(html, { 'data-part': id }) });
    partIds.push(id);
  };
  const box = (x, y, w, d, z, h, tone, r = 2) => K.solidSvg(K.slabOf(plan(x, y, w, d, r), z, h, projection, 6, 0.45), { tone, crease: 'faint' });
  const line = (from, to, tone = 'lo', dashed = false) => K.lineSvg(K.segment(from, to, projection), { tone, dashed, free: true });

  // A shared floor keeps positions comparable when the arrangement changes.
  add('school-floor', [0, 0, 0], box(-640, -490, 1280, 980, -8, 8, 'faint', 18));
  const founder = person('founder-body', -520, -20, 'founder', arrangement);
  add('founder', founder.at, founder.html);
  if (arrangement === 'founder-queue') {
    add('founder-worktable', [-516, 12, 15], box(-557, -9, 82, 42, 8, 15, 'lo', 3));
    add('founder-table-top', [-516, 12, 25], box(-554, -6, 76, 36, 23, 3, 'mid', 2));
  }

  const learners = Array.from({ length: learnerCount }, (_, index) => {
    const x = arrangement === 'founder-queue' ? -280 + index * 220 : 150 + (index % 2) * 270;
    const y = arrangement === 'founder-queue' ? 150 - index * 80 : 190 - Math.floor(index / 2) * 380;
    return { id: `learner-${index + 1}`, x, y };
  });

  if (arrangement === 'founder-queue') {
    // One conversation is at the table; the others wait in the visible line.
    for (let index = 0; index < learners.length; index++) {
      const learner = learners[index];
      const pose = person(learner.id, learner.x, learner.y, 'learner', arrangement);
      add(learner.id, pose.at, pose.html);
      if (index > 0) add(`wait-marker-${index}`, [learner.x, learner.y, 4], box(learner.x - 8, learner.y - 8, 16, 16, 0, 3, 'lo', 2));
    }
    for (let index = 0; index < learners.length - 1; index++) {
      const a = learners[index];
      const b = learners[index + 1];
      add(`queue-link-${index + 1}`, [(a.x + b.x) / 2, (a.y + b.y) / 2, 7], line([a.x, a.y, 8], [b.x, b.y, 8], 'lo', true));
    }
    add('active-explanation', [-400, 70, 62], line([-520, -20, 98], [learners[0].x, learners[0].y, 45], 'lit'));
  } else {
    // One authored lesson is placed on a stand; each learner gets a copy.
    add('lesson-source-stand', [-90, -35, 12], box(-160, -90, 140, 110, 8, 12, 'lo', 4));
    add('lesson-source', [-90, -35, 25], box(-145, -80, 110, 85, 20, 5, 'hi', 2));
    add('lesson-source-rule-1', [-90, -52, 27], line([-132, -52, 25.4], [-48, -52, 25.4], 'lit'));
    add('lesson-source-rule-2', [-90, -30, 27], line([-132, -30, 25.4], [-62, -30, 25.4], 'mid'));
    for (const learner of learners) {
      const pose = person(learner.id, learner.x, learner.y, 'learner', arrangement);
      add(learner.id, pose.at, pose.html);
      if (pose.copyId) partIds.push(pose.copyId);
      add(`reuse-link-${learner.id}`, [30, learner.y / 2, 21], line([-40, -20, 22], [learner.x + 12, learner.y - 8, 12], 'lit'));
    }
    // A small toll gate marks a possible price barrier; it does not claim who
    // can afford the resource or who actually gains access.
    add('price-barrier', [68, -35, 22], [
      box(48, -76, 8, 82, 0, 42, 'lo', 2),
      box(88, -76, 8, 82, 0, 42, 'lo', 2),
      box(56, -35, 40, 7, 34, 6, 'mid', 2),
    ].join(''));
    add('price-path', [76, 15, 2], line([42, 15, 4], [102, 15, 4], 'faint', true));
  }

  let supportActor = null;
  if (learnerCase === 'needs-human-support') {
    const learner = learners[learners.length - 1];
    const helper = person('support-person-body', learner.x, learner.y - 240, 'support', arrangement);
    supportActor = helper.source;
    add('support-person', helper.at, helper.html);
    add('support-needed-learner', [learner.x, learner.y, 44], line([learner.x, learner.y - 240, 70], [learner.x, learner.y, 42], 'lit'));
    add('support-link', [learner.x, learner.y - 240, 14], box(learner.x - 8, learner.y - 248, 16, 16, 2, 3, 'lit', 2));
  }

  const svg = K.figureSvg({
    width: WIDTH,
    height: HEIGHT,
    label: arrangement === 'founder-queue'
      ? 'Illustrative school plan with a founder, learners in a queue, and one active explanation.'
      : learnerCase === 'needs-human-support'
        ? 'Illustrative shared lesson with learner support, one authored resource, copies, and a possible price barrier.'
        : 'Illustrative shared lesson with one authored resource, learner copies, and a possible price barrier.',
    body: [
      ...parts.filter(part => part.id === 'school-floor'),
      ...parts.filter(part => part.id !== 'school-floor').sort((a, b) => K.depthOf(a.at, projection) - K.depthOf(b.at, projection)),
    ].map(part => part.html).join(''),
  });

  return {
    svg,
    viewport: SCENE_VIEWPORT,
    partIds,
    state: {
      arrangement,
      learnerCase,
      learnerCount,
      illustrative: true,
      evidenceStatus: 'illustration-no-measured-winner',
      comparisonScope: 'example-only-not-a-fixed-taxonomy',
      figureAsset: 'anatomy-contact-replacement/context-model.mjs#renderPersonContext',
      relationships: {
        explanationsInExample: arrangement === 'founder-queue' ? learnerCount : 1,
        sharedLessonCopies: arrangement === 'shared-lesson' ? learnerCount : 0,
        waitingLearners: arrangement === 'founder-queue' ? Math.max(0, learnerCount - 1) : 0,
        humanSupportNeeded: learnerCase === 'needs-human-support',
        priceBarrier: arrangement === 'shared-lesson' ? 'possible' : 'not-shown',
      },
      actors: {
      founder: founder.source,
        learners: {
          asset: 'context-model.renderPersonContext',
          pose: arrangement === 'shared-lesson' ? 'seated' : 'standing',
          held: arrangement === 'shared-lesson' ? ['notebook'] : [],
          ground: false,
          mapping: 'grounded-foot-anchor',
          count: learnerCount,
        },
        support: supportActor,
      },
      objectives: {
        scope: 'source-backed-example',
        dimensions: ['depth', 'quality', 'reach', 'founder-time', 'learner-time', 'creation-effort', 'energy', 'resources', 'access', 'support', 'improvement-capacity'],
        exhaustive: false,
      },
      objectivesCanConflict: true,
      winner: null,
      score: null,
    },
  };
}
