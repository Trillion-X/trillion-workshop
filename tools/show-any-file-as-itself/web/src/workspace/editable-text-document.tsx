import React from 'react';
import { Button, Container, Text, Textarea } from '../../parts/ui';
import { DocumentEditor, documentFromMarkdown, documentToMarkdown, emptyDocument, mintBlockId, DEFAULT_EDITING_RULES, type DocumentValue } from '../../parts/documents';
import { files, readFileLookup } from './api';
import { saveTextVersion } from './upload';
import { documentOperationsAddress, documentOperationsTransport } from './document-operations-transport';
import { onStoreChange } from './store-changes';
import { blocksFromNodes, documentOperationSession, nodesFromBlocks, sameBlocks } from './document-operation-sync.mjs';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';

type ContentPage = { identity: string; byte_length: number; offset: number; bytes_returned: number; encoding: 'utf-8' | 'base64'; content: string };
type FileVersion = { identity: string; media_type: string | null; names?: string[] };
const hasConflictStatus = (error: unknown) => (error as { status?: unknown } | null)?.status === 409;

async function readText(identity: string): Promise<string> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const page = await files.read('read_file', { name_or_identity: identity, offset, length: 262144 }) as ContentPage;
    if (page.identity !== identity || page.offset !== offset || !Number.isSafeInteger(page.byte_length) || page.byte_length < 0 || page.byte_length > 5 * 1024 * 1024 || !['utf-8','base64'].includes(page.encoding) || (offset > 0 && page.byte_length !== total)) {
      throw new Error('This file is too large to edit here, or it changed while opening.');
    }
    if (offset === 0) total = page.byte_length;
    if (offset === total) break;
    if (!page.bytes_returned) break;
    const bytes = page.encoding === 'base64'
      ? Uint8Array.from(atob(page.content), value => value.charCodeAt(0))
      : new TextEncoder().encode(page.content);
    if (bytes.byteLength !== page.bytes_returned || offset + bytes.byteLength > total) throw new Error('This file could not be read completely.');
    parts.push(bytes);
    offset += bytes.byteLength;
    if (offset === total) break;
  }
  if (offset !== total) throw new Error('This file could not be read completely.');
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('This file is not UTF-8 text, so it cannot be edited here.'); }
}

function copyName(name: string, attempt: number): string {
  const slash = name.lastIndexOf('/');
  const prefix = name.slice(0, slash + 1);
  const leaf = name.slice(slash + 1);
  const dot = leaf.lastIndexOf('.');
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const extension = dot > 0 ? leaf.slice(dot) : '';
  return `${prefix}${stem} (edited copy${attempt > 1 ? ` ${attempt}` : ''})${extension}`;
}

