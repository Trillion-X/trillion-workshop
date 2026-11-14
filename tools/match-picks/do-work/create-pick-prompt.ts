import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { MatchPickChoice, PickMatchRecord } from '../read-data/match-picks-types.ts';
import { assertFreePickCopy } from './regulated-money-copy-guard.ts';

export const CREATE_MATCH_PICK_PROMPT_ACTION = 'action:match-picks.create-pick-prompt';

export type CreateMatchPickPromptDraft = {
  matchId?: string;
  label: string;
  startsAt?: string;
  choices: MatchPickChoice[];
};

export type CreateMatchPickPromptInput = {
  match_id: string;
  match_record: PickMatchRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function cleanChoice(choice: MatchPickChoice): MatchPickChoice {
  const choiceId = choice.choiceId.trim();
  const label = choice.label.trim();
  if (!choiceId) throw new Error('Choice needs an id');
  if (!label) throw new Error('Choice needs a label');
  assertFreePickCopy(label, 'Choice label');
  return { choiceId, label };
}

export function buildCreateMatchPickPromptInput(draft: CreateMatchPickPromptDraft): CreateMatchPickPromptInput {
  const label = draft.label.trim();
  if (!label) throw new Error('Pick prompt needs a label');
  assertFreePickCopy(label, 'Pick prompt label');
  if (draft.choices.length < 2) throw new Error('Pick prompt needs at least two choices');
  const matchId = draft.matchId ?? generatedId('pick-match');
  return {
    match_id: matchId,
    match_record: {
      kind: 'pick-match',
      matchId,
      label,
      startsAt: draft.startsAt,
      choices: draft.choices.map(cleanChoice),
      status: 'open',
    },
  };
}

export function createMatchPickPrompt(input: CreateMatchPickPromptInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: CREATE_MATCH_PICK_PROMPT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
