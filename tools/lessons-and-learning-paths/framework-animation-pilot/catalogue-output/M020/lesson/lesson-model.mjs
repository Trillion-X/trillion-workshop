import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const CAUSE_IDS = Object.freeze(['incoming', 'reach', 'late']);
export const INITIAL_CAUSE = 'late';
export const STATUS_IDS = Object.freeze(['present', 'absent', 'unknown']);

const CAUSE_VARIANTS = Object.freeze({
  incoming: 'incoming',
  reach: 'reach',
  late: 'late',
});

const causeId = value => {
  if (!CAUSE_IDS.includes(value)) throw new TypeError(`Unknown M020 candidate condition: ${String(value)}`);
  return value;
};

export function candidateScene({ cause = INITIAL_CAUSE, label } = {}) {
  causeId(cause);
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('M020 scene needs caller-owned accessible words.');
  const scene = renderContext({
    mode: 'court',
    view: 'player',
    time: 0,
    shotTime: 0.47,
    variant: CAUSE_VARIANTS[cause],
    focus: 'all',
    figureLabel: label,
  });
  return {
    ...scene,
    viewport: [-80, -100, 2080, 1320],
    state: {
      ...scene.state,
      candidate: cause,
      illustrative: true,
      outcome: null,
    },
  };
}

export function statusId(value) {
  if (!STATUS_IDS.includes(value)) throw new TypeError(`Unknown M020 evidence status: ${String(value)}`);
  return value;
}
