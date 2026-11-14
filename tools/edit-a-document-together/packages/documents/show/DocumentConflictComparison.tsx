import * as React from 'react';
import { Button, Container } from '@/packages/ui';
import type { CompositionContent } from '../read-data/documents';
import { PageTextPreview } from './DocumentImportDialog';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

/** A read-only view of the rejected edit and the authoritative reload. */
export function DocumentConflictComparison({ local, current, onClose }: {
  local: CompositionContent;
  current: CompositionContent | null;
  onClose: () => void;
}) {
  return <FloatingPanel open title="This document changed elsewhere" onClose={onClose}>
    <Container layout="vertical" gap="md" padding="md">
      <p>Your edit was not saved. Compare it with the version that was loaded. Neither version is changed by this comparison.</p>
      <section aria-label="Your unsaved version"><h3>Your unsaved version</h3>
        <PageTextPreview nodes={local.children} />
      </section>
      <section aria-label="Loaded version"><h3>Loaded version</h3>
        {current ? <PageTextPreview nodes={current.children} /> : <p>The saved document is no longer available.</p>}
      </section>
      <details><summary>All document details</summary>
        <p>Includes formatting, block order, and non-text content.</p>
        <pre aria-label="Your unsaved document details">{JSON.stringify(local, null, 2)}</pre>
        <pre aria-label="Loaded document details">{JSON.stringify(current, null, 2)}</pre>
      </details>
      <Button onClick={onClose}>Close comparison</Button>
    </Container>
  </FloatingPanel>;
}
