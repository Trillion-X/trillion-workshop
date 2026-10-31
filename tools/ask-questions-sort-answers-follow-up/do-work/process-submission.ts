// tools/ask-questions-sort-answers-follow-up/do-work/process-submission.ts
//
// The pipeline integration point: on submit, build the answers AND the decision (score + segment) as the
// records to write together in ONE door write, and return the per-segment follow-up sequence to run. One
// write = answers and decision are recorded together (no half-state). Pure builder; the records-door command
// (forms-on-the-records-door.mjs) sends it. Ties CAPTURE -> DECIDE -> ACT with zero new concepts, it composes
// the already-tested layers.
//
// Changed from the package: the plan holds `writes` (door records) where the package held an engine
// write-batch `request`; the `processSubmission` wrapper that sent it through the old engine is gone.

import { buildAnswerFactWrites } from './answer-fact-writes.ts';
import { buildSegmentAssignmentWrite } from './segment-assignment-writes.ts';
import type { RecordWrite } from '../read-data/record-rows.ts';
import { decide, type DecideResult } from '../read-data/score-and-segment.ts';
import { selectFollowUpSequence, type FollowUpSequence } from '../read-data/follow-up-sequences.ts';
import type { DecideConfig } from '../read-data/read-decide-config.ts';

export type { DecideConfig };

export interface ProcessSubmissionPlan {
  writes: RecordWrite[];
  decision: DecideResult;
  followUp: FollowUpSequence | null;
}

/** Pure: build the records to write together + the decision + the selected follow-up. No I/O. */
export function buildProcessSubmission(
  formId: string,
  respondentId: string,
  answers: Readonly<Record<string, unknown>>,
  config: DecideConfig,
  decidedAt: string,
  submissionId?: string,
): ProcessSubmissionPlan {
  const decision = decide(answers, config.scoreRules, config.segmentRules);
  const writes: RecordWrite[] = [
    ...buildAnswerFactWrites(formId, respondentId, answers, decidedAt, submissionId),
    buildSegmentAssignmentWrite(formId, respondentId, decision, decidedAt, submissionId),
  ];
  return {
    writes,
    decision,
    followUp: selectFollowUpSequence(decision.segmentId, config.followUpSequences),
  };
}
