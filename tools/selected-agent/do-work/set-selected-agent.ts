// PORTED FROM: bitfield-packages/packages/selected-agent/do-work/set-selected-agent.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';

export const SELECTED_AGENT_ACTION = 'action:update-selected-agent';

/** Persist the selected-agent owner fact. An empty id restores automatic routing. */
export async function setSelectedAgent(
  agentId: string,
  definitionId = SELECTED_AGENT_ACTION,
): Promise<void> {
  await sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      include_output: false,
      definition_id: definitionId,
      input: { value: agentId },
    },
  });
}
