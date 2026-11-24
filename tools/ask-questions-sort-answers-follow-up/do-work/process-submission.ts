// tools/ask-questions-sort-answers-follow-up/do-work/process-submission.ts
//
// The pipeline integration point: on submit, build the answers AND the decision (score + segment) as the
// records to keep together (answered in ONE result), and return the per-segment follow-up sequence to run. One
// result = answers and decision come together (no half-state). Pure builder; form-tools.mjs
// answers it. Ties CAPTURE -> DECIDE -> ACT with zero new concepts, it composes
// the already-tested layers.
//
// Changed from the package: the plan holds `writes` (kept rows) where the package held an engine
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
  abouts?: Readonly<Record<string, Readonly<Record<string, string>> | null>>,
): ProcessSubmissionPlan {
  const decision = decide(answers, config.scoreRules, config.segmentRules);
  const writes: RecordWrite[] = [
    ...buildAnswerFactWrites(formId, respondentId, answers, decidedAt, submissionId, abouts),
    buildSegmentAssignmentWrite(formId, respondentId, decision, decidedAt, submissionId),
  ];
  return {
    writes,
    decision,
    followUp: selectFollowUpSequence(decision.segmentId, config.followUpSequences),
  };
}
