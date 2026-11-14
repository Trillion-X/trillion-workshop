// An opened record's associated files, through the same space grants as the file chooser.
// References and pages are data; the licensed shared tabs, preview and player own all controls.
// Only the chosen file asks for a byte lease. Late replies cannot follow another record, page or clip.
import React from 'react';
import { Button, Container, Text } from '../../parts/ui';
import { ExpandableTabs } from '../../parts/ui/show/expandable-tabs/ExpandableTabs';
import { ScreenState } from '../../parts/ui/show/screen-state';
import { sharedRecordReferencePage } from '../shared-record-references.mjs';
import { contentTypeOf, familyOf, previewFor } from './file-picture';
import { readItemJson } from './api';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { onStoreChange } from './store-changes';
import { MediaWithNotes } from './media-with-notes';

export type SharedRecordItem = { item_id: string; kind: string; title: string | null; body: unknown; withdrawn?: unknown; hidden?: unknown };
type SharedFile = { item_id: string; identity: string; title: string | null; name: string | null; media_type: string | null; byte_length: number | null };
type Reference = { key: string; role: string; source: string; name?: string; identity?: string; item_id?: string; available: boolean; file?: SharedFile; record?: SharedRecordItem };
type Page = { record: SharedRecordItem; references: Reference[]; next_after: string | null };

const pathOf = (spaceId: string, itemId: string) => `/work/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}`;
const labelOf = (reference: Reference) => {
  const name = reference.file?.name ?? reference.name;
  return name ? name.slice(name.lastIndexOf('/') + 1) : reference.record?.title ?? reference.file?.title ?? (reference.role === 'transcript' ? 'Transcript' : 'File');
};

