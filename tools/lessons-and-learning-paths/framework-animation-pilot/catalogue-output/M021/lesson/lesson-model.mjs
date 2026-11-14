// M021's court is a caller-staged view of the existing licensed Anatomy model.
// The example changes only the named preparation, feed, and returned-ball inputs.
import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const CASE_IDS = Object.freeze([
  'miss-only',
  'matched-improvement',
  'matched-no-improvement',
  'feed-also-changed',
]);

export const VERDICT_IDS = Object.freeze(['supported', 'rejected', 'unresolved']);
export const INITIAL_CASE = 'miss-only';
export const INITIAL_VERDICT = null;

const CASE_MODEL = Object.freeze({
  'miss-only': Object.freeze({ preparation: 1, feedShift: 0, returnSeen: false, teachingVerdict: 'unresolved' }),
  'matched-improvement': Object.freeze({ preparation: 0, feedShift: 0, returnSeen: true, teachingVerdict: 'supported' }),
  'matched-no-improvement': Object.freeze({ preparation: 0, feedShift: 0, returnSeen: false, teachingVerdict: 'rejected' }),
  'feed-also-changed': Object.freeze({ preparation: 0, feedShift: 34, returnSeen: true, teachingVerdict: 'unresolved' }),
});

function caseId(value) {
  if (!CASE_IDS.includes(value)) throw new TypeError(`Unknown M021 evidence case: ${String(value)}`);
  return value;
}

function verdictId(value) {
  if (!VERDICT_IDS.includes(value)) throw new TypeError(`Unknown M021 verdict: ${String(value)}`);
  return value;
}

function offset(point, amount) {
  return [point[0] + amount, point[1], point[2]];
}

export function evidenceScene({ selectedCase = INITIAL_CASE, label } = {}) {
  const id = caseId(selectedCase);
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('M021 scene needs caller-owned accessible words.');
  const input = CASE_MODEL[id];

  // Read the actual Anatomy model's normal contact endpoints once. The ball
  // track below uses absolute world points so a timing change cannot move the
  // incoming feed along with the receiving player's racket.
  const reference = renderContext({
    mode: 'court',
    view: 'player',
    shotTime: 0.5,
    figureLabel: label,
    courtState: { near: { swingPhase: 0 } },
  });
  const normalFrom = reference.state.courtState.from;
  const normalTo = reference.state.courtState.to;
  const feedFrom = offset(normalFrom, input.feedShift);
  const feedTo = offset(normalTo, input.feedShift);
  const shot = input.returnSeen
    ? { from: feedTo, to: feedFrom, progress: 0.84, arcHeight: 54 }
    : { from: feedFrom, to: feedTo, progress: 0.9, arcHeight: 38 };
  const figure = renderContext({
    mode: 'court',
    view: 'player',
    time: 0,
    shotTime: 0.5,
    figureLabel: label,
    courtState: {
      near: { swingPhase: input.preparation },
      shot,
    },
  });

  return {
    ...figure,
    viewport: [-80, -100, 2080, 1320],
    state: {
      ...figure.state,
      caseId: id,
      input: { ...input },
      teachingVerdict: input.teachingVerdict,
      comparison: {
        incomingPath: [...feedFrom, ...feedTo],
        returnSeen: input.returnSeen,
      },
      illustrative: true,
      empiricalOutcome: null,
    },
  };
}

export function selectedVerdict(value) {
  return value === null ? null : verdictId(value);
}
