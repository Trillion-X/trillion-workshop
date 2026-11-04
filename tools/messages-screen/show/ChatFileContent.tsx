// PORTED FROM: bitfield-packages/packages/chat/show/ChatFileContent.tsx @ e99ac5976
import React, { useEffect, useState } from 'react';
import {
  DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION,
  FileContentRenderer,
  type FileContentRendererClassification,
  type FileContentRendererProps,
} from '../../file-content-renderer/show/FileContentRenderer';
import { askFileClassificationForChat } from '../do-work/ask-file-classification-for-chat';

export function ChatFileContent(props: FileContentRendererProps) {
  const [classification, setClassification] = useState<FileContentRendererClassification>(
    DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION,
  );

  useEffect(() => {
    let cancelled = false;
    setClassification(DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION);
    askFileClassificationForChat(props.filePath)
      .then((nextClassification) => {
        if (!cancelled) setClassification(nextClassification);
      })
      .catch(() => {
        if (!cancelled) setClassification(DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION);
      });
    return () => {
      cancelled = true;
    };
  }, [props.filePath]);

  return <FileContentRenderer {...props} classification={classification} />;
}
