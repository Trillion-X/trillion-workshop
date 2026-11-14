import type {
  PracticeProtocolRecord,
  PracticeProtocolState,
  PracticeProtocolStateRecord,
  PracticeProtocolStepRecord,
  PracticeProtocolView,
} from './practice-protocol-types.ts';

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

function latestState(states: readonly PracticeProtocolStateRecord[], protocolId: string, learnerId?: string): PracticeProtocolStateRecord | undefined {
  return [...states]
    .filter((state) => state.protocolId === protocolId && (!learnerId || state.learnerId === learnerId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function readPracticeProtocolState(rows: unknown): PracticeProtocolState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    protocols: values.filter((value): value is PracticeProtocolRecord => kind(value) === 'practice-protocol'),
    steps: values.filter((value): value is PracticeProtocolStepRecord => kind(value) === 'practice-protocol-step'),
    states: values.filter((value): value is PracticeProtocolStateRecord => kind(value) === 'practice-protocol-state'),
  };
}

export function practiceProtocolViews(state: PracticeProtocolState, learnerId?: string): PracticeProtocolView[] {
  return state.protocols
    .map((protocol) => {
      const steps = state.steps
        .filter((step) => step.protocolId === protocol.protocolId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
      const currentState = latestState(state.states, protocol.protocolId, learnerId);
      const completed = new Set(currentState?.completedStepIds ?? []);
      const currentStep = steps.find((step) => step.stepId === currentState?.currentStepId)
        ?? steps.find((step) => !completed.has(step.stepId))
        ?? steps[0];

      return {
        protocol,
        steps,
        state: currentState,
        currentStep,
        completedCount: steps.filter((step) => completed.has(step.stepId)).length,
        totalSteps: steps.length,
      };
    })
    .sort((a, b) => a.protocol.label.localeCompare(b.protocol.label));
}
