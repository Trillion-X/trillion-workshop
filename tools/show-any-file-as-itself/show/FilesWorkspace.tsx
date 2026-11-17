// package-set://bitfield-studio/packages/files/show/FilesWorkspace.tsx
//
// Generic subject-backed files workspace. It reads one opaque subjectRef and
// lets the browser render the handed object without screen-arrangement knowing
// file type, source, or storage details.

import React from 'react';
import { Card, Container, FilePreview, Text } from '../../ui/index.ts';
import { FilesSurface } from './FilesSurface.tsx';
import {
  readPlaceableSurfaceSubject,
  type PlaceableSurfaceSubjectRef,
  type PlaceableSurfaceSubjectSnapshot,
} from '../../ui/show/placeable-surface-intent/placeable-surface-subject';

export interface FilesWorkspaceProps {
  surfaceInput?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSubjectRef(surfaceInput: Record<string, unknown> | undefined): PlaceableSurfaceSubjectRef | null {
  const subjectRef = surfaceInput?.subjectRef;
  if (!isRecord(subjectRef)) return null;
  return typeof subjectRef.address === 'string' && subjectRef.address.length > 0
    ? { address: subjectRef.address }
    : null;
}

function useObjectUrl(subject: PlaceableSurfaceSubjectSnapshot | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const handle = subject?.handle;
    if (!(handle instanceof Blob)) {
      setUrl(null);
      return undefined;
    }

    const nextUrl = URL.createObjectURL(handle);
    setUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [subject]);

  return url;
}

export function FilesWorkspace({ surfaceInput }: FilesWorkspaceProps) {
  const subjectRef = React.useMemo(() => readSubjectRef(surfaceInput), [surfaceInput]);
  const subject = React.useMemo(
    () => subjectRef ? readPlaceableSurfaceSubject(subjectRef) : null,
    [subjectRef],
  );
  const objectUrl = useObjectUrl(subject);
  const display = subject?.display;
  const title = display?.name ?? 'Files';
  const contentType = display?.content_type ?? 'application/octet-stream';

  if (!subjectRef) {
    return <FilesSurface title="Files" />;
  }

  return (
    <Container layout="vertical" gap="md" padding="none" height="full" minHeight="0" data-files-workspace>
      <Card variant="nested" padding="md">
        <Container layout="vertical" gap="xs">
          <Text variant="body" weight="medium">{title}</Text>
          <Text variant="label" color="faint">
            {contentType}
            {typeof display?.byte_length === 'number' ? ` · ${display.byte_length} bytes` : ''}
          </Text>
        </Container>
      </Card>

      {objectUrl ? (
        <Card variant="nested" padding="none" className="min-h-0 flex-1 overflow-hidden">
          <FilePreview url={objectUrl} contentType={contentType} label={title} />
        </Card>
      ) : (
        <Card variant="nested" padding="md">
          <Text color="faint">Subject admitted. No browser-local object handle is attached.</Text>
        </Card>
      )}
    </Container>
  );
}
