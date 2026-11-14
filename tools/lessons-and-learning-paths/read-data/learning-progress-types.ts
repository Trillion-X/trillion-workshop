export type ProgressTrackRecord = {
  kind: 'progress-track';
  trackId: string;
  label: string;
  summary?: string;
  audienceLabel?: string;
};

export type ProgressStepRecord = {
  kind: 'progress-step';
  stepId: string;
  trackId: string;
  label: string;
  cue?: string;
  evidenceLabel?: string;
  sortOrder: number;
};

export type ProgressStateRecord = {
  kind: 'progress-state';
  stateId: string;
  trackId: string;
  learnerId: string;
  revision: number;
  currentStepId?: string;
  completedStepIds: string[];
  evaluationReceiptRefs: string[];
  updatedAt: string;
};

export type ProgressEvaluationReceiptRecord = {
  kind: 'progress-evaluation-receipt';
  evaluationId: string;
  learnerId: string;
  trackId: string;
  stepId?: string;
  evidenceRefs: string[];
  measureFactRef: string;
  measureDefinitionRef: string;
  decisionKey: string;
  decision: {
    completed: boolean;
    nextStepId?: string;
  };
  score: number;
  confidence: number;
  provenance: Record<string, unknown>;
  evaluatedAt: string;
};

export type ProgressPresentationRecord = {
  kind: 'progress-presentation';
  key: string;
  label: string;
  tone?: string;
};

export type ProgressEvidenceRecord = {
  kind: 'progress-evidence';
  evidenceId: string;
  learnerId: string;
  trackId: string;
  stepId?: string;
  label: string;
  summary?: string;
  createdAt: string;
};

export type LearningProgressRecord =
  | ProgressTrackRecord
  | ProgressStepRecord
  | ProgressStateRecord
  | ProgressEvidenceRecord
  | ProgressEvaluationReceiptRecord
  | ProgressPresentationRecord;

export type LearningProgressState = {
  tracks: ProgressTrackRecord[];
  steps: ProgressStepRecord[];
  states: ProgressStateRecord[];
  evidence: ProgressEvidenceRecord[];
  evaluationReceipts: ProgressEvaluationReceiptRecord[];
  presentations: ProgressPresentationRecord[];
};

export type LearningProgressFocusView = {
  track: ProgressTrackRecord;
  steps: ProgressStepRecord[];
  state?: ProgressStateRecord;
  latestEvaluation?: ProgressEvaluationReceiptRecord;
  currentStep?: ProgressStepRecord;
  completedCount: number;
  totalSteps: number;
  percent: number;
  statusLabel: string;
  recentEvidence: ProgressEvidenceRecord[];
};
