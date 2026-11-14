import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';
import { sceneViewport } from '../../M010/lesson/lesson-model.mjs';
import content from './lesson-content.json' with { type: 'json' };

const COURT_FEED = Object.freeze({
  from: Object.freeze([-30, 210, 58]),
  to: Object.freeze([50, -110, 70]),
  progress: 0.72,
  arcHeight: 36,
});

const POSITIONS = Object.freeze({
  starting: Object.freeze({ x: 38, y: -205 }),
  adjusted: Object.freeze({ x: 112, y: -145 }),
});

const TIMING_PHASES = Object.freeze({ usual: 0, earlier: Math.PI });
export const CONDITION_IDS = Object.freeze(content.interventions.map(item => item.id));

export function sceneForCondition(conditionId, time = 2) {
  const condition = content.interventions.find(item => item.id === conditionId);
  if (!condition) throw new TypeError(`Unknown M018 condition: ${String(conditionId)}`);
  if (!Number.isFinite(time) || time < 0) throw new TypeError('M018 scene time must be finite and nonnegative');
  const near = {
    ...POSITIONS[condition.position],
    swingPhase: TIMING_PHASES[condition.timing],
  };
  const figure = renderContext({
    mode: 'court',
    time,
    variant: 'normal',
    view: 'player',
    focus: 'all',
    courtState: {
      near,
      shot: { ...COURT_FEED },
    },
    figureLabel: content.sceneLabels.figure,
  });
  return {
    condition,
    figure,
    state: {
      condition: condition.id,
      timing: condition.timing,
      position: condition.position,
      fixedFeed: { ...COURT_FEED, from: [...COURT_FEED.from], to: [...COURT_FEED.to] },
      actualNearPosition: [...figure.state.courtState.nearPosition],
      actualNearHand: [...figure.state.player.hand],
      actualRacketAngle: figure.state.player.racketAngle,
      actualRacketGrip: [...figure.state.racketGripScreen],
      actualRacketHoop: [...figure.state.racketHoopScreen],
      ball: [...figure.state.ball],
      renderedContactGap: figure.state.contactOffsetPx,
      camera: figure.state.camera,
    },
  };
}

export const CONDITION_SCENES = Object.freeze(Object.fromEntries(
  CONDITION_IDS.map(id => [id, sceneForCondition(id)])));

const conditionViewports = CONDITION_IDS.map(id => sceneViewport(CONDITION_SCENES[id].figure));
const minX = Math.min(...conditionViewports.map(([x]) => x));
const minY = Math.min(...conditionViewports.map(([, y]) => y));
const maxX = Math.max(...conditionViewports.map(([x, , width]) => x + width));
const maxY = Math.max(...conditionViewports.map(([, y, , height]) => y + height));
export const CONDITION_VIEWPORT = Object.freeze([minX, minY, maxX - minX, maxY - minY]);

