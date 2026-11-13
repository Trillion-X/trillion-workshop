// src/workspace/formats-screen.tsx
//
// PURPOSE
//   Formats (entry `formats`, the one Formats every device opens): type
//   what you want to talk about and see it in every content format you have, each as the account keeps it (GET
//   /work/api/content-formats, src/content-formats.mjs): your own first, then the ones every account starts with. Each
//   card shows the format as it would read (a page: the thought dropped into its first part, the next parts as what to
//   say), led by its own icon or the logo of where it goes, and tabs above the cards keep one category (the formats'
//   own `category`, so a new category is one DATA row). Opening one opens
//   Record video with that script over the picture as a teleprompter that follows the voice, with Have my AI write it
//   beside it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The formats and their parts come from the account; this screen never names one.
//   2. Every card follows the typing; nothing is sent until the person records or asks their AI.
//   3. The read runs through the shared screen-state part: loading, failed with Try again, empty (no formats), drawn.
//   4. Every control is a shared part (parts/ui ListingGrid, ExpandableTabs, Input, Select, Text); this file writes no
//      markup of its own.
//
// PROVENANCE
//   Mailchimp's share-a-post cards (each place drawn as the post itself under that place's logo:
//   mobbin.com/screens/e092458d-2836-4628-b460-9a724277b8f0), Kit's template gallery (a preview sheet on top, the name
//   under it: mobbin.com/screens/5a10bd07-3ec4-453c-b116-ca44f915d63e) and Adobe Express's category row; the
//   visual-hierarchy sheets (agent-junk/2026-10-02/visual-hierarchy): show the thing, never label: value rows.

import * as React from 'react';
import { Container, ExpandableTabs, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text } from '../../parts/ui';
import { ListingGrid, type Listing } from '../../parts/ui/show/listing-card';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { openRecordWith } from './open-record-video';
import { scriptFor } from './recording.mjs';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Format = { id: string; label: string; category?: string; category_icon?: string; icon?: string; logo?: string; description?: string; slots: { id: string; label: string; hint?: string }[]; input?: string; process?: string[]; output?: string; from: string };
type Source = { kind: string; label: string; id: string; title: string; at: string };
type SourceReference = { kind: string; label: string; id: string; title: string };
type Shape = { source: SourceReference | null; material: string };
// How many of a format's parts its page shows; the page fades out after them.
const PARTS_SHOWN = 5;
const ALL = 'all';

/** One format with the thought in it, as a card: the page as it would read, the first part carrying the thought. */
function listingOf(format: Format, thought: string, material: string): Listing {
  const script = scriptFor(format, thought, material);
  return {
    id: format.id,
    title: format.label,
    icon: format.icon ?? 'LayoutTemplate',
    ...(format.logo ? { logo: format.logo } : {}),
    ...(format.from === 'saved' ? { badge: { label: 'Yours', tone: 'good' } } : {}),
    ...(format.description ? { text: format.description } : {}),
    cover: { page: script.lines.slice(0, PARTS_SHOWN).map(line => line.words || line.hint) },
  };
}

