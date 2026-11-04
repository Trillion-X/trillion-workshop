// PORTED FROM: bitfield-packages/packages/chat/read-data/project-conversation-owner-events.ts @ e99ac5976
import type { AgentMessage } from './chat-message-types';

type Row = { payload?: unknown };

function records(value: unknown): Record<string, unknown>[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return source.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const payload = (item as Row).payload;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? [payload as Record<string, unknown>]
      : [item as Record<string, unknown>];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface ConversationOwnerState {
  readonly state: string;
  readonly proofRefs: readonly string[];
  readonly correctedFactRefs: readonly string[];
  readonly supersedesRefs: readonly string[];
  readonly retractsEffectRef: string | null;
}

export function readConversationOwnerState(
  raw: unknown,
  operationId: string,
  subjectRef: string,
): ConversationOwnerState | null {
  const matches = records(raw).filter((row) => row.operationId === operationId
    && row.subject_ref === subjectRef);
  if (matches.length !== 1) return null;
  const row = matches[0];
  if (row.privacy_class !== 'private' || typeof row.state !== 'string') return null;
  return {
    state: row.state,
    proofRefs: strings(row.proof_refs),
    correctedFactRefs: strings(row.fact_refs),
    supersedesRefs: strings(row.supersedes_refs),
    retractsEffectRef: typeof row.retracts_effect_ref === 'string' ? row.retracts_effect_ref : null,
  };
}

export function projectConversationNotifications(
  raw: unknown,
  subjectRef: string,
  conversationRef: string,
): AgentMessage[] {
  return records(raw)
    .filter((row) => row.kind === 'notification.event'
      && row.privacy_class === 'private'
      && row.conversation_ref === conversationRef
      && strings(row.audience_refs).includes(subjectRef))
    .sort((left, right) => String(left.occurred_at ?? '').localeCompare(String(right.occurred_at ?? '')))
    .map((row) => ({
      id: `notification:${String(row.notification_id)}`,
      type: 'text' as const,
      role: 'assistant' as const,
      content: [row.title, row.body]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n\n'),
      timestamp: typeof row.occurred_at === 'string' ? row.occurred_at : undefined,
      atomRef: typeof row.notification_id === 'string' ? row.notification_id : undefined,
    }));
}
