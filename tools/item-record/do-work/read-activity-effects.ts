// package://packages/item-record/do-work/read-activity-effects.ts
//
// Reads signed_event_effect rows from the reply of the generic find-current-items request. The request is built by the
// caller's host (findActivityEffectsRequest below); this module only reads the reply it is handed, so the folder keeps no
// send path of its own. Decoding stays in read-data/read-leaderboard.ts.

const textDecoder = new TextDecoder();

export function findActivityEffectsRequest(): { target: string; payload: unknown } {
  return {
    target: 'find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'signed_event_effect',
      select: ['effect_id', 'kind', 'subject', 'object', 'material'],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The effect rows in a find-current-items reply handed in by the caller; none when the reply holds no rows. */
export function readActivityEffects(reply: unknown): readonly unknown[] {
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
