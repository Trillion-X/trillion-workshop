export type PracticeProtocolRecord = {
  kind: 'practice-protocol';
  protocolId: string;
  label: string;
  summary?: string;
};

export type PracticeProtocolStepRecord = {
  kind: 'practice-protocol-step';
  stepId: string;
  protocolId: string;
  label: string;
  cue?: string;
  evidenceNeeded?: string;
  sortOrder: number;
};

export type PracticeProtocolStateRecord = {
  kind: 'practice-protocol-state';
  stateId: string;
  protocolId: string;
  learnerId: string;
  currentStepId?: string;
  completedStepIds: string[];
  updatedAt: string;
};

export type PracticeProtocolEventRequestRecord = {
  kind: 'practice-protocol-event-request';
  requestId: string;
  learnerId: string;
  protocolId: string;
  stepId?: string;
  target: string;
  event: unknown;
  createdAt: string;
};

export type PracticeProtocolPackageRecord =
  | PracticeProtocolRecord
  | PracticeProtocolStepRecord
  | PracticeProtocolStateRecord
  | PracticeProtocolEventRequestRecord;

export type PracticeProtocolState = {
  protocols: PracticeProtocolRecord[];
  steps: PracticeProtocolStepRecord[];
  states: PracticeProtocolStateRecord[];
};

export type PracticeProtocolView = {
  protocol: PracticeProtocolRecord;
  steps: PracticeProtocolStepRecord[];
  state?: PracticeProtocolStateRecord;
  currentStep?: PracticeProtocolStepRecord;
  completedCount: number;
  totalSteps: number;
};
