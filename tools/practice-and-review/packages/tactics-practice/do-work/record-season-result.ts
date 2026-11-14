import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  TacticsSeasonCoachReview,
  TacticsSeasonResult,
  TacticalRatingEffect,
} from '@/packages/tactics-practice/read-data/tactics-practice-types';

export const RECORD_SEASON_RESULT_ACTION = 'action:tactics-practice.record-season-result';

type RecordWrite = {
  address: string;
  path: string[];
  payload: unknown;
};

export type RecordSeasonResultDraft = {
  resultId: string;
  seasonId: string;
  resultKind: TacticsSeasonResult['resultKind'];
  playerRef: string;
  score: number;
  evidenceRefs: string[];
  promptRef?: string;
  bracketRef?: string;
  ratingEffect?: Omit<TacticalRatingEffect, 'kind' | 'createdAt'>;
  coachReview?: Omit<TacticsSeasonCoachReview, 'kind' | 'seasonId' | 'createdAt'>;
  createdAt: string;
};

export type RecordSeasonResultInput = {
  result_id: string;
  result_record: TacticsSeasonResult;
  rating_effect_id?: string;
  rating_effect_record?: TacticalRatingEffect;
  coach_review_id?: string;
  coach_review_record?: TacticsSeasonCoachReview;
  record_writes: RecordWrite[];
};

export function buildRecordSeasonResultInput(draft: RecordSeasonResultDraft): RecordSeasonResultInput {
  const input: RecordSeasonResultInput = {
    result_id: draft.resultId,
    result_record: {
      kind: 'tactics-season-result',
      resultId: draft.resultId,
      seasonId: draft.seasonId,
      resultKind: draft.resultKind,
      promptRef: draft.promptRef,
      bracketRef: draft.bracketRef,
      playerRef: draft.playerRef,
      score: draft.score,
      evidenceRefs: draft.evidenceRefs,
      createdAt: draft.createdAt,
    },
    rating_effect_id: draft.ratingEffect?.effectId,
    rating_effect_record: draft.ratingEffect
      ? {
          ...draft.ratingEffect,
          kind: 'tactical-rating-effect',
          createdAt: draft.createdAt,
        }
      : undefined,
    coach_review_id: draft.coachReview?.coachReviewId,
    coach_review_record: draft.coachReview
      ? {
          ...draft.coachReview,
          kind: 'tactics-season-coach-review',
          seasonId: draft.seasonId,
          createdAt: draft.createdAt,
        }
      : undefined,
    record_writes: [],
  };
  input.record_writes = [
    {
      address: `package::tactics-practice::season-result::${draft.resultId}`,
      path: ['current-item', 'published-record'],
      payload: input.result_record,
    },
    ...(input.rating_effect_record ? [{
      address: `package::tactics-practice::rating-effect::${input.rating_effect_record.effectId}`,
      path: ['current-item', 'published-record'],
      payload: input.rating_effect_record,
    }] : []),
    ...(input.coach_review_record ? [{
      address: `package::tactics-practice::season-coach-review::${input.coach_review_record.coachReviewId}`,
      path: ['current-item', 'published-record'],
      payload: input.coach_review_record,
    }] : []),
  ];
  return input;
}

export function recordSeasonResult(input: RecordSeasonResultInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_SEASON_RESULT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
