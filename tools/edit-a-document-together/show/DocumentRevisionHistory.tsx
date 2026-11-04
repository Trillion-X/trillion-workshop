import * as React from 'react';
import { Button, Container, Spinner, Text } from '../../ui';
import { VersionHistory, type VersionRow } from '../../ui/show/version-history';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';
import { readWorkspaceDocumentHistory, readWorkspaceDocumentRevision } from '#workspace-records';
import type { SceneNode } from '../read-data/documents';
import { PageTextPreview } from './DocumentImportDialog';

function SavedPagePreview({ id, current }: { id: string; current: SceneNode }) {
  const [saved, setSaved] = React.useState<SceneNode | null>(id === 'reviewed-current' ? current : null);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    if (id === 'reviewed-current') { setSaved(current); return; }
    let active = true;
    setFailed(false); setSaved(null);
    void readWorkspaceDocumentRevision(id).then(result => {
      if (!active) return;
      const value = result?.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || (value as SceneNode).id !== current.id) throw new Error('This version is no longer available.');
      setSaved(value as SceneNode);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [id, current, retry]);
  return <Container layout="vertical" padding="md" gap="sm">
    {failed ? <><Text role="alert">This saved version could not be opened.</Text><Button size="sm" onClick={() => setRetry(value => value + 1)}>Try again</Button></>
      : saved ? <><Text variant="body-xs" color="muted">Text preview · embedded media and live tools are not rendered here.</Text><PageTextPreview nodes={[saved]} /></>
      : <Spinner />}
  </Container>;
}

/** The selected page is the reviewed basis; restore uses the editor's conditional save and undo lane. */
export function DocumentRevisionHistory({ address, page, onClose, onRestore }: {
  address: string;
  page: SceneNode;
  onClose: () => void;
  onRestore: (saved: SceneNode) => Promise<void>;
}) {
  const [rows, setRows] = React.useState<VersionRow[]>([]);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [limited, setLimited] = React.useState(false);
  const [cursor, setCursor] = React.useState<number | string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const scope = React.useRef(0);
  const load = React.useCallback(async (before?: number | string) => {
    const generation = ++scope.current;
    setLoading(true); setError('');
    try {
      const result = await readWorkspaceDocumentHistory(address, { scope_id: page.id, limit: 50, ...(before === undefined ? {} : { before }) });
      if (scope.current !== generation) return;
      if (!result || !Array.isArray(result.revisions)
          || !(result.next_cursor === null
            || Number.isSafeInteger(result.next_cursor) && result.next_cursor >= 0
            || typeof result.next_cursor === 'string' && result.next_cursor.length > 0)) {
        throw new Error('The version history response is incomplete.');
      }
      const versions = result.revisions.filter(row => row.id !== 'reviewed-current').map(row => ({ ...row, current: false }));
      setRows(previous => before === undefined
        ? [{ id: 'reviewed-current', number: 0, label: 'Reviewed page', at: null, by: null, words: 'Page as reviewed when this panel opened', current: true }, ...versions]
        : [...previous, ...versions.filter(row => !previous.some(prior => prior.id === row.id))]);
      setCursor(result.next_cursor);
      setLimited(result.limited);
    } catch { if (scope.current === generation) setError('Version history could not be loaded.'); }
    finally { if (scope.current === generation) setLoading(false); }
  }, [address, page.id]);
  React.useEffect(() => { void load(); return () => { scope.current += 1; }; }, [load, retry]);
  return <FloatingPanel open title="Page history" description="Compare saved versions with the page you reviewed. Restoring preserves other pages and refuses intervening edits."
    width={760} kind="document-history" onClose={onClose}>
    <Container layout="vertical" padding="md" gap="md">
      {limited ? <Text variant="body-xs" color="muted">Some versions were not retained because history reached its storage limit.</Text> : null}
      {error ? <><Text role="alert">{error}</Text><Button size="sm" onClick={() => setRetry(value => value + 1)}>Try again</Button></> : null}
      {loading && !rows.length ? <Spinner /> : <VersionHistory rows={rows} emptyWords="No saved versions yet."
        renderPreview={id => <SavedPagePreview key={id} id={id} current={page} />}
        onRestore={async id => {
          const result = await readWorkspaceDocumentRevision(id);
          const saved = result?.value as SceneNode | undefined;
          if (!saved || saved.id !== page.id) throw new Error('This saved version is no longer available.');
          await onRestore(saved);
        }} />}
      {cursor !== null ? <Button size="sm" variant="secondary" disabled={loading} onClick={() => load(cursor)}>Earlier versions</Button> : null}
    </Container>
  </FloatingPanel>;
}
