// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-transition-policy.ts @ e99ac5976
import type { PublishedRecord } from '../../ui/show/placeable-surface-intent';

export const CHAT_TRANSITION_POLICY_KIND = 'chat.turn-transition-policy';
export type ChatTransitionPolicy = { maxRounds: number; authorizationTtlMs: number };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Resolve one exact current transition policy; ambiguity and malformed DATA fail closed. */
export function readChatTransitionPolicy(records: readonly PublishedRecord[], ref: string | undefined): ChatTransitionPolicy | null {
  if (!ref) return null;
  const matches = records.filter((record) => record.recordId === ref);
  if (matches.length !== 1 || !object(matches[0].payload)) return null;
  const payload = matches[0].payload;
  if (payload.kind !== CHAT_TRANSITION_POLICY_KIND || payload.id !== ref) return null;
  const maxRounds = positive(payload.max_rounds);
  const authorizationTtlMs = positive(payload.authorization_ttl_ms);
  return maxRounds && authorizationTtlMs ? { maxRounds, authorizationTtlMs } : null;
}
