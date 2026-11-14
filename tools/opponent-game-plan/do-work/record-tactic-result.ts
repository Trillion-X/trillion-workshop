import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  TacticResult,
  TacticResultOutcome,
} from '../read-data/opponent-game-plan-types.ts';

export const RECORD_TACTIC_RESULT_ACTION = 'action:opponent-game-plan.record-result';

export type RecordTacticResultDraft = {
  resultId?: string;
  selfPlayerId: string;
  opponentPlayerId: string;
  planId?: string;
  strategyId?: string;
  tacticId?: string;
  outcome: TacticResultOutcome;
  notes?: string;
  matchRef?: string;
  now?: Date;
};

export type RecordTacticResultInput = {
  result_id: string;
  result_record: TacticResult;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildRecordTacticResultInput(draft: RecordTacticResultDraft): RecordTacticResultInput {
  const resultId = draft.resultId ?? generatedId('result');
  const sourceRefs = [draft.planId, draft.strategyId, draft.tacticId, draft.matchRef].filter((value): value is string => Boolean(value));
  return {
    result_id: resultId,
    result_record: {
      kind: 'result',
      resultKind: 'tactic-outcome',
      resultId,
      subject: {
        id: draft.opponentPlayerId,
        kind: 'tennis-player',
      },
      selfPlayerId: draft.selfPlayerId,
      opponentPlayerId: draft.opponentPlayerId,
      sourceRefs,
      payload: {
        planId: draft.planId,
        strategyId: draft.strategyId,
        tacticId: draft.tacticId,
        outcome: draft.outcome,
        notes: draft.notes?.trim() || undefined,
        matchRef: draft.matchRef,
      },
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function recordTacticResult(input: RecordTacticResultInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_TACTIC_RESULT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
