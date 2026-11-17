import * as React from 'react';
import { Button, Container, Input, Textarea } from '../../../../ui';
import { buildImportedDocument, compareImportedPages } from '../do-work/imported-document.mjs';
import type { SceneNode } from '../read-data/documents';
import { sceneStyleToCss } from '../../../../ui/show/composition-scene-style';
import { FloatingPanel } from '../../../../screen-arrangement/show/FloatingPanel';

export function PageTextPreview({ nodes }: { nodes: readonly SceneNode[] }) {
  return <>{nodes.map(node => <React.Fragment key={node.id}>
    {typeof node.props?.text === 'string' && <p
      style={{ ...sceneStyleToCss(node.props?.style), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {node.props.text}
    </p>}
    {typeof node.props?.text !== 'string' && !node.children?.length && <p>Non-text content</p>}
    {node.children?.length ? <PageTextPreview nodes={node.children} /> : null}
  </React.Fragment>)}</>;
}

export function DocumentImportDialog({ onClose, onImport, replacementPage, onReplace }: {
  onClose: () => void;
  onImport: (page: SceneNode) => Promise<boolean>;
  replacementPage?: SceneNode | null;
  onReplace?: (reviewed: SceneNode, incoming: SceneNode) => Promise<boolean>;
}) {
  const [id] = React.useState(() => `import-${crypto.randomUUID()}`);
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [format, setFormat] = React.useState<'text' | 'html'>('text');
  const [saving, setSaving] = React.useState(false);
  const [replacing, setReplacing] = React.useState(false);
  const [error, setError] = React.useState('');
  const busy = React.useRef(false);
  const mapped = React.useMemo(() => body.trim()
    ? buildImportedDocument({ doc_id: id, title, ...(format === 'text' ? { body_text: body } : { body_html: body }) }) : null, [id, title, body, format]);
  const mappedPage = mapped?.ok && mapped.block_count > 0 ? mapped.document_record.payload.children[0] as SceneNode : null;
  const page = mappedPage && replacing && replacementPage ? { ...mappedPage, id: replacementPage.id } : mappedPage;
  const comparison = page && replacing && replacementPage ? compareImportedPages(replacementPage, page) : null;
  async function save() {
    if (!page || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = replacing && replacementPage && onReplace
        ? await onReplace(replacementPage, page) : await onImport(page);
      if (saved) onClose();
      else setError('The page could not be saved. Your text is still here.');
    } catch {
      setError('The page could not be saved. Your text is still here.');
    } finally { busy.current = false; setSaving(false); }
  }
  return <FloatingPanel
    open
    title="Import a page"
    description="Paste text or HTML and review it before adding it."
    onClose={() => { if (!busy.current) onClose(); }}>
    <Container layout="vertical" gap="md" padding="md">
      {replacementPage && onReplace && <Container layout="horizontal" gap="sm">
        <Button disabled={saving} aria-pressed={!replacing} onClick={() => setReplacing(false)}>Add a new page</Button>
        <Button disabled={saving} aria-pressed={replacing} onClick={() => setReplacing(true)}>Replace current page</Button>
      </Container>}
      <Container layout="horizontal" gap="sm">
        <Button aria-pressed={format === 'text'} disabled={saving} onClick={() => { setFormat('text'); setError(''); }}>Plain text</Button>
        <Button aria-pressed={format === 'html'} disabled={saving} onClick={() => { setFormat('html'); setError(''); }}>HTML</Button>
      </Container>
      <Input aria-label="Page title" placeholder="Page title (optional)" value={title} disabled={saving} onChange={event => setTitle(event.target.value)} />
      <Textarea aria-label="Text or HTML to import" placeholder="Paste text or HTML here" value={body} disabled={saving} rows={6}
        onChange={event => { setBody(event.target.value); setError(''); }} />
      {page && <p aria-live="polite">1 page · {mapped.block_count} {mapped.block_count === 1 ? 'block' : 'blocks'}</p>}
      {comparison && <div role="region" aria-label="Replacement comparison">
        <p>{comparison.added.length} blocks added · {comparison.removed.length} removed · {comparison.changed.length} changed · {comparison.unchanged.length} unchanged</p>
        <p>The current page will be replaced. Any edits made after opening this window will prevent replacement.</p>
        <div aria-label="Current page text"><PageTextPreview nodes={replacementPage?.children ?? []} /></div>
      </div>}
      {page && <div role="region" aria-label="Import preview">
        <PageTextPreview nodes={page.children ?? []} />
      </div>}
      {error && <p role="alert">{error}</p>}
      <Container layout="horizontal" gap="sm" justifyContent="end">
        <Button variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!page || saving} onClick={() => void save()}>{saving ? 'Saving…' : replacing ? 'Replace page' : 'Add page'}</Button>
      </Container>
    </Container>
  </FloatingPanel>;
}
