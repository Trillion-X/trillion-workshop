import { useMemo } from 'react';
import { useConversationProjections } from '../../../../conversations/read-data/use-conversation-projections';
import { mapConversationProjectionsToChat } from './map-conversation-projections-to-chat';

export function useChatConversationProjections() {
  const {
    recordList,
    messagePages,
    loading,
    error,
  } = useConversationProjections();
  const mapped = useMemo(
    () => mapConversationProjectionsToChat(recordList, messagePages),
    [recordList, messagePages],
  );

  return {
    ...mapped,
    projection: recordList,
    messagePages,
    loading,
    error,
  };
}
