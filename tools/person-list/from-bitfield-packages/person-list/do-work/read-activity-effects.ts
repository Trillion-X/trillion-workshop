// package://packages/person-list/do-work/read-activity-effects.ts
//
// Asks the generic find-current-items target for signed_event_effect rows.
// The target name is string data (no sibling package import — isolation
// boundary); decoding stays in read-data/read-leaderboard.ts.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function readActivityEffects(signal?: AbortSignal): Promise<readonly unknown[]> {
  const reply = await sendRequestToBitfieldTarget({
    target: 'find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'signed_event_effect',
      select: ['effect_id', 'kind', 'subject', 'object', 'material'],
    },
  }, signal);
  const payload = isRecord(reply) && reply.payload instanceof Uint8Array ? reply.payload : null;
  if (!payload) return [];
  const text = textDecoder.decode(payload).trim();
  if (!text) return [];
  try {
    const decoded = JSON.parse(text) as unknown;
    if (Array.isArray(decoded)) return decoded;
    if (isRecord(decoded) && Array.isArray(decoded.items)) return decoded.items;
    return [];
  } catch {
    return [];
  }
}
