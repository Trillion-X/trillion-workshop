import type {
  AccessSnapshot,
  ComparisonResult,
  ContentReference,
  DecisionDebrief,
  DecisionEvent,
  DecisionEvidence,
  DecisionPrompt,
  DecisionResponse,
  DecisionSubject,
  EvidenceAttachment,
  FollowUpStep,
  JudgeResult,
  MediaEvidenceLink,
  PracticeDecisionPromptView,
  PracticeDecisionRecord,
  PracticeDecisionState,
  PracticeStep,
  ProfileEffect,
  ProgressEffect,
  ReviewSchedule,
  ResponseReason,
} from './practice-decision-loop-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

function kind(value: unknown): string {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
}

export function readPracticeDecisionState(rows: unknown): PracticeDecisionState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    subjects: values.filter((value): value is DecisionSubject => kind(value) === 'decision-subject'),
    evidence: values.filter((value): value is DecisionEvidence => kind(value) === 'decision-evidence'),
    attachments: values.filter((value): value is EvidenceAttachment => kind(value) === 'evidence-attachment'),
    prompts: values.filter((value): value is DecisionPrompt => kind(value) === 'decision-prompt'),
    responses: values.filter((value): value is DecisionResponse => kind(value) === 'decision-response'),
    reasons: values.filter((value): value is ResponseReason => kind(value) === 'response-reason'),
    results: values.filter((value): value is JudgeResult => kind(value) === 'judge-result'),
    comparisons: values.filter((value): value is ComparisonResult => kind(value) === 'comparison-result'),
    progressEffects: values.filter((value): value is ProgressEffect => kind(value) === 'progress-effect'),
    profileEffects: values.filter((value): value is ProfileEffect => kind(value) === 'profile-effect'),
    debriefs: values.filter((value): value is DecisionDebrief => kind(value) === 'decision-debrief'),
    practiceSteps: values.filter((value): value is PracticeStep => kind(value) === 'practice-step'),
    reviewSchedules: values.filter((value): value is ReviewSchedule => kind(value) === 'review-schedule'),
    events: values.filter((value): value is DecisionEvent => kind(value) === 'decision-event'),
    mediaEvidenceLinks: values.filter((value): value is MediaEvidenceLink => kind(value) === 'media-evidence-link'),
    contentReferences: values.filter((value): value is ContentReference => kind(value) === 'content-reference'),
    followUpSteps: values.filter((value): value is FollowUpStep => kind(value) === 'follow-up-step'),
    accessSnapshots: values.filter((value): value is AccessSnapshot => kind(value) === 'access-snapshot'),
  };
}

export function promptViews(state: PracticeDecisionState): PracticeDecisionPromptView[] {
  return state.prompts.map((prompt) => {
    const responses = state.responses.filter((response) => response.promptId === prompt.promptId);
    const responseIds = new Set(responses.map((response) => response.responseId));
    const results = state.results.filter((result) => result.promptId === prompt.promptId);
    const resultIds = new Set(results.map((result) => result.resultId));
    const evidenceIds = new Set(prompt.evidenceRefs);
    const sourceIds = new Set([...responseIds, ...resultIds, ...evidenceIds, prompt.promptId]);
    const subjectId = prompt.subject.id;
    return {
      prompt,
      evidence: state.evidence.filter((evidence) => prompt.evidenceRefs.includes(evidence.evidenceId)),
      attachments: state.attachments.filter((attachment) => evidenceIds.has(attachment.evidenceId)),
      responses,
      reasons: state.reasons.filter((reason) => responseIds.has(reason.responseId)),
      result: results[0],
      comparison: state.comparisons.find((comparison) => comparison.promptId === prompt.promptId),
      debrief: state.debriefs.find((debrief) => debrief.promptId === prompt.promptId),
      progressEffects: state.progressEffects.filter((effect) => resultIds.has(effect.sourceResultId)),
      profileEffects: state.profileEffects.filter(
        (effect) => effect.subjectId === subjectId || effect.sourceRefs.some((ref) => sourceIds.has(ref)),
      ),
      practiceSteps: state.practiceSteps.filter((step) => step.promptId === prompt.promptId),
      reviewSchedules: state.reviewSchedules.filter((schedule) => schedule.promptId === prompt.promptId),
      events: state.events.filter((event) => event.promptId === prompt.promptId || event.subjectId === subjectId),
      mediaEvidenceLinks: state.mediaEvidenceLinks.filter((link) => evidenceIds.has(link.evidenceId)),
      contentReferences: state.contentReferences.filter(
        (content) => content.promptId === prompt.promptId || content.subjectId === subjectId,
      ),
      followUpSteps: state.followUpSteps.filter(
        (step) => step.subjectId === subjectId || step.sourceRefs.some((ref) => sourceIds.has(ref)),
      ),
      accessSnapshots: state.accessSnapshots.filter((snapshot) => snapshot.subjectId === subjectId),
    };
  });
}

export function assertGenericPracticeDecisionRecord(
  record: PracticeDecisionRecord,
  productWords: readonly string[],
): PracticeDecisionRecord {
  const serialized = JSON.stringify(record).toLocaleLowerCase();
  const found = productWords.find((word) => serialized.includes(word.toLocaleLowerCase()));
  if (found) {
    throw new Error(`Generic practice decision record contains product word: ${found}`);
  }
  return record;
}
