/*!
MIT License

Copyright (c) 2026 Ryan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// A source-bounded scene adapter over the existing MIT Anatomy court owner.
// It depicts one illustrative exchange; it does not infer private states or
// long-term patterns from player poses.
import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const FACETS = Object.freeze([
  'distinction',
  'existence',
  'space',
  'time',
  'subject-object',
  'self-environment',
  'preference',
]);
export const OBSERVATIONS = Object.freeze(['observed', 'opposite', 'neither', 'unknown']);
export const VIEWPOINTS = Object.freeze(['player', 'opponent', 'spectator']);
export const DURATIONS = Object.freeze([
  'moment',
  'repeated-action',
  'continued-focus',
  'developed-retained-understanding',
  'continued-preference',
  'passing-or-sustained-state',
]);
export const CLAIMS = Object.freeze([
  'opponent-visible',
  'player-position',
  'opponent-position',
  'ball-path',
  'next-shot',
  'fear',
  'hope',
  'want-return-in-court',
  'player-thought',
  'player-feeling',
  'player-body',
  'repeated-action',
  'continued-focus',
  'developed-understanding',
  'continued-preference',
]);

const courtPositions = Object.freeze({
  near: Object.freeze({ x: 38, y: -205 }),
  far: Object.freeze({ x: -30, y: 212 }),
});
const courtTarget = Object.freeze([20, 235, 3]);
const baselineY = 260;
const singlesHalfWidth = 100;
const arcHeight = 72;
const endpointInsideCourt = Math.abs(courtTarget[0]) <= singlesHalfWidth && Math.abs(courtTarget[1]) <= baselineY;
const viewpointFocus = Object.freeze({
  player: 'agent',
  opponent: 'opponent',
  spectator: 'bystander',
});

// These relations describe only what the source or this illustration can
// support. They are independent of the learner's selected observation status.
const claimEvidence = Object.freeze({
  'opponent-visible': {
    relation: 'supported', basis: 'illustration',
    statement: 'The staged court illustration depicts an opponent figure.',
    scope: 'Depiction only; it does not establish what a real opponent did or intended.',
  },
  'player-position': {
    relation: 'supported', basis: 'illustration',
    statement: 'The staged illustration places the player on the near side of the court.',
    scope: 'A model position, not a measured player location.',
  },
  'opponent-position': {
    relation: 'supported', basis: 'illustration',
    statement: 'The staged illustration places the opponent on the far side of the court.',
    scope: 'A model position, not a measured player location.',
  },
  'ball-path': {
    relation: 'supported', basis: 'illustration',
    statement: 'The drawing shows a ball marker along one fixed illustrative path.',
    scope: 'The path and arc are authored illustration values, not measured tennis data or causal evidence.',
  },
  'next-shot': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'The next shot is not shown or determined by this scene.',
    scope: 'Not seeing a future action here does not establish that it will not happen.',
  },
  fear: {
    relation: 'unsupported', basis: 'not-established',
    statement: 'The illustration does not establish whether the player feels fear.',
    scope: 'A pose cannot establish a private feeling or its absence.',
  },
  hope: {
    relation: 'unsupported', basis: 'not-established',
    statement: 'The illustration does not establish whether the player feels hope.',
    scope: 'Fear and hope are separate states; one cannot be inferred from the other.',
  },
  'want-return-in-court': {
    relation: 'supported', basis: 'source-text',
    statement: 'The source describes wanting the return to land in court.',
    scope: 'This is a narrated example of preference, not something the drawing or ball path proves.',
  },
  'player-thought': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'The illustration does not establish a specific private thought.',
    scope: "The drawn pose is not evidence of the player's inner account.",
  },
  'player-feeling': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'The illustration does not establish a specific private feeling.',
    scope: 'A drawn pose is not a report of experience.',
  },
  'player-body': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'The illustration cannot establish that the player feels strain in their body.',
    scope: 'A body position is depicted, but bodily sensation is private and not measured here.',
  },
  'repeated-action': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'This one staged exchange does not show repeated action over time.',
    scope: 'One action alone does not establish a habit.',
  },
  'continued-focus': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'This one staged exchange does not establish focus continuing over time.',
    scope: 'A pose or single point in an exchange does not establish concentration.',
  },
  'developed-understanding': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'This scene does not show understanding developing and being retained.',
    scope: 'A single court illustration cannot establish expertise.',
  },
  'continued-preference': {
    relation: 'unsupported', basis: 'not-established',
    statement: 'This scene does not show a preference continuing over time.',
    scope: 'A source-stated preference in one example does not establish a continuing value.',
  },
});

const durationDescriptions = Object.freeze({
  moment: 'One staged scene position supports a description of that moment only; real elapsed time is not measured.',
  'repeated-action': 'The source says repeated action may become habit; this scene does not show repetitions.',
  'continued-focus': 'The source says focus that continues may become concentration; this scene does not show duration.',
  'developed-retained-understanding': 'The source says developed and retained understanding may count as expertise; this scene has no learning history.',
  'continued-preference': 'The source says preference that continues may count as value; this scene has no preference history.',
  'passing-or-sustained-state': 'The source allows hope, fear, opportunity or threat to be passing or sustained; this scene establishes none of those private states.',
});

const seed = renderContext({
  mode: 'court',
  time: 0,
  focus: 'all',
  courtState: {
    ...courtPositions,
    shot: { from: 'near', to: 'far', progress: 0, arcHeight: 0 },
  },
});
const contactPoint = Object.freeze([...seed.state.courtState.nearContact]);

function requireChoice(value, choices, name) {
  if (!choices.includes(value)) throw new TypeError(`Unknown ${name}: ${String(value)}`);
}

/**
 * Render one court example and return a separate, non-inferred evidence map.
 * The selected observation is the learner's answer; it never changes the
 * court, player positions, staged path, or source-supported claim relation.
 */
