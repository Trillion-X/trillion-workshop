// One fixed outer tennis point; changing attention never invents a private state.
import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';
import {
  COURT_EVENT,
  EVENT_TIME,
  SHOT_TIME,
  sceneViewport,
} from '../../M010/lesson/lesson-model.mjs';

export const SIDE_IDS = Object.freeze(['inner', 'outer']);
export const DEFAULT_SIDE = 'inner';
export const TENNIS_EVENT = COURT_EVENT;

export function sceneForSide(side, figureLabel) {
  if (!SIDE_IDS.includes(side)) throw new TypeError(`Unknown M011 attention side: ${String(side)}`);
  if (typeof figureLabel !== 'string' || !figureLabel.trim()) {
    throw new TypeError('M011 figure needs caller-owned accessibility words');
  }

  const scene = renderContext({
    mode: 'court',
    time: EVENT_TIME,
    shotTime: SHOT_TIME,
    variant: 'normal',
    focus: 'all',
    courtState: TENNIS_EVENT,
    figureLabel,
  });
  const outerEventState = { ...scene.state };
  delete outerEventState.contactOutcome;
  return {
    ...scene,
    state: { ...outerEventState, attentionSide: side },
    viewport: sceneViewport(scene),
  };
}
