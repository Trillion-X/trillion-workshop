import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type AgentProfileUpdateInput = {
  agent_ref: string;
  patch?: unknown;
  target: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): AgentProfileUpdateInput {
  if (!isRecord(value)) throw new Error('agent profile update input must be an object');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  if (typeof value.agent_ref !== 'string' || !value.agent_ref.trim()) throw new Error('agent_ref is required');
  return { agent_ref: value.agent_ref, patch: value.patch, target: value.target };
}

export function requestAgentProfileUpdate(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      agent_ref: request.agent_ref,
      kind: 'ai-agent-profile-update-request',
      patch: request.patch,
    },
  });
}