export function OpenedSharedRecord({ item, spaceId, spaceTitle, wordsOf }: {
  item: SharedRecordItem; spaceId: string; spaceTitle: string; wordsOf: (record: SharedRecordItem) => string;
}) {
  const [cursors, setCursors] = React.useState<(string | null)[]>([null]);
  const after = cursors.at(-1) ?? null;
  const scope = JSON.stringify([spaceId, item.item_id, after]);
  const currentScope = React.useRef(scope);
  currentScope.current = scope;
  const [state, setState] = React.useState<{ scope: string; page?: Page; error?: string } | null>(null);
  const [selection, setSelection] = React.useState<{ scope: string; key: string } | null>(null);
  const [opened, setOpened] = React.useState<{ scope: string; key: string; url?: string; mediaType?: string | null; error?: string } | null>(null);
  const [refresh, setRefresh] = React.useState(0);
  const retry = () => setRefresh(value => value + 1);
  const currentSelection = React.useRef('');
  const direct = item.kind === 'file' && typeof (item.body as { identity?: unknown } | null)?.identity === 'string';
  const associated = sharedRecordReferencePage(item.body).references.length > 0;
  React.useEffect(() => {
    if (!associated && !direct) return;
    let active = true;
    let generation = 0;
    const read = async () => {
      const request = ++generation;
      const applies = () => active && currentScope.current === scope && request === generation;
      try {
        const page = direct && refresh === 0
          ? { record: item, references: [{ key: 'file', role: 'file', source: 'file', available: true, file: {
            item_id: item.item_id, identity: (item.body as { identity: string }).identity,
            title: item.title, name: (item.body as { name?: string }).name ?? item.title,
            media_type: (item.body as { media_type?: string }).media_type ?? null, byte_length: null,
          } }], next_after: null }
          : await readItemJson<Page>(`${pathOf(spaceId, item.item_id)}/references${after ? `?after=${encodeURIComponent(after)}` : ''}`);
        if (applies()) setState({ scope, page });
      } catch (error) {
        if (applies()) { setState({ scope, error: errorWords(error) }); setOpened(null); }
      }
    };
    void read();
    const stop = onStoreChange(read);
    return () => { active = false; stop(); };
  }, [scope, item, associated, direct, after, spaceId, refresh]);
  const page = state?.scope === scope ? state.page : undefined;
  const showRecord = selection?.scope === scope && selection.key === 'record';
  const chosen = showRecord ? undefined : page?.references.find(reference => selection?.scope === scope && reference.key === selection.key)
    ?? page?.references.find(reference => reference.available) ?? page?.references[0];
  const chosenKey = showRecord ? 'record' : chosen?.key ?? '';
  const chosenFile = chosen?.file;
  const chosenScope = JSON.stringify([scope, chosenKey, chosenFile?.item_id, chosenFile?.identity]);
  currentSelection.current = chosenScope;
  React.useEffect(() => {
    if (!chosen?.available || !chosenFile) return;
    let active = true;
    let generation = 0;
    const open = async () => {
      const request = ++generation;
      const applies = () => active && currentSelection.current === chosenScope && request === generation;
      try {
        const where = await readItemJson<{ identity: string; url: string; media_type?: string | null }>(`${pathOf(spaceId, chosenFile.item_id)}/file`);
        if (where.identity !== chosenFile.identity) throw new Error('This file changed while it was being opened. Open it again.');
        if (!where.url) throw new Error('This file is no longer available here.');
        if (applies()) setOpened({ scope: chosenScope, key: chosenKey, url: where.url, mediaType: where.media_type });
      } catch (error) {
        if (applies()) setOpened({ scope: chosenScope, key: chosenKey, error: errorWords(error) });
      }
    };
    void open();
    const stop = onStoreChange(open);
    return () => { active = false; stop(); };
  }, [chosenScope, chosen?.available, chosenFile?.item_id, chosenKey, spaceId, refresh]);

  if (!associated && !direct) return <Text variant="body-md">{wordsOf(item)}</Text>;
  const failure = state?.scope === scope ? state.error : null;
  if (failure) return <ScreenState state={{ status: 'failed', title: 'Could not open this record', description: failure, retry: { label: 'Try again', run: retry } }} />;
  if (!page) return <ScreenState state={{ status: 'loading', label: 'Opening this record' }} />;
  const currentOpen = opened?.scope === chosenScope ? opened : null;
  const contentType = chosenFile ? contentTypeOf(chosenFile.name ?? chosenFile.title ?? '', currentOpen?.mediaType ?? chosenFile.media_type) || 'application/octet-stream' : '';
  return (
    <Container layout="vertical" gap="sm" minWidth="0" data-shared-record-files="">
      {associated && page.references.length ? <ExpandableTabs ariaLabel="Files and transcript" mode="choice" value={chosenKey}
        onChange={key => setSelection({ scope, key })} items={[{ id: 'record', label: 'Notes', icon: 'FileText' }, ...page.references.map(reference => ({
          id: reference.key, label: labelOf(reference),
          icon: reference.role === 'transcript' ? 'AlignLeft' : previewFor(familyOf(reference.file?.name ?? reference.name ?? '', reference.file?.media_type)).icon,
        }))]} /> : null}
      {cursors.length > 1 || page.next_after ? <Container layout="horizontal" gap="sm" alignItems="center">
        <Button size="sm" variant="ghost" disabled={cursors.length === 1} onClick={() => setCursors(current => current.slice(0, -1))}>Previous files</Button>
        <Button size="sm" variant="ghost" disabled={!page.next_after} onClick={() => setCursors(current => [...current, page.next_after])}>More files</Button>
      </Container> : null}
      {chosen && !chosen.available ? <ScreenState state={{ status: 'empty', title: 'This file is not available here', description: 'Choose another file, or try this record again when its access changes.' }} />
        : currentOpen?.error ? <ScreenState state={{ status: 'failed', title: 'Could not open this file', description: currentOpen.error, retry: { label: 'Try again', run: retry } }} />
          : chosenFile && currentOpen?.url ? <MediaWithNotes key={chosenScope} identity={chosenFile.identity} url={currentOpen.url} contentType={contentType} label={labelOf(chosen!)}
            space={{ id: spaceId, title: spaceTitle, itemId: page.record.item_id, fileItemId: chosenFile.item_id }} />
            : chosenFile ? <ScreenState state={{ status: 'loading', label: 'Opening this file' }} />
              : chosen?.record ? <Text variant="body-md">{wordsOf(chosen.record)}</Text>
                : <Text variant="body-md">{wordsOf(page.record)}</Text>}
    </Container>
  );
}
