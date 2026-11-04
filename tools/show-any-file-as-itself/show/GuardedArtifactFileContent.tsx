// The account-bound guarded relation adapter lives apart from the renderer:
// supplied content can be displayed publicly without loading a private store.
// Retrieval, integrity verification and URL revocation retain their existing
// owner; callers of this adapter select guarded relation delivery explicitly.
import React from 'react';
import { Text } from '../../ui';
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { readGuardedArtifactObjectUrl } from '../../ui/show/media-bytes/read-guarded-artifact-blob';
import { FileContentRenderer, type FileContentRendererProps } from './FileContentRenderer';

export interface GuardedArtifactFileContentProps extends Omit<
  FileContentRendererProps,
  'filePath' | 'content' | 'bytes' | 'artifactRef'
> {
  /** Opaque relation identity returned by content-media-evidence. Raw CAS
   * coordinates are deliberately not accepted by this rendering boundary. */
  readonly relationRef: string;
  readonly dispatch?: (request: { target: string; payload: { relation_ref: string } }) => Promise<unknown>;
}

function decodedText(bytes: Uint8Array, mediaType: string): string | undefined {
  if (!(mediaType.startsWith('text/') || mediaType === 'application/json')) return undefined;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Relation-ready renderer adapter. It delegates retrieval and verification to
 * the shared guarded/revocable blob helper, decodes bytes only for allowed text
 * and markdown media, and gives FileContentRenderer caller-ready bytes plus
 * metadata. The renderer never receives a storage address or performs CAS I/O.
 */
export function GuardedArtifactFileContent({
  relationRef,
  dispatch = sendRequestToBitfieldTarget,
  ...rendererProps
}: GuardedArtifactFileContentProps): React.ReactElement {
  const [state, setState] = React.useState<{
    bytes: Uint8Array;
    displayName: string;
    mediaType: string;
    content?: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let opened: Awaited<ReturnType<typeof readGuardedArtifactObjectUrl>> | null = null;
    setState(null);
    setError(null);
    void (async () => {
      try {
        opened = await readGuardedArtifactObjectUrl(relationRef, dispatch);
        const next = {
          bytes: opened.bytes,
          displayName: opened.displayName,
          mediaType: opened.mediaType,
          content: decodedText(opened.bytes, opened.mediaType),
        };
        if (cancelled) {
          opened.revoke();
          return;
        }
        setState(next);
      } catch {
        if (!cancelled) setError('This file could not be safely displayed.');
      }
    })();
    return () => {
      cancelled = true;
      opened?.revoke();
    };
  }, [dispatch, relationRef]);

  if (error) return <Text color="faint">{error}</Text>;
  if (!state) return <Text color="faint">Loading file…</Text>;
  return (
    <FileContentRenderer
      {...rendererProps}
      filePath={state.displayName}
      content={state.content}
      bytes={state.bytes}
      artifactRef={{ media_type: state.mediaType, display_name: state.displayName, byte_length: state.bytes.byteLength }}
    />
  );
}
