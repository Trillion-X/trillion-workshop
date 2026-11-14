import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  ComparisonResult,
  DecisionDebrief,
  JudgeResult,
  ProfileEffect,
  ProgressEffect,
} from '../read-data/practice-decision-loop-types.ts';

export const PUBLISH_DECISION_RESULT_ACTION = 'action:practice-decision-loop.publish-result';

export type PublishDecisionResultDraft = {
  resultId?: string;
  comparisonId?: string;
  progressId?: string;
  profileEffectId?: string;
  debriefId?: string;
  responseId: string;
  promptId: string;
  learnerId: string;
  subjectId: string;
  profileId: string;
  score: number;
  label: string;
  rubricRef: string;
  evidenceRefs?: string[];
  rank?: number;
  percentile?: number;
  groupSize?: number;
  distribution?: Array<{ label: string; count: number }>;
  masteryDelta?: number;
  reviewAfter?: string;
  profilePayload?: Record<string, unknown>;
  debriefTitle?: string;
  debriefPoints?: string[];
  nextPromptRefs?: string[];
  now?: Date;
};

export type PublishDecisionResultInput = {
  result_id: string;
  result_record: JudgeResult;
  comparison_id: string;
  comparison_record: ComparisonResult;
  progress_id: string;
  progress_record: ProgressEffect;
  profile_effect_id: string;
  profile_effect_record: ProfileEffect;
  debrief_id: string;
  debrief_record: DecisionDebrief;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildPublishDecisionResultInput(
  draft: PublishDecisionResultDraft,
): PublishDecisionResultInput {
  const createdAt = (draft.now ?? new Date()).toISOString();
  const resultId = draft.resultId ?? generatedId('judge-result');
  const comparisonId = draft.comparisonId ?? generatedId('comparison-result');
  const progressId = draft.progressId ?? generatedId('progress-effect');
  const profileEffectId = draft.profileEffectId ?? generatedId('profile-effect');
  const debriefId = draft.debriefId ?? generatedId('decision-debrief');
  const evidenceRefs = draft.evidenceRefs ?? [];
  return {
    result_id: resultId,
    result_record: {
      kind: 'judge-result',
      resultId,
      responseId: draft.responseId,
      promptId: draft.promptId,
      score: draft.score,
      label: draft.label,
      rubricRef: draft.rubricRef,
      evidenceRefs,
      createdAt,
    },
    comparison_id: comparisonId,
    comparison_record: {
      kind: 'comparison-result',
      comparisonId,
      promptId: draft.promptId,
      responseId: draft.responseId,
      rank: draft.rank,
      percentile: draft.percentile,
      groupSize: draft.groupSize,
      distribution: draft.distribution,
      createdAt,
    },
    progress_id: progressId,
    progress_record: {
      kind: 'progress-effect',
      effectId: progressId,
      learnerId: draft.learnerId,
      subjectId: draft.subjectId,
      sourceResultId: resultId,
      masteryDelta: draft.masteryDelta ?? 0,
      reviewAfter: draft.reviewAfter,
      createdAt,
    },
    profile_effect_id: profileEffectId,
    profile_effect_record: {
      kind: 'profile-effect',
      effectId: profileEffectId,
      profileId: draft.profileId,
      subjectId: draft.subjectId,
      sourceRefs: [resultId, comparisonId, ...evidenceRefs],
      payload: draft.profilePayload ?? {},
      createdAt,
    },
    debrief_id: debriefId,
    debrief_record: {
      kind: 'decision-debrief',
      debriefId,
      promptId: draft.promptId,
      responseId: draft.responseId,
      title: draft.debriefTitle ?? draft.label,
      points: draft.debriefPoints ?? [],
      nextPromptRefs: draft.nextPromptRefs ?? [],
      createdAt,
    },
  };
}

export function publishDecisionResult(input: PublishDecisionResultInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: PUBLISH_DECISION_RESULT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
