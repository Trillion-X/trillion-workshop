import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { MatchPickRecord } from '../read-data/match-picks-types.ts';

export const SUBMIT_MATCH_PICK_ACTION = 'action:match-picks.submit-pick';

export type SubmitMatchPickDraft = {
  pickId?: string;
  matchId: string;
  pickerId: string;
  choiceId: string;
  now?: Date;
};

export type SubmitMatchPickInput = {
  pick_id: string;
  pick_record: MatchPickRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildSubmitMatchPickInput(draft: SubmitMatchPickDraft): SubmitMatchPickInput {
  if (!draft.matchId.trim()) throw new Error('Match needs an id');
  if (!draft.pickerId.trim()) throw new Error('Picker needs an id');
  if (!draft.choiceId.trim()) throw new Error('Choice needs an id');
  const pickId = draft.pickId ?? generatedId('match-pick');
  return {
    pick_id: pickId,
    pick_record: {
      kind: 'match-pick',
      pickId,
      matchId: draft.matchId.trim(),
      pickerId: draft.pickerId.trim(),
      choiceId: draft.choiceId.trim(),
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function submitMatchPick(input: SubmitMatchPickInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: SUBMIT_MATCH_PICK_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
