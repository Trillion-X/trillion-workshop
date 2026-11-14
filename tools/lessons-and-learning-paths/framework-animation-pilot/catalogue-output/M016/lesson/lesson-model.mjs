// Two concrete practice-space tasks reuse the existing court, players and ball
// path. Selecting a task changes player positions and where the feed travels.
import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';
import { sceneViewport } from '../../M010/lesson/lesson-model.mjs';

export const MODE_IDS = Object.freeze(['wide-return', 'cross-court']);
export const INITIAL_MODE = 'wide-return';

const TASKS = Object.freeze({
  'wide-return': Object.freeze({
    near: Object.freeze({ x: -96, y: -205 }),
    far: Object.freeze({ x: 24, y: 212 }),
    shot: Object.freeze({ from: 'far', to: 'near', progress: 0.82, arcHeight: 55 }),
  }),
  'cross-court': Object.freeze({
    near: Object.freeze({ x: 0, y: -205 }),
    far: Object.freeze({ x: 104, y: 212 }),
    shot: Object.freeze({ from: 'near', to: 'far', progress: 0.82, arcHeight: 55 }),
  }),
});

export function sceneForTask(mode, figureLabel) {
  if (!MODE_IDS.includes(mode)) throw new TypeError(`Unknown M016 practice task: ${String(mode)}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) {
    throw new TypeError('M016 scene needs its caller-owned accessible figure name.');
  }
  const figure = renderContext({
    mode: 'court',
    time: 0,
    shotTime: 0.82,
    variant: 'normal',
    focus: 'all',
    courtState: TASKS[mode],
    view: 'wide',
    figureLabel,
  });
  return {
    ...figure,
    viewport: sceneViewport(figure),
    state: { ...figure.state, practiceTask: mode, illustrative: true },
  };
}
