// One illustrative case from the retained M015 course example. The scene
// changes the actual instruction and question routes; it reports no outcomes.
import { renderInstructionCase } from '../../../anatomy-contact-replacement/instruction-case.mjs';

export const STAGE_IDS = Object.freeze(['complex', 'crazy', 'truth', 'obsessive', 'world']);
export const NEED_IDS = Object.freeze(['instruction', 'question']);
export const INITIAL_STAGE = 'complex';
export const INITIAL_NEED = 'instruction';

const stageIndex = stage => {
  const index = STAGE_IDS.indexOf(stage);
  if (index < 0) throw new TypeError(`Unknown M015 process stage: ${String(stage)}`);
  return index;
};

export function caseScene({ stage = INITIAL_STAGE, need = INITIAL_NEED, labels } = {}) {
  const index = stageIndex(stage);
  if (!NEED_IDS.includes(need)) throw new TypeError(`Unknown M015 learner need: ${String(need)}`);
  if (!labels || ['tutor', 'learner', 'book', 'question'].some(key => typeof labels[key] !== 'string' || !labels[key].trim())) {
    throw new TypeError('M015 case needs its caller-owned accessible names.');
  }

  const reconstructed = index >= 2;
  const questioning = need === 'question';
  const newQuestionAppears = index === 1;
  const routeQuestion = questioning || newQuestionAppears;
  const relationshipProgress = [0, 0, 0.45, 1, 1][index];
  const questionProgress = [0, 0.24, 0.55, 0.82, 1][index];
  const helpProgress = [0, 0.55, 0.72, 0.9, 1][index];
  const scene = renderInstructionCase({
    open: reconstructed ? 1 : 0,
    ink: reconstructed ? 1 : 0,
    bookVisible: reconstructed ? 1 : 0,
    repetition: questioning ? (index === 0 ? 1 : null) : (reconstructed ? null : 1),
    use: !questioning && reconstructed ? (index === 4 ? 1 : relationshipProgress) : null,
    attempt: !questioning && index === 4 ? 0.5 : 0,
    question: routeQuestion ? questionProgress : null,
    helpLink: questioning ? helpProgress : 0,
    helpGap: newQuestionAppears ? 0.6 : 0,
    instructionLink: reconstructed ? 1 : 0,
    labels,
  });

  return {
    ...scene,
    viewport: [0, 0, 1920, 1080],
    state: {
      ...scene.state,
      stage,
      need,
      illustrative: true,
      result: null,
    },
  };
}
