// src/workspace/saved-examples-screen.tsx
//
// PURPOSE
//   Saved examples (entry `saved-examples`, the screen of tool:list-saved-examples,
//   records/workshop-saved-example-tool-records.json): every post, video and page the person or their AI kept because
//   it worked, as picture cards or a table through the shared record views, each with its link, its words, its
//   pictures and why it worked. At the top, one field takes a pasted link: the link is read into its card (the shared
//   LinkPreview, through read-link.ts) and kept with why it worked. Each example opens its original and can be removed.
//   Every read and write goes to the person's own store (/work/api/saved-examples, src/saved-examples.mjs), the same
//   owner their AI's tools use, so the screen and the AI always agree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every example is one the store answered; an empty list says so in words.
//   2. A pasted link is shown as the page describes itself before it is kept, never as a guessed title.
//   3. Every element is a shared part (record views, LinkPreview, Input, Textarea, Button, Text, the shared loading
//      and failed states); this file writes no markup.

import * as React from 'react';
import { Button, Container, Input, Text, Textarea } from '../../parts/ui';
import { LinkPreview } from '../../parts/ui/show/link-preview';
import { RecordViews, type BulkAction, type FieldDescriptor, type RecordView } from '../../parts/ui/show/record-views/record-views';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { linkInPaste, linkPreviewProps, readLink, type LinkCard } from './read-link';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Example = {
  id: string; url: string; host: string; site: string | null; title: string | null; words: string | null;
  pictures: string[]; why_it_worked: string | null; collection: string | null; added_from: string; added_at: string;
};

const API = '/work/api/saved-examples';
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const openOriginal = (example: Example | undefined) => { if (example) window.open(example.url, '_blank', 'noopener'); };

const FIELDS: FieldDescriptor[] = [
  { id: 'picture', label: 'Picture', kind: 'thumbnail', sortable: false, width: 96, read: (row: Example) => row.pictures[0] ?? '' },
  { id: 'title', label: 'Example', icon: 'Bookmark', preview: 'heading', ruleKind: 'text', filterable: true, sortable: true, width: 300, read: (row: Example) => row.title ?? row.host },
  { id: 'why', label: 'Why it worked', icon: 'Sparkles', preview: true, ruleKind: 'text', filterable: true, width: 360, read: (row: Example) => row.why_it_worked ?? '' },
  { id: 'words', label: 'Its words', icon: 'Quote', preview: true, ruleKind: 'text', filterable: true, width: 360, read: (row: Example) => row.words ?? '' },
  { id: 'site', label: 'Site', icon: 'Globe', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 150, read: (row: Example) => row.site ?? row.host },
  { id: 'collection', label: 'Collection', icon: 'Folder', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, hiddenByDefault: true, width: 160, read: (row: Example) => row.collection ?? '' },
  { id: 'link', label: 'Link', icon: 'Link', ruleKind: 'text', filterable: true, hiddenByDefault: true, width: 280, read: (row: Example) => row.url },
  { id: 'added', label: 'Saved', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', sortable: true, width: 140, read: (row: Example) => day(row.added_at), factValue: (row: Example) => Date.parse(row.added_at), sortValue: (row: Example) => Date.parse(row.added_at) },
];
const VIEWS: RecordView[] = [{ id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }, { id: 'table', label: 'Table', icon: 'Table' }];

/** The field a link is pasted into, the link read as its card, why it worked, and Save. */
function AddExample({ onSaved }: { onSaved: () => void }) {
  const [link, setLink] = React.useState('');
  const [why, setWhy] = React.useState('');
  const [card, setCard] = React.useState<LinkCard | null>(null);
  const [said, setSaid] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const url = linkInPaste(link);
  React.useEffect(() => {
    setCard(null);
    if (!url) return undefined;
    const reading = new AbortController();
    readLink(url, { signal: reading.signal }).then(setCard, (error: Error) => { if (!reading.signal.aborted) setSaid(errorWords(error)); });
    return () => reading.abort();
  }, [url]);
  const save = async () => {
    if (!url) { setSaid('Paste a link to a post, video or page first.'); return; }
    setBusy(true);
    setSaid('');
    try {
      await postJson<Example>(API, { url, ...(why.trim() ? { why_it_worked: why.trim() } : {}), added_from: 'person' });
      setLink('');
      setWhy('');
      setSaid('Saved.');
      onSaved();
    } catch (error) {
      setSaid(errorWords(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Container layout="vertical" gap="sm" data-saved-example-add="">
      <Input
        aria-label="Link to a post, video or page that worked"
        placeholder="Paste a link to a post, video or page that worked"
        value={link}
        onChange={event => { setLink(event.target.value); setSaid(''); }}
      />
      {card ? <LinkPreview {...linkPreviewProps(card)} className="max-w-md" /> : null}
      {url ? (
        <Textarea aria-label="Why it worked" placeholder="Why it worked (optional)" value={why} rows={2} onChange={event => setWhy(event.target.value)} />
      ) : null}
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button variant="primary" size="sm" disabled={!url || busy} onClick={() => save()}>{busy ? 'Saving' : 'Save example'}</Button>
        {said ? <Text variant="caption" color="muted" role="status">{said}</Text> : null}
      </Container>
    </Container>
  );
}

function SavedExamples({ examples, reload }: { examples: Example[]; reload: () => void }) {
  const [view, setView] = React.useState('gallery');
  const byId = React.useMemo(() => new Map(examples.map(example => [example.id, example])), [examples]);
  const actions = React.useMemo<BulkAction[]>(() => [
    { id: 'open', label: 'Open the original', icon: 'external-link', run: ids => openOriginal(byId.get(ids[0] ?? '')) },
    { id: 'remove', label: 'Remove', icon: 'trash-2', tone: 'destructive', run: ids => { void Promise.all(ids.map(id => postJson(`${API}/remove`, { id }))).finally(reload); } },
  ], [byId, reload]);
  return (
    <Container layout="vertical" gap="lg" padding="lg" height="full" minHeight="0" data-saved-examples-screen="">
      <Container layout="vertical" gap="xs">
        <Text variant="title">Saved examples</Text>
        <Text variant="body" color="muted">Posts, videos and pages that worked, kept with why, so you and your AI can make your own in the same shape.</Text>
      </Container>
      <AddExample onSaved={reload} />
      <Container layout="vertical" flex={1} minHeight="0">
        <RecordViews
          label="Saved examples"
          {...recordFilter}
          fields={FIELDS}
          records={examples}
          identify={(example: Example) => example.id}
          views={VIEWS}
          view={view}
          onViewChange={setView}
          onOpen={id => openOriginal(byId.get(id))}
          rowActions={actions}
          preferenceKey="trillion-saved-examples"
          emptyMessage={examples.length ? 'No example matches.' : 'Nothing saved yet. Paste a link to a post, video or page that worked, or share one to Trillion with Study this content format.'}
        />
      </Container>
    </Container>
  );
}

function SavedExamplesRoot() {
  const loaded = useScreenLoad('saved-examples', {
    loading: { label: 'Loading your saved examples', layout: 'gallery' },
    read: () => readJson<{ examples: Example[] }>(API).then(answer => answer.examples),
    failed: refusal('Your saved examples could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <SavedExamples examples={loaded.value} reload={() => void loaded.reload()} />;
}

export function mountSavedExamplesScreen(element: HTMLElement): () => void {
  return mountReactSurface(element, <SavedExamplesRoot />);
}
