// package-set://bitfield-studio/packages/agents-hub/do-work/dispatch-agent-message.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Blind message dispatch from the agents hub. The hub asks the workflow slot
// to execute a definition whose id arrives as DATA from the hub's own
// `agents-hub-message-dispatch-config` record — this file never imports
// another package's code or contract. The receiving side (whoever reads the
// inbox address that definition writes to) is unknown to the hub by design.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero imports from other feature packages — the definition id is data
// 2. The input shape mirrors the definition's declared input fields
//    (message_id, team, agent, message, from, timestamp)
// 3. Caller supplies the timestamp — this module does no clock reads
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export type TargetRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

export interface MessageDispatchConfig {
  definition_id: string;
  default_team: string;
  from: string;
}

export interface AgentMessage {
  messageId: string;
  agentId: string;
  text: string;
  timestamp: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Decodes the dispatch config from the package's published-records rows. */
export function readMessageDispatchConfig(
  rows: readonly { payload?: unknown }[],
): MessageDispatchConfig | null {
  for (const row of rows) {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'agents-hub-message-dispatch-config') continue;
    const definitionId = typeof payload.definition_id === 'string' ? payload.definition_id : '';
    const defaultTeam = typeof payload.default_team === 'string' ? payload.default_team : '';
    const from = typeof payload.from === 'string' ? payload.from : '';
    if (definitionId && defaultTeam && from) {
      return { definition_id: definitionId, default_team: defaultTeam, from };
    }
  }
  return null;
}

/** Sends one message to one agent through the configured definition. */
export async function dispatchAgentMessage(
  config: MessageDispatchConfig,
  message: AgentMessage,
  send: TargetRequestSender = sendRequestToBitfieldTarget as TargetRequestSender,
): Promise<unknown> {
  console.log(`[agents-hub] dispatch: agent=${message.agentId}, textLen=${message.text.length}`);
  return send({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: config.definition_id,
      include_steps: false,
      include_output: false,
      input: {
        message_id: message.messageId,
        team: config.default_team,
        agent: message.agentId,
        message: message.text,
        from: config.from,
        timestamp: message.timestamp,
      },
    },
  });
}
