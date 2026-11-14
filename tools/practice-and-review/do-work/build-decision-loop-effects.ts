import type {
  AccessSnapshot,
  ContentReference,
  DecisionEvent,
  FollowUpStep,
  MediaEvidenceLink,
  PracticeStep,
  ProgressEffect,
  ReviewSchedule,
} from '../read-data/practice-decision-loop-types.ts';

export type DecisionLoopEffectDraft = {
  learnerId: string;
  subjectId: string;
  promptId: string;
  resultId: string;
  masteryDelta?: number;
  reviewDueAt?: string;
  practiceStepKind?: string;
  eventKind?: string;
  eventPayload?: Record<string, unknown>;
  mediaId?: string;
  evidenceId?: string;
  analysisRef?: string;
  contentState?: ContentReference['state'];
  contentSourceRefs?: string[];
  followUpStepKind?: string;
  followUpResult?: string;
  resourceId?: string;
  accessState?: AccessSnapshot['accessState'];
  accessSourceOwner?: string;
  accessSourceRefs?: string[];
  now?: Date;
  sequence?: number;
};

export type DecisionLoopEffectRecords = {
  progressEffect: ProgressEffect;
  practiceStep: PracticeStep;
  reviewSchedule?: ReviewSchedule;
  event?: DecisionEvent;
  mediaEvidenceLink?: MediaEvidenceLink;
  contentReference?: ContentReference;
  followUpStep?: FollowUpStep;
  accessSnapshot?: AccessSnapshot;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildDecisionLoopEffectRecords(
  draft: DecisionLoopEffectDraft,
): DecisionLoopEffectRecords {
  const createdAt = (draft.now ?? new Date()).toISOString();
  const progressEffect: ProgressEffect = {
    kind: 'progress-effect',
    effectId: generatedId('progress-effect'),
    learnerId: draft.learnerId,
    subjectId: draft.subjectId,
    sourceResultId: draft.resultId,
    masteryDelta: draft.masteryDelta ?? 0,
    reviewAfter: draft.reviewDueAt,
    createdAt,
  };
  const practiceStep: PracticeStep = {
    kind: 'practice-step',
    stepId: generatedId('practice-step'),
    learnerId: draft.learnerId,
    promptId: draft.promptId,
    stepKind: draft.practiceStepKind ?? 'decision-practice',
    status: 'ready',
    sourceRefs: [draft.resultId],
    createdAt,
  };

  return {
    progressEffect,
    practiceStep,
    reviewSchedule: draft.reviewDueAt ? {
      kind: 'review-schedule',
      scheduleId: generatedId('review-schedule'),
      learnerId: draft.learnerId,
      promptId: draft.promptId,
      sourceResultId: draft.resultId,
      dueAt: draft.reviewDueAt,
      createdAt,
    } : undefined,
    event: draft.eventKind ? {
      kind: 'decision-event',
      eventId: generatedId('decision-event'),
      subjectId: draft.subjectId,
      promptId: draft.promptId,
      sequence: draft.sequence ?? 1,
      eventKind: draft.eventKind,
      payload: draft.eventPayload ?? {},
      createdAt,
    } : undefined,
    mediaEvidenceLink: draft.mediaId && draft.evidenceId ? {
      kind: 'media-evidence-link',
      linkId: generatedId('media-evidence-link'),
      mediaId: draft.mediaId,
      evidenceId: draft.evidenceId,
      analysisRef: draft.analysisRef,
      createdAt,
    } : undefined,
    contentReference: draft.contentSourceRefs ? {
      kind: 'content-reference',
      contentId: generatedId('content-reference'),
      promptId: draft.promptId,
      subjectId: draft.subjectId,
      sourceRefs: draft.contentSourceRefs,
      state: draft.contentState ?? 'draft',
      createdAt,
    } : undefined,
    followUpStep: draft.followUpStepKind ? {
      kind: 'follow-up-step',
      stepId: generatedId('follow-up-step'),
      subjectId: draft.subjectId,
      stepKind: draft.followUpStepKind,
      sourceRefs: [draft.resultId],
      result: draft.followUpResult,
      createdAt,
    } : undefined,
    accessSnapshot: draft.resourceId ? {
      kind: 'access-snapshot',
      snapshotId: generatedId('access-snapshot'),
      subjectId: draft.subjectId,
      resourceId: draft.resourceId,
      accessState: draft.accessState ?? 'unknown',
      sourceOwner: draft.accessSourceOwner ?? 'external-owner',
      sourceRefs: draft.accessSourceRefs ?? [],
      createdAt,
    } : undefined,
  };
}
