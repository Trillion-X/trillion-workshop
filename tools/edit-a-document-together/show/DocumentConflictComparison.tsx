import * as React from 'react';
import { Button, Container, SchemaValueView } from '../../ui';
import type { CompositionContent } from '../read-data/documents';
import { PageTextPreview } from './DocumentImportDialog';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

/** Review both versions without replacing the document under the cursor. */
export function DocumentConflictComparison({ local, current, currentKnown = true, recoveryKept = null, onClose, onUseSaved, onSaveLocal }: {
  local: CompositionContent;
  current: CompositionContent | null;
  currentKnown?: boolean;
  recoveryKept?: boolean | null;
  onClose: () => void;
  onUseSaved?: () => Promise<boolean>;
  onSaveLocal?: () => Promise<boolean>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  async function choose(action: () => Promise<boolean>) {
    setBusy(true);
    setFailure(null);
    try {
      if (!await action()) setFailure('The saved version changed again. Review both versions before choosing.');
    } catch { setFailure('Your edit is still here. The version could not be checked; try again.'); }
    finally { setBusy(false); }
  }
  return <FloatingPanel open title="This document changed elsewhere" onClose={onClose}>
    <Container layout="vertical" gap="md" padding="md">
      <p>Your words are still in the editor. Compare them with the saved version before choosing which version to keep.</p>
      <p role="status">{recoveryKept === true ? 'A recovery copy of your version is saved on this device.'
        : recoveryKept === false ? 'Your edits are still on screen. This device could not keep a recovery copy; keep this page open until they save.'
        : 'Keeping a recovery copy of your version…'}</p>
      {failure ? <p role="status">{failure}</p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {onSaveLocal ? <Button disabled={busy || !currentKnown} onClick={() => { void choose(onSaveLocal); }}>Save my version</Button> : null}
        {onUseSaved ? <Button disabled={busy || !currentKnown} onClick={() => { void choose(onUseSaved); }}>Use saved version</Button> : null}
        <Button disabled={busy} onClick={onClose}>Keep editing</Button>
      </div>
      <section aria-label="Your unsaved version"><h3>Your unsaved version</h3>
        <PageTextPreview nodes={local.children} />
      </section>
      <section aria-label="Saved version"><h3>Saved version</h3>
        {!currentKnown ? <p>Checking the saved version…</p>
          : current ? <PageTextPreview nodes={current.children} /> : <p>The saved document is no longer available.</p>}
      </section>
      <details><summary>Compare formatting and block details</summary>
      <section aria-label="Your unsaved document details"><h3>Your unsaved version in full</h3>
        <SchemaValueView value={local} designed={false} />
      </section>
      {current ? <section aria-label="Saved document details"><h3>Saved version in full</h3>
        <SchemaValueView value={current} designed={false} />
      </section> : null}
      </details>
    </Container>
  </FloatingPanel>;
}