export function awarenessScene({
  facet = 'distinction',
  viewpoint = 'player',
  selectedObservation = 'observed',
  duration = 'moment',
  progress = 0.5,
  claim = 'opponent-visible',
} = {}) {
  requireChoice(facet, FACETS, 'facet');
  requireChoice(viewpoint, VIEWPOINTS, 'viewpoint');
  requireChoice(selectedObservation, OBSERVATIONS, 'observation');
  requireChoice(duration, DURATIONS, 'duration');
  requireChoice(claim, CLAIMS, 'claim');
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new RangeError('Progress must be a finite value from 0 to 1');
  }

  const scene = renderContext({
    mode: 'court',
    time: 0,
    variant: 'normal',
    focus: viewpointFocus[viewpoint],
    shotTime: progress,
    courtState: {
      ...courtPositions,
      shot: {
        from: contactPoint,
        to: courtTarget,
        progress,
        arcHeight,
      },
    },
  });
  const relation = claimEvidence[claim];

  return {
    ...scene,
    state: {
      ...scene.state,
      facet,
      viewpoint,
      viewpointFocus: viewpointFocus[viewpoint],
      viewpointScope: 'Highlights the selected figure in a fixed court camera; it does not recreate that person’s eyesight or establish what they noticed.',
      selectedObservation,
      selectionChangesEvidence: false,
      claimRelation: { claim, ...relation },
      supportedEvidence: [
        {
          id: 'illustrated-court-and-players',
          basis: 'illustration',
          statement: 'The scene depicts the near player, far opponent, spectator, ball marker, court, net and baseline.',
          scope: 'Staged geometry only; these figures are not footage or measured performance.',
        },
        {
          id: 'illustrated-ball-position',
          basis: 'illustration',
          statement: 'The ball marker occupies the reported position on the authored path at this progress value.',
          scope: 'The chosen progress is a point within one illustrative exchange, not a real timestamp.',
        },
      ],
      sourceEvidence: [
        {
          id: 'source-stated-preference',
          basis: 'source-text',
          statement: 'The source describes wanting the return to land in court.',
          scope: 'A narrated preference does not establish that the observed ball path matches the wish.',
        },
      ],
      durationRelation: {
        selection: duration,
        supportedByScene: duration === 'moment',
        historicalDurationEstablished: false,
        basis: duration === 'moment' ? 'illustration' : 'not-established',
        statement: durationDescriptions[duration],
        scope: 'Only one staged exchange is represented; no real elapsed time or repeated, retained or sustained history is measured.',
      },
      illustrative: true,
      trajectory: {
        from: [...contactPoint],
        to: [...courtTarget],
        progress,
        baselineY,
        arcHeight,
        singlesHalfWidth,
        endpointInsideCourt,
      },
    },
  };
}
