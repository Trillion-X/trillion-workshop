// PORTED FROM: bitfield-packages/packages/conversations/read-data/use-conversation-projections.ts @ e99ac5976
import { useMemo } from 'react';
import { useBitfieldData } from '#workspace-records';
import { buildConversationProjections } from './build-conversation-projections';

export function useConversationProjections() {
  const conversationsEntry = useBitfieldData('addressed-exchange-conversations');
  const turnsEntry = useBitfieldData('addressed-exchange-turns');
  const messagePagesEntry = useBitfieldData('addressed-exchange-message-pages');

  const built = useMemo(
    () => {
      try {
        return { ...buildConversationProjections(conversationsEntry, turnsEntry, messagePagesEntry), error: null };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : 'conversation-projection:unavailable';
        const empty = buildConversationProjections([], [], []);
        return {
          recordList: { ...empty.recordList, state: 'error' as const, error },
          messagePages: { ...empty.messagePages, state: 'error' as const, error },
          error,
        };
      }
    },
    [conversationsEntry, turnsEntry, messagePagesEntry],
  );
  const loading = conversationsEntry === null
    || turnsEntry === null
    || messagePagesEntry === null;

  return {
    ...built,
    loading,
  };
}
