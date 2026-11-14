// package-set://bitfield-studio/packages/investment-command/do-work/run-investment-command-action.ts
//
// Local action invoker for the Trading Center recipe. Cross-package work
// happens through the configured owner target/action, never source imports.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { InvestmentCommandActionRecipe } from '../read-data/investment-command-surface.ts';

export function createInvestmentCommandCycleId(now = Date.now()): string {
  return `paper-cycle:${now.toString(36)}`;
}

function withCycleValues(
  input: Record<string, unknown>,
  cycleId: string,
): Record<string, unknown> {
  return {
    ...input,
    cycle_id: cycleId,
    idempotency_key: cycleId,
    requested_at: new Date().toISOString(),
  };
}

export function buildInvestmentCommandActionPayload(
  action: InvestmentCommandActionRecipe,
  cycleId = createInvestmentCommandCycleId(),
) {
  return {
    operation: 'execute_definition',
    definition_id: action.definitionId,
    include_steps: action.includeSteps,
    include_output: action.includeOutput,
    input: withCycleValues(action.input, cycleId),
  };
}

export function runInvestmentCommandAction(
  action: InvestmentCommandActionRecipe,
  cycleId?: string,
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: action.target,
    payload: buildInvestmentCommandActionPayload(action, cycleId),
  });
}