function Formats({ formats }: { formats: Format[] }) {
  const [thought, setThought] = React.useState('');
  const [sources, setSources] = React.useState<Source[]>([]);
  const [sourceReference, setSourceReference] = React.useState<SourceReference | null>(null);
  const [selectedSource, setSelectedSource] = React.useState('thought');
  const [material, setMaterial] = React.useState('');
  const [sourceLoading, setSourceLoading] = React.useState(false);
  const [sourceError, setSourceError] = React.useState('');
  const [category, setCategory] = React.useState(ALL);
  const sourceRequest = React.useRef(0);
  React.useEffect(() => {
    let active = true;
    readJson<{ sources: Source[] }>('/work/api/content-formats/sources')
      .then(answer => { if (active) setSources(answer.sources); })
      .catch(() => { if (active) setSources([]); });
    return () => { active = false; };
  }, []);
  const byId = React.useMemo(() => new Map(formats.map(format => [format.id, format])), [formats]);
  const sourceKeys = React.useMemo(() => new Map(sources.map((source, index) => [`source-${index}`, source])), [sources]);
  // The tabs: every category the formats name, in the order they first appear.
  const categories = React.useMemo(() => {
    const kinds = new Map<string, { label: string; icon: string }>();
    for (const format of formats) if (format.category && !kinds.has(format.category)) kinds.set(format.category, { label: format.category, icon: format.category_icon ?? 'Tag' });
    return [...kinds.values()];
  }, [formats]);
  const listings = React.useMemo(() => formats.filter(format => category === ALL || format.category === category).map(format => listingOf(format, thought, material)), [formats, category, thought, material]);
  const selectSource = async (key: string | null) => {
    const request = ++sourceRequest.current;
    const next = key ?? 'thought';
    setSelectedSource(next);
    setMaterial('');
    setSourceReference(null);
    setSourceError('');
    if (next === 'thought') { setSourceLoading(false); return; }
    const source = sourceKeys.get(next);
    if (!source) return;
    setSourceLoading(true);
    try {
      const answer = await postJson<Shape>('/work/api/content-formats/shape', { source: { kind: source.kind, id: source.id } });
      if (request !== sourceRequest.current) return;
      if (!answer.source) throw new Error('That item is no longer available in this account. Choose it again.');
      setMaterial(answer.material);
      setSourceReference(answer.source);
      setThought('');
    } catch (error) {
      if (request === sourceRequest.current) setSourceError(errorWords(error, 'That item could not be opened.'));
    } finally {
      if (request === sourceRequest.current) setSourceLoading(false);
    }
  };
  const open = (id: string) => {
    if (sourceLoading || (selectedSource !== 'thought' && (!sourceReference || sourceError))) return;
    const format = byId.get(id);
    if (format) openRecordWith(format.id, format.label, thought.trim(), '', sourceReference);
  };
  return (
    <Container layout="vertical" gap="lg" padding="lg" height="full" minHeight="0" overflow="y-auto" data-formats-screen="">
      <Text variant="title">Formats</Text>
      <Container layout="horizontal" gap="sm" wrap alignItems="center">
        <Container layout="vertical" flex={1} minWidth="min(16rem, 100%)">
          <Input
            aria-label="Add a thought"
            placeholder="What do you want to talk about?"
            value={thought}
            disabled={sourceLoading}
            onChange={event => setThought(event.target.value)}
          />
        </Container>
        {sources.length > 0 && (
          <Select value={selectedSource} onValueChange={value => { void selectSource(typeof value === 'string' ? value : null); }}>
            <SelectTrigger className="w-full sm:w-64" aria-label="Start from your own words"><SelectValue>{selectedSource === 'thought' ? 'Start with a thought' : (() => { const source = sourceKeys.get(selectedSource); return source ? `${source.label[0]?.toUpperCase()}${source.label.slice(1)} · ${source.title}` : 'Start with a thought'; })()}</SelectValue></SelectTrigger>
            <SelectPopup>
              <SelectItem value="thought">Start with a thought</SelectItem>
              {sources.map((source, index) => <SelectItem key={`${source.kind}:${source.id}`} value={`source-${index}`}>{`${source.label[0]?.toUpperCase()}${source.label.slice(1)} · ${source.title || 'Untitled'}`}</SelectItem>)}
            </SelectPopup>
          </Select>
        )}
        {sourceLoading && <Text variant="caption" color="muted">Opening your words…</Text>}
        {sourceError && <Text variant="caption" color="muted">{sourceError}</Text>}
      </Container>
      {categories.length > 1 && (
        // On a narrow pane the tabs scroll sideways rather than running past its edge.
        <Container layout="horizontal" overflow="x-auto" minWidth="0" className="shrink-0" data-formats-kinds="">
          <ExpandableTabs
            ariaLabel="Kinds of format"
            value={category}
            onChange={setCategory}
            items={[{ id: ALL, label: 'All', icon: 'LayoutGrid' }, ...categories.map(one => ({ id: one.label, label: one.label, icon: one.icon }))]}
          />
        </Container>
      )}
      <ListingGrid label="Formats" listings={listings} onOpen={open} />
    </Container>
  );
}

function FormatsRoot() {
  const loaded = useScreenLoad('formats', {
    loading: { label: 'Loading your formats', layout: 'gallery' },
    read: () => readJson<{ formats: Format[] }>('/work/api/content-formats').then(answer => answer.formats),
    empty: formats => (formats.length ? null : { status: 'empty', icon: 'LayoutTemplate', title: 'No formats yet', description: 'Ask your AI to save a format you like, and it appears here.' }),
    failed: refusal('Your formats could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <Formats formats={loaded.value} />;
}

export function mountFormatsScreen(element: HTMLElement): () => void {
  return mountReactSurface(element, <FormatsRoot />);
}
