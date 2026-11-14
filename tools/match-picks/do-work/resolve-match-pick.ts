import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { MatchPickResultRecord } from '../read-data/match-picks-types.ts';
import { assertFreePickCopy } from './regulated-money-copy-guard.ts';

export const RESOLVE_MATCH_PICK_ACTION = 'action:match-picks.resolve-result';

export type ResolveMatchPickDraft = {
  resultId?: string;
  matchId: string;
  winningChoiceId: string;
  summary: string;
  now?: Date;
};

export type ResolveMatchPickInput = {
  result_id: string;
  result_record: MatchPickResultRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildResolveMatchPickInput(draft: ResolveMatchPickDraft): ResolveMatchPickInput {
  const summary = draft.summary.trim();
  if (!draft.matchId.trim()) throw new Error('Match needs an id');
  if (!draft.winningChoiceId.trim()) throw new Error('Winner needs an id');
  if (!summary) throw new Error('Result needs a summary');
  assertFreePickCopy(summary, 'Result summary');
  const resultId = draft.resultId ?? generatedId('match-pick-result');
  return {
    result_id: resultId,
    result_record: {
      kind: 'match-pick-result',
      resultId,
      matchId: draft.matchId.trim(),
      winningChoiceId: draft.winningChoiceId.trim(),
      summary,
      resolvedAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function resolveMatchPick(input: ResolveMatchPickInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RESOLVE_MATCH_PICK_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
