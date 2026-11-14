// package-set://bitfield-studio/packages/poker-rules/do-work/poker-rule-requests.ts

import type { PlayerAction, PokerTableConfig } from '../read-data/poker-rules.ts';

export type PokerRuleRequest =
  | { operation: 'configure-table'; config: Partial<PokerTableConfig> }
  | { operation: 'start-game'; playerIds: string[] }
  | { operation: 'player-action'; playerId: string; action: PlayerAction; amount?: number }
  | { operation: 'next-hand'; advanceBlinds: boolean }
  | { operation: 'toggle-reveal'; playerId: string }
  | { operation: 'kick-player'; playerId: string }
  | { operation: 'reset-table' };

export interface WorkflowTargetRequest {
  target: 'slot::workflow';
  payload: {
    operation: 'execute_definition';
    definition_id: string;
    include_steps: false;
    include_output: false;
    input: PokerRuleRequest;
  };
}
export function buildPokerRuleWorkflowRequest(input: PokerRuleRequest): WorkflowTargetRequest {
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: `action:poker-rules:${input.operation}`,
      include_steps: false,
      include_output: false,
      input,
    },
  };
}
