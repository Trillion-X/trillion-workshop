import type { ReviewSchedulePolicy } from '@/packages/spaced-repetition/read-data/schedule-next-review';

export type ReviewPromptRecord = {
  kind: 'review-prompt';
  promptId: string;
  label?: string;
  prompt: string;
  answer?: string;
  subjectRef?: string;
};

export type ReviewScheduleRecord = {
  kind: 'review-schedule';
  scheduleId: string;
  promptId: string;
  learnerId: string;
  dueAt?: string;
  state: 'due' | 'pending' | 'complete';
  nextReviewAt?: string;
  /** Spaced-repetition state carried forward between reviews. These may be
   *  omitted so older schedule records (written before the scheduler existed)
   *  still read; the scheduler treats their absence as a brand-new item. */
  reps?: number;
  easeFactor?: number;
  intervalDays?: number;
};

export type ReviewResponseRequestRecord = {
  kind: 'review-response-request';
  requestId: string;
  learnerId: string;
  promptId: string;
  scheduleId?: string;
  target: string;
  /** Recall grade — an OPEN token (e.g. `again`/`hard`/`good`/`easy`, or a new
   *  one like `forgot`/`trivial`/`0`..`5`). Resolved to a recall quality through
   *  `policy.gradeQuality` DATA (unknown → total lapse). NOT a closed union — a
   *  new grade is a policy DATA row, never a contract/code edit (enum dissolution). */
  response: string;
  createdAt: string;
};

export type ReviewSchedulePolicyRecord = {
  kind: 'review-schedule-policy';
  policyId: string;
} & ReviewSchedulePolicy;

export type SpacedRepetitionRecord =
  | ReviewPromptRecord
  | ReviewScheduleRecord
  | ReviewResponseRequestRecord
  | ReviewSchedulePolicyRecord;

export type SpacedRepetitionState = {
  prompts: ReviewPromptRecord[];
  schedules: ReviewScheduleRecord[];
  responses: ReviewResponseRequestRecord[];
};

export type ReviewQueueItemView = {
  prompt: ReviewPromptRecord;
  schedule?: ReviewScheduleRecord;
  dueLabel: string;
  isDue: boolean;
};