type OperationSession = ReturnType<typeof documentOperationSession>;
// Two editors opening the same file version seed the store with the same block ids, so either seed is the same document.
const withSeedIds = (value: DocumentValue): DocumentValue => ({ blocks: value.blocks.map((block, index) => ({ ...block, id: `block:seed:${index}` })) });
const isUndoKey = (event: React.KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z';
const isRedoKey = (event: React.KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.altKey && ((event.shiftKey && event.key.toLowerCase() === 'z') || (!event.shiftKey && event.key.toLowerCase() === 'y'));

export function canEditTextDocument(name: string, mediaType: string | null | undefined): boolean {
  return Boolean(name && (/^text\/(?:plain|markdown)(?:;|$)/i.test(mediaType ?? '') || /\.(?:txt|md|markdown)$/i.test(name)));
}

export function EditableTextDocument({ identity, name, mediaType, onOpenVersion, onOpenLatest, onEditingChange, onSaveVersion }: {
  identity: string;
  name: string;
  mediaType: string | null;
  onOpenVersion: (version: FileVersion) => void;
  onOpenLatest?: (version: FileVersion) => void;
  onEditingChange?: (editing: boolean) => void;
  onSaveVersion?: (version: FileVersion, previousIdentity: string) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [document, setDocument] = React.useState<DocumentValue>(emptyDocument(DEFAULT_EDITING_RULES, mintBlockId));
  const [original, setOriginal] = React.useState('');
  const [baseIdentity, setBaseIdentity] = React.useState(identity);
  const [baseMediaType, setBaseMediaType] = React.useState(mediaType);
  const [message, setMessage] = React.useState('');
  const [conflict, setConflict] = React.useState(false);
  const [pendingPublish, setPendingPublish] = React.useState<{ version: FileVersion; previousIdentity: string } | null>(null);
  const plainText = /\.txt$/i.test(name) || (!/\.(?:md|markdown)$/i.test(name) && /^text\/plain(?:;|$)/i.test(mediaType ?? ''));
  const [plainValue, setPlainValue] = React.useState('');
  // A markdown document is edited as operations in the person's store (document-operation-sync.mjs): other editors'
  // words arrive while this one types, and Undo takes back this editor's own edits only.
  const session = React.useRef<OperationSession | null>(null);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);
  const textFromDocument = (value: DocumentValue) => plainText ? plainValue : documentToMarkdown(value, DEFAULT_EDITING_RULES);
  React.useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  React.useEffect(() => editing && !plainText ? onStoreChange(() => session.current?.sync(), ['/work/api/records']) : undefined, [editing, plainText]);

  const openSession = async (text: string, fileIdentity: string) => {
    const seeded = withSeedIds(documentFromMarkdown(text, DEFAULT_EDITING_RULES, mintBlockId));
    const opened = documentOperationSession({
      address: documentOperationsAddress(name), baseIdentity: fileIdentity, seed: blocksFromNodes(seeded.blocks), transport: documentOperationsTransport,
      onChange: ({ view, source, failure }) => {
        setCanUndo(opened.canUndo());
        setCanRedo(opened.canRedo());
        if (failure) setMessage(errorWords(failure, 'Your latest edit could not be kept with the others. The document shows what is kept.'));
        if (source === 'local') return;
        setDocument(current => sameBlocks(blocksFromNodes(current.blocks), view) ? current : { blocks: nodesFromBlocks(view) as DocumentValue['blocks'] });
      },
    });
    try {
      await opened.open();
      session.current = opened;
      setDocument({ blocks: nodesFromBlocks(opened.view()) as DocumentValue['blocks'] });
    } catch (error) {
      // The file itself still saves by its own version check; the person is told edits are not shared while open.
      setDocument(seeded);
      setMessage(`Edits by other people will not show here while you edit. ${errorWords(error, 'The shared document could not be opened.')}`);
    }
  };
  const edit = (value: DocumentValue) => {
    setDocument(value);
    void session.current?.edit(blocksFromNodes(value.blocks));
  };
  const undo = () => { void session.current?.undo(); };
  const redo = () => { void session.current?.redo(); };
  const closeSession = async (how: 'close' | 'cancel') => {
    const ending = session.current;
    session.current = null;
    setCanUndo(false);
    setCanRedo(false);
    if (ending) await ending[how]();
  };

  const begin = async () => {
    setLoading(true);
    setMessage('');
    try {
      const latest = await readFileLookup<FileVersion>(name);
      if (!Array.isArray(latest.names) || !latest.names.includes(name)) throw new Error('This file no longer has that name, so it cannot be edited here.');
      const text = await readText(latest.identity);
      setBaseIdentity(latest.identity);
      setBaseMediaType(latest.media_type ?? mediaType);
      setOriginal(text);
      if (plainText) setPlainValue(text);
      else await openSession(text, latest.identity);
      setEditing(true);
      if (latest.identity !== identity) setMessage('A newer version of this file is open in the editor.');
    } catch (error) {
      setMessage(errorWords(error, 'This file could not be opened for editing.'));
    } finally { setLoading(false); }
  };

  const openLatest = async () => {
    try {
      const latest = await readFileLookup<FileVersion>(name);
      if (!Array.isArray(latest.names) || !latest.names.includes(name)) throw new Error('This file no longer has that name.');
      (onOpenLatest ?? onOpenVersion)({ ...latest, names: latest.names });
    } catch (error) {
      setMessage(errorWords(error, 'The latest version could not be opened.'));
    }
  };

  const save = async (targetName = name, expected = baseIdentity) => {
    setSaving(true);
    setMessage('');
    try {
      const pending = pendingPublish;
      const saved = pending?.version ?? await saveTextVersion(targetName, textFromDocument(document), expected, baseMediaType ?? 'text/plain; charset=utf-8');
      if (onSaveVersion) {
        try {
          await onSaveVersion(saved, pending?.previousIdentity ?? expected);
        } catch (error) {
          setPendingPublish({ version: saved, previousIdentity: pending?.previousIdentity ?? expected });
          setConflict(hasConflictStatus(error));
          setMessage(`The transcript version is saved, but it is not linked to this recording yet. ${errorWords(error, 'Retry the link update.')}`);
          return;
        }
      }
      setConflict(false);
      setPendingPublish(null);
      await closeSession('close').catch(() => undefined);
      onOpenVersion({ identity: saved.identity, media_type: mediaType, names: [targetName] });
    } catch (error) {
      const collided = hasConflictStatus(error);
      setConflict(collided);
      setMessage(collided ? 'A newer version was saved while you were editing. Your draft is still here.' : errorWords(error, 'The file could not be saved.'));
    } finally { setSaving(false); }
  };

  const saveCopy = async () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const target = copyName(name, attempt);
      setSaving(true);
      setMessage('');
      try {
        const saved = await saveTextVersion(target, textFromDocument(document), null, baseMediaType ?? 'text/plain; charset=utf-8');
        await closeSession('close').catch(() => undefined);
        onOpenVersion({ identity: saved.identity, media_type: baseMediaType, names: [target] });
        return;
      } catch (error) {
        if (!hasConflictStatus(error)) {
          setMessage(errorWords(error, 'The copy could not be saved.'));
          return;
        }
      } finally { setSaving(false); }
    }
    setMessage('A copy could not be named because those file names are already in use. Your draft is still here.');
  };

  if (!editing) return (
    <Container layout="vertical" gap="xs" className="trillion-text-document-actions" data-trillion-document-editor="true">
      <Button variant="outline" size="sm" disabled={loading} onClick={() => begin()}>{loading ? 'Opening editor' : 'Edit'}</Button>
      {message ? <Text variant="caption" role="status">{message}</Text> : null}
    </Container>
  );

  return (
    <Container layout="vertical" gap="sm" className="trillion-text-document-editor" data-trillion-document-editor="true"
      onKeyDownCapture={event => {
        if (plainText) return;
        if (isUndoKey(event) && session.current?.canUndo()) { event.preventDefault(); event.stopPropagation(); undo(); }
        else if (isRedoKey(event) && session.current?.canRedo()) { event.preventDefault(); event.stopPropagation(); redo(); }
      }}>
      {plainText ? <Textarea aria-label={`Edit ${name.split('/').pop() || 'text file'}`} value={plainValue} disabled={saving || Boolean(pendingPublish)} onChange={event => setPlainValue(event.target.value)} placeholder="Write your document" />
        : <DocumentEditor value={document} disabled={saving || Boolean(pendingPublish)} onChange={edit} ariaLabel={`Edit ${name.split('/').pop() || 'text file'}`} placeholder="Write your document" />}
      {message ? <Text variant="caption" role="status">{message}</Text> : null}
      {conflict ? <Text variant="caption">Open the latest version or save your draft as a separate file.</Text> : null}
      <Container layout="horizontal" gap="sm" wrap>
        <Button variant="primary" size="sm" disabled={saving} onClick={() => save()}>{saving ? 'Saving' : pendingPublish ? 'Retry link update' : 'Save'}</Button>
        {!plainText ? <Button variant="outline" size="sm" disabled={saving || !canUndo} onClick={undo}>Undo my last edit</Button> : null}
        {!plainText ? <Button variant="outline" size="sm" disabled={saving || !canRedo} onClick={redo}>Redo</Button> : null}
        {conflict ? <>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => openLatest()}>Open latest</Button>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => saveCopy()}>Save a copy</Button>
        </> : null}
        <Button variant="ghost" size="sm" disabled={saving || Boolean(pendingPublish)} onClick={() => { if (plainText) setPlainValue(original); else { void closeSession('cancel').catch(error => setMessage(errorWords(error, 'Your edits could not all be taken back.'))); setDocument(documentFromMarkdown(original, DEFAULT_EDITING_RULES, mintBlockId)); } setEditing(false); setConflict(false); setMessage(''); }}>Cancel</Button>
      </Container>
    </Container>
  );
}
