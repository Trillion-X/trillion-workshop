// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-result-policy.ts @ e99ac5976
import type { PublishedRecord } from '../../ui/show/placeable-surface-intent';
import type { ToolResultPolicy } from '../../ai-tool-catalog/do-work/prepare-tool-result';

export const CHAT_RESULT_POLICY_KIND = 'chat.result-policy';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Reads one addressed policy from chat's current feed.  A prompt descriptor is
 * not itself a policy: the reference must resolve to a current record of the
 * declared kind, with both byte limits present.  This keeps output policy as
 * editable Society DATA while refusing malformed or substituted records.
 */
export function readChatResultPolicy(
  records: readonly PublishedRecord[],
  resultPolicyRef: string | undefined,
): ToolResultPolicy | null {
  if (!resultPolicyRef) return null;
  const entry = records.find((record) => record.recordId === resultPolicyRef);
  if (!entry || !object(entry.payload)) return null;
  const payload = entry.payload;
  if (payload.kind !== CHAT_RESULT_POLICY_KIND || payload.id !== resultPolicyRef) return null;
  const maxBytes = positiveInteger(payload.max_bytes);
  const maxAddressBytes = positiveInteger(payload.max_address_bytes);
  return maxBytes && maxAddressBytes ? { maxBytes, maxAddressBytes } : null;
}
