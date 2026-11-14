import { useCallback, useEffect, useRef } from 'react';

import { writeFileEditorSelectedTextForNextAgentRequest } from './write-selected-text-for-next-agent-request.ts';

export function useFileEditorSelectedTextForNextAgentRequestWriter(
  identifier: string,
  title: string,
) {
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onSelectionChange = useCallback(
    (
      selectedText: string,
      startLine?: number,
      endLine?: number,
      fullContent?: string,
    ) => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      debounceTimeoutRef.current = setTimeout(() => {
        void writeFileEditorSelectedTextForNextAgentRequest({
          source: 'file',
          identifier,
          title,
          selectedText,
          startLine,
          endLine,
          fullContent,
        });
      }, 200);
    },
    [identifier, title],
  );

  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      void writeFileEditorSelectedTextForNextAgentRequest(null);
    };
  }, [identifier]);

  return { onSelectionChange };
}
