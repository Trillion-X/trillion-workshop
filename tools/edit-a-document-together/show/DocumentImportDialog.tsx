import * as React from 'react';
import { Button, Container, errorWords, Input, Spinner, Text, Textarea } from '../../ui';
import { buildImportedDocument, compareImportedPages, documentImportFormat, importDocumentText } from '../do-work/imported-document.mjs';
import type { SceneNode } from '../read-data/documents';
import { sceneStyleToCss } from '../../ui/show/composition-scene-style';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';
import { FileField, type FileFieldSource } from '../../ui/show/file-field';

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

export function DocumentImportDialog({ onClose, onImport, replacementPage, onReplace, fileSource, readFileText }: {
  onClose: () => void;
  onImport: (page: SceneNode, options?: { materializeShortcuts?: boolean }) => Promise<boolean>;
  replacementPage?: SceneNode | null;
  onReplace?: (reviewed: SceneNode, incoming: SceneNode, options?: { materializeShortcuts?: boolean }) => Promise<boolean>;
  fileSource?: FileFieldSource;
  readFileText?: (identity: string, signal?: AbortSignal) => Promise<string>;
}) {
  const [id] = React.useState(() => `import-${crypto.randomUUID()}`);
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [format, setFormat] = React.useState<'text' | 'html'>('text');
  const [saving, setSaving] = React.useState(false);
  const [replacing, setReplacing] = React.useState(false);
  const [error, setError] = React.useState('');
  const [fileIdentity, setFileIdentity] = React.useState('');
  const [filePage, setFilePage] = React.useState<SceneNode | null>(null);
  const [fileTitle, setFileTitle] = React.useState('');
  const [fileBlockCount, setFileBlockCount] = React.useState(0);
  const [fileMaterializeShortcuts, setFileMaterializeShortcuts] = React.useState(false);
  const [fileReading, setFileReading] = React.useState(false);
  const fileRequest = React.useRef(0);
  const fileReadAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { fileRequest.current += 1; fileReadAbort.current?.abort(); }, []);
  const busy = React.useRef(false);
  const mapped = React.useMemo(() => body.trim()
    ? buildImportedDocument({ doc_id: id, title, ...(format === 'text' ? { body_text: body } : { body_html: body }) }) : null, [id, title, body, format]);
  const mappedPage = mapped?.ok && mapped.block_count > 0 ? mapped.document_record.payload.children[0] as SceneNode : null;
  const sourcePage = fileIdentity ? filePage : mappedPage;
  const page = sourcePage && replacing && replacementPage ? { ...sourcePage, id: replacementPage.id } : sourcePage;
  const comparison = page && replacing && replacementPage ? compareImportedPages(replacementPage, page) : null;
  async function save() {
    if (!page || busy.current || fileReading) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = replacing && replacementPage && onReplace
        ? await onReplace(replacementPage, page, { materializeShortcuts: Boolean(fileIdentity) && fileMaterializeShortcuts })
        : await onImport(page, { materializeShortcuts: Boolean(fileIdentity) && fileMaterializeShortcuts });
      if (saved) onClose();
      else setError('The page could not be saved. Your text is still here.');
    } catch {
      setError('The page could not be saved. Your text is still here.');
    } finally { busy.current = false; setSaving(false); }
  }
  return <FloatingPanel
    open
    title="Import a page"
    description="Paste text or HTML and review it before adding it. From HTML, headings, paragraphs, list items and table rows are kept; HTTP(S) link destinations and image sources are retained."
    onClose={() => { if (!busy.current) onClose(); }}>
    <Container layout="vertical" gap="md" padding="md">
      {replacementPage && onReplace && <Container layout="horizontal" gap="sm">
        <Button disabled={saving} aria-pressed={!replacing} onClick={() => setReplacing(false)}>Add a new page</Button>
        <Button disabled={saving} aria-pressed={replacing} onClick={() => setReplacing(true)}>Replace current page</Button>
      </Container>}
      {fileSource && readFileText && <>
        <FileField label="Markdown, HTML, or Trillion JSON file" takes="document" value={fileIdentity} source={fileSource}
          onChange={async (identity, entry) => {
            if (busy.current) return;
            fileReadAbort.current?.abort();
            const cancellation = new AbortController();
            fileReadAbort.current = cancellation;
            const request = ++fileRequest.current;
            setFileIdentity(identity); setFilePage(null); setFileTitle(''); setFileBlockCount(0); setError('');
            setFileReading(Boolean(identity));
            if (!identity) return;
            try {
              const imported = importDocumentText(await readFileText(identity, cancellation.signal), `import-${crypto.randomUUID()}`, { format: documentImportFormat(entry) });
              if (fileRequest.current !== request) return;
              const nextPage = imported.page as SceneNode;
              setFilePage(nextPage);
              setFileTitle(imported.title);
              setFileBlockCount(imported.block_count);
              setFileMaterializeShortcuts(imported.materialize_shortcuts === true);
            } catch (reason) {
              if (fileRequest.current === request) setError(errorWords(reason, 'This composition file could not be opened.'));
            } finally { if (fileRequest.current === request) setFileReading(false); }
          }} />
        {fileReading ? <Spinner aria-label="Opening file" /> : null}
        {filePage && <Text role="status">Loaded {fileTitle || 'document'} from your Files. Original scene identities and content are preserved for Trillion bundles; Markdown and HTML are converted to editable blocks.</Text>}
      </>}
      <Container layout="horizontal" gap="sm">
        <Button aria-pressed={format === 'text'} disabled={saving} onClick={() => { fileRequest.current += 1; fileReadAbort.current?.abort(); setFileReading(false); setFilePage(null); setFileIdentity(''); setFormat('text'); setError(''); }}>Plain text</Button>
        <Button aria-pressed={format === 'html'} disabled={saving} onClick={() => { fileRequest.current += 1; fileReadAbort.current?.abort(); setFileReading(false); setFilePage(null); setFileIdentity(''); setFormat('html'); setError(''); }}>HTML</Button>
      </Container>
      <Input aria-label="Page title" placeholder="Page title (optional)" value={title} disabled={saving || Boolean(fileIdentity)} onChange={event => setTitle(event.target.value)} />
      <Textarea aria-label="Text or HTML to import" placeholder="Paste text or HTML here" value={body} disabled={saving} rows={6}
        onChange={event => { fileRequest.current += 1; fileReadAbort.current?.abort(); setFileReading(false); setFilePage(null); setFileIdentity(''); setBody(event.target.value); setError(''); }} />
      {page && <p aria-live="polite">1 page · {filePage ? fileBlockCount : mapped?.block_count ?? 0} {(filePage ? fileBlockCount : mapped?.block_count ?? 0) === 1 ? 'block' : 'blocks'}</p>}
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
        <Button variant="primary" disabled={!page || saving || fileReading} onClick={() => save()}>{saving ? 'Saving…' : replacing ? 'Replace page' : 'Add page'}</Button>
      </Container>
    </Container>
  </FloatingPanel>;
}
