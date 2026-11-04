// PORTED FROM: bitfield-packages/packages/chat/read-data/use-private-conversations.ts @ e99ac5976
import { useCallback, useEffect, useRef, useState } from 'react';
import { invokePrivateConversation, readPrivateConversations } from './read-private-conversations';

type Projection = Awaited<ReturnType<typeof readPrivateConversations>>;
export function usePrivateConversations(subjectRef: string | null) {
  const generation = useRef(0);
  const [state, setState] = useState<{ subject: string | null; data: Projection | null; loading: boolean; error: string | null }>({ subject: null, data: null, loading: false, error: null });
  const reload = useCallback(async () => {
    const request = ++generation.current;
    if (!subjectRef) { setState({ subject: null, data: null, loading: false, error: null }); return; }
    setState((current) => ({ subject: subjectRef, data: current.subject === subjectRef ? current.data : null, loading: true, error: null }));
    try {
      const data = await readPrivateConversations(subjectRef);
      if (generation.current === request) setState({ subject: subjectRef, data, loading: false, error: null });
    } catch (cause) {
      if (generation.current === request) setState({ subject: subjectRef, data: null, loading: false, error: cause instanceof Error ? cause.message : 'Conversation unavailable' });
    }
  }, [subjectRef]);
  useEffect(() => {
    void reload();
    const reconnect = () => { void reload(); };
    globalThis.addEventListener?.('online', reconnect);
    globalThis.addEventListener?.('focus', reconnect);
    return () => {
      generation.current++;
      globalThis.removeEventListener?.('online', reconnect);
      globalThis.removeEventListener?.('focus', reconnect);
    };
  }, [reload]);
  const acknowledge = useCallback(async (conversation: string, nextSequence: number) => {
    if (!subjectRef) return;
    const request = generation.current;
    try {
      const result = await invokePrivateConversation({ operation: 'acknowledge', subject_ref: subjectRef, conversation_ref: conversation, next_sequence: nextSequence });
      if (generation.current !== request) return;
      const frontier = (result.read_state as { next_sequence?: unknown } | null)?.next_sequence;
      if (!Number.isSafeInteger(frontier) || Number(frontier) < nextSequence) throw new Error('Read acknowledgement is missing its durable frontier');
      setState((current) => current.subject !== subjectRef || !current.data ? current : {
        ...current, data: { ...current.data, unreadByConversation: { ...current.data.unreadByConversation,
          [conversation]: Math.min(current.data.unreadByConversation[conversation] ?? Infinity,
            Math.max(0, (current.data.sessions.find((row) => row.recordId === conversation)?.messageCount ?? 0) - Number(frontier))) } },
      });
    } catch (cause) {
      if (generation.current !== request) return;
      setState((current) => current.subject !== subjectRef ? current : { subject: subjectRef, data: null, loading: false, error: cause instanceof Error ? cause.message : 'Read acknowledgement failed' });
    }
  }, [subjectRef]);
  return { ...(state.subject === subjectRef ? state : { subject: subjectRef, data: null, loading: Boolean(subjectRef), error: null }), reload, acknowledge };
}
