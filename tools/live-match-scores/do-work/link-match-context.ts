import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { LiveMatchContextRecord } from '../read-data/live-match-score-types.ts';

export const LINK_MATCH_CONTEXT_ACTION = 'action:live-match-score.link-match-context';

export type LinkMatchContextDraft = {
  contextId?: string;
  matchId: string;
  tournamentId?: string;
  scheduleRowId?: string;
  bracketMatchId?: string;
  standingId?: string;
  leaderboardId?: string;
  now?: Date;
};

export type LinkMatchContextInput = {
  context_id: string;
  context_record: LiveMatchContextRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildLinkMatchContextInput(draft: LinkMatchContextDraft): LinkMatchContextInput {
  const contextId = draft.contextId ?? generatedId('live-match-context');
  return {
    context_id: contextId,
    context_record: {
      kind: 'live-match-context-link',
      contextId,
      matchId: draft.matchId,
      tournamentId: draft.tournamentId,
      scheduleRowId: draft.scheduleRowId,
      bracketMatchId: draft.bracketMatchId,
      standingId: draft.standingId,
      leaderboardId: draft.leaderboardId,
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function linkMatchContext(input: LinkMatchContextInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: LINK_MATCH_CONTEXT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
