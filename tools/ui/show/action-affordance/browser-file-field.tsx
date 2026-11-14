import React from 'react';
import { Container } from '../container';
import { Text } from '../text';
import type { FieldRenderContext } from './ActionForm';

/** Browser-local capability handle. Bytes stay behind the File handle until an
 * owner materializer is invoked; this UI control never writes storage. */
export interface BrowserFileFieldValue {
  readonly handle: File;
  readonly display_name: string;
  readonly media_type: string;
  readonly byte_length: number;
  readonly last_modified: number;
}

export function BrowserFileField({ field, value, setValue, disabled }: FieldRenderContext): React.ReactElement {
  const selected = value && typeof value === 'object'
    ? value as Partial<BrowserFileFieldValue>
    : null;
  return (
    <Container layout="vertical" gap="xs">
      <input
        aria-label={field.label}
        type="file"
        disabled={disabled}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          setValue({
            handle: file,
            display_name: file.name,
            media_type: file.type || 'application/octet-stream',
            byte_length: file.size,
            last_modified: file.lastModified,
          } satisfies BrowserFileFieldValue);
        }}
      />
      {selected?.display_name ? (
        <Text variant="caption" tone="subtle">
          {selected.display_name} · {selected.byte_length ?? 0} bytes
        </Text>
      ) : null}
    </Container>
  );
}
