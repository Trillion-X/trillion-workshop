export type DecisionSubjectRef = {
  id: string;
  kind: string;
  label?: string;
};

export type DecisionSubject = {
  kind: 'decision-subject';
  subjectId: string;
  subjectKind: string;
  label?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

export type EvidenceSource = {
  id: string;
  label?: string;
  confidence?: number;
  visibility?: 'public' | 'private' | 'coach' | 'system';
};

export type DecisionEvidence = {
  kind: 'decision-evidence';
  evidenceId: string;
  subject: DecisionSubjectRef;
  evidenceKind: string;
  source: EvidenceSource;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type EvidenceAttachment = {
  kind: 'evidence-attachment';
  attachmentId: string;
  evidenceId: string;
  subject: DecisionSubjectRef;
  relationshipKind: string;
  createdAt: string;
};

export type DecisionChoice = {
  choiceId: string;
  label: string;
  payload?: Record<string, unknown>;
};

export type DecisionPrompt = {
  kind: 'decision-prompt';
  promptId: string;
  subject: DecisionSubjectRef;
  promptKind: string;
  title: string;
  body: string;
  choices: DecisionChoice[];
  evidenceRefs: string[];
  createdAt: string;
};

export type DecisionResponse = {
  kind: 'decision-response';
  responseId: string;
  promptId: string;
  userId: string;
  choiceId: string;
  createdAt: string;
};

export type ResponseReason = {
  kind: 'response-reason';
  reasonId: string;
  responseId: string;
  promptId: string;
  userId: string;
  text: string;
  createdAt: string;
};

export type JudgeResult = {
  kind: 'judge-result';
  resultId: string;
  responseId: string;
  promptId: string;
  score: number;
  label: string;
  rubricRef: string;
  evidenceRefs: string[];
  createdAt: string;
};

export type ComparisonResult = {
  kind: 'comparison-result';
  comparisonId: string;
  promptId: string;
  responseId: string;
  rank?: number;
  percentile?: number;
  groupSize?: number;
  distribution?: Array<{ label: string; count: number }>;
  createdAt: string;
};

export type ProgressEffect = {
  kind: 'progress-effect';
  effectId: string;
  learnerId: string;
  subjectId: string;
  sourceResultId: string;
  masteryDelta: number;
  reviewAfter?: string;
  createdAt: string;
};

export type ProfileEffect = {
  kind: 'profile-effect';
  effectId: string;
  profileId: string;
  subjectId: string;
  sourceRefs: string[];
  payload: Record<string, unknown>;
  createdAt: string;
};

export type DecisionDebrief = {
  kind: 'decision-debrief';
  debriefId: string;
  promptId: string;
  responseId: string;
  title: string;
  points: string[];
  nextPromptRefs: string[];
  createdAt: string;
};

export type PracticeStep = {
  kind: 'practice-step';
  stepId: string;
  learnerId: string;
  promptId: string;
  stepKind: string;
  status: 'ready' | 'started' | 'completed' | 'skipped';
  sourceRefs: string[];
  createdAt: string;
};

export type ReviewSchedule = {
  kind: 'review-schedule';
  scheduleId: string;
  learnerId: string;
  promptId: string;
  sourceResultId: string;
  dueAt: string;
  intervalKind?: string;
  createdAt: string;
};

export type DecisionEvent = {
  kind: 'decision-event';
  eventId: string;
  subjectId: string;
  promptId?: string;
  sequence: number;
  eventKind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type MediaEvidenceLink = {
  kind: 'media-evidence-link';
  linkId: string;
  mediaId: string;
  evidenceId: string;
  analysisRef?: string;
  confidence?: number;
  createdAt: string;
};

export type ContentReference = {
  kind: 'content-reference';
  contentId: string;
  promptId?: string;
  subjectId?: string;
  sourceRefs: string[];
  state: 'draft' | 'reviewed' | 'approved' | 'published';
  createdAt: string;
};

export type FollowUpStep = {
  kind: 'follow-up-step';
  stepId: string;
  subjectId: string;
  stepKind: string;
  sourceRefs: string[];
  result?: string;
  createdAt: string;
};

export type AccessSnapshot = {
  kind: 'access-snapshot';
  snapshotId: string;
  subjectId: string;
  resourceId: string;
  accessState: 'unknown' | 'allowed' | 'denied';
  sourceOwner: string;
  sourceRefs: string[];
  createdAt: string;
};

export type PracticeDecisionRecord =
  | DecisionSubject
  | DecisionEvidence
  | EvidenceAttachment
  | DecisionPrompt
  | DecisionResponse
  | ResponseReason
  | JudgeResult
  | ComparisonResult
  | ProgressEffect
  | ProfileEffect
  | DecisionDebrief
  | PracticeStep
  | ReviewSchedule
  | DecisionEvent
  | MediaEvidenceLink
  | ContentReference
  | FollowUpStep
  | AccessSnapshot;

export type PracticeDecisionState = {
  subjects: DecisionSubject[];
  evidence: DecisionEvidence[];
  attachments: EvidenceAttachment[];
  prompts: DecisionPrompt[];
  responses: DecisionResponse[];
  reasons: ResponseReason[];
  results: JudgeResult[];
  comparisons: ComparisonResult[];
  progressEffects: ProgressEffect[];
  profileEffects: ProfileEffect[];
  debriefs: DecisionDebrief[];
  practiceSteps: PracticeStep[];
  reviewSchedules: ReviewSchedule[];
  events: DecisionEvent[];
  mediaEvidenceLinks: MediaEvidenceLink[];
  contentReferences: ContentReference[];
  followUpSteps: FollowUpStep[];
  accessSnapshots: AccessSnapshot[];
};

export type PracticeDecisionPromptView = {
  prompt: DecisionPrompt;
  evidence: DecisionEvidence[];
  attachments: EvidenceAttachment[];
  responses: DecisionResponse[];
  reasons: ResponseReason[];
  result?: JudgeResult;
  comparison?: ComparisonResult;
  debrief?: DecisionDebrief;
  progressEffects: ProgressEffect[];
  profileEffects: ProfileEffect[];
  practiceSteps: PracticeStep[];
  reviewSchedules: ReviewSchedule[];
  events: DecisionEvent[];
  mediaEvidenceLinks: MediaEvidenceLink[];
  contentReferences: ContentReference[];
  followUpSteps: FollowUpStep[];
  accessSnapshots: AccessSnapshot[];
};
