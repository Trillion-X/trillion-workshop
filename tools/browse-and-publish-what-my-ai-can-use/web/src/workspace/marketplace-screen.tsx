// src/workspace/marketplace-screen.tsx
//
// PURPOSE
//   The Marketplace (entry `marketplace`): one shelf of everything a person or their AI can pick up, tools, workflows,
//   studied screens and every kind added later, drawn as the same cards (parts/ui ListingCard) or as a table. A person
//   switches between kinds and between everyone's and their own, searches the whole shelf, narrows a kind by the
//   choices its owner lists (Filter by, in the view bar), opens one in its own tab or its original on the web, and
//   publishes one of their own for every account's AI, or withdraws it, or uses any row as its kind allows (wears a look).
//   Anatomy from real directories: Perplexity's connectors (kind and "All / Connected / Available" pills over a card
//   grid with a state mark: mobbin.com/screens/de0d9c72-9791-49c0-9a99-c1081c3a51f3), Emergent's skills store
//   ("Installed / Browse" with counts, an Install button on each card, an Installed chip:
//   mobbin.com/screens/d7167640-bc99-4abd-a6e5-bdc329396332) and Supabase's integrations (Installed in the card's
//   corner: mobbin.com/screens/0145cf1c-cb24-4847-950b-0cad19752087); the card itself is the shared ListingCard.
//   Every read goes through /work/api/marketplace (src/work-marketplace.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: kinds, their names, icons and counts, the words for who made each item, its badge and facts, and what a
//      person can do with it all come from the Worker's answer (src/marketplace-kinds.json), and so do the fields a kind
//      can be narrowed by and their choices. This file names no kind and no field.
//   2. Search reaches the whole shelf, not only the page loaded: it is the Worker's search, committed from the view bar.
//   3. Only real rows: every item is one an owner answered; an empty shelf says so in words.
//   4. Every element is a shared component (record views, listing cards, tabs, button, the shared empty, loading and
//      plan states); this file writes no markup.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RecordViews, type BulkAction, type FieldDescriptor, type RecordView } from '../../parts/ui/show/record-views/record-views';
import { ListingGrid, type Listing } from '../../parts/ui/show/listing-card';
import { ExpandableTabs } from '../../parts/ui/show/expandable-tabs';
import { Button } from '../../parts/ui/show/button';
import { Container, Input, Switch, Text } from '../../parts/ui';
import { MarketplacePreview, type MarketplacePreviewItem } from '../../parts/ui/show/marketplace-preview/MarketplacePreview';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { notify } from '../../parts/ui/show/coss/notifications';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { readJson } from './api';
import { recordFilter } from './record-filter';
import { askFor, reasonOf, refusal } from './failure';

type Fact = { label: string; value: string; icon?: string };
type Item = {
  id: string; key: string; kind: string; kind_label: string; icon: string; title: string; job: string; made_by: string | null;
  price: string | null; value?: string; unit?: string; value_label?: string | null; runs: number | null; mine: boolean; published: boolean; badge?: { label: string; tone?: string };
  facts: Fact[]; picture?: string; preview?: MarketplacePreviewItem['preview']; action_input?: Record<string, unknown>; use_verb?: string;
  link?: { label: string; icon: string; url: string }; open_target: { surface: string; title: string; input: Record<string, string> } | null; can: string[];
  publish_terms?: { price_label: string; site_label: string };
};
type Filter = { id: string; label: string; choices: { id: string; label: string }[] };
type Kind = { id: string; label: string; one: string; icon: string; total: number; filters: Filter[] };
type Who = { id: string; label: string; icon: string };
type Verb = { label: string; icon: string; done: string; failed: string };
type Shelf = { items: Item[]; total: number; offset: number; limit: number; kinds: Kind[]; who: Who[]; verbs: Record<string, Verb>; unread?: { kind: string; label: string; error: string }[] };
type Query = { kind: string; who: string; q: string; where: Record<string, string> };

const API = '/work/api/marketplace';
const ALL = '';
const shelfAddress = (query: Query, offset = 0) => `${API}?${new URLSearchParams({ kind: query.kind, who: query.who, q: query.q, offset: String(offset), ...(Object.keys(query.where).length ? { where: JSON.stringify(query.where) } : {}) })}`;
// A Filter by row names its field and choice as JSON ([field, choice], or [field, null] for any), never as joined text.
const filterRow = (field: string, choice: string | null) => JSON.stringify([field, choice]);
// All-shelf filter keys carry the kind as well as the field: two kinds may use the same field id for different facts.
const filterKey = (kind: string, field: string) => JSON.stringify([kind, field]);
const scopedFilterRow = (kind: string, field: string, choice: string | null) => JSON.stringify([kind, field, choice]);
const queryKey = (query: Query) => JSON.stringify([query.kind, query.who, query.q, Object.entries(query.where).sort(([a], [b]) => a.localeCompare(b))]);
const seeOriginal = (item: Item) => { if (item.link) window.open(item.link.url, '_blank', 'noopener,noreferrer'); };
const change = (verb: string, item: Item, extra: Record<string, unknown> = {}) => readJson(`${API}/${verb}`, { method: 'POST', body: JSON.stringify({ kind: item.kind, id: item.id, ...extra }) });
const open = (item: Item) => {
  if (!item.open_target) return;
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: item.open_target.surface, title: item.open_target.title, surfaceInput: item.open_target.input } }));
};

const FIELDS: FieldDescriptor[] = [
  { id: 'title', label: 'Name', icon: 'Type', ruleKind: 'text', filterable: true, sortable: true, width: 240 },
  { id: 'kind_label', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 130 },
  { id: 'made_by', label: 'Made by', icon: 'UserRound', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170 },
  { id: 'job', label: 'What it does', icon: 'Target', ruleKind: 'text', filterable: true, width: 420 },
  { id: 'price', label: 'Price', icon: 'CircleDollarSign', ruleKind: 'text', sortable: true, width: 140, read: (item: Item) => item.price ?? '' },
  { id: 'runs', label: 'Runs', icon: 'History', ruleKind: 'number', sortable: true, width: 90, read: (item: Item) => (item.runs === null ? '' : String(item.runs)), sortValue: (item: Item) => item.runs ?? 0 },
];

const listingOf = (verbs: Record<string, Verb>) => (item: Item): Listing => ({
  id: item.key,
  title: item.title,
  byline: [item.made_by, item.kind_label].filter(Boolean).join(' · '),
  text: item.job,
  icon: item.icon,
  ...(item.badge ? { badge: item.badge } : {}),
  // What it costs stands alone on the right with its unit small; the rest are icon-led facts.
  ...(item.value ? { value: item.value, ...(item.unit ? { unit: item.unit } : {}), ...(item.value_label ? { valueLabel: item.value_label } : {}) } : {}),
  facts: item.facts,
  ...(item.picture ? { cover: { picture: item.picture } } : {}),
  // A card with its own buttons (its original on the web, or a verb its kind offers: publish or withdraw for the
  // person's own, wear for a look) is answered:
  // its buttons open it too. Any other card opens when pressed.
  ...(item.link || item.can.length || item.preview ? { actions: [
    ...(item.preview ? [{ id: 'preview', label: 'Preview', icon: 'Eye' }] : []),
    ...(item.open_target ? [{ id: 'open', label: 'Open', icon: 'ArrowUpRight' }] : []),
    ...(item.link ? [{ id: 'link', label: item.link.label, icon: item.link.icon }] : []),
    ...item.can.map(verb => ({ id: verb, label: verbs[verb]?.label ?? verb, icon: verbs[verb]?.icon })),
  ] } : {}),
});

function Marketplace({ first, start }: { first: Shelf; start: Query }) {
  const initialQuery = { ...start, who: start.who || first.who[0]?.id || '' };
  const [query, setQuery] = useState<Query>(initialQuery);
  const [shelf, setShelf] = useState(first);
  const [busy, setBusy] = useState(false);
  const currentQuery = useRef(initialQuery);
  const loadedQuery = useRef(initialQuery);
  const requestGeneration = useRef(0);
  const [view, setView] = useState('cards');
  const [host, setHost] = useState<{ node: HTMLElement; keys: string[] } | null>(null);
  const [pricing, setPricing] = useState<Item | null>(null);
  const [priceText, setPriceText] = useState('');
  const [showOnSite, setShowOnSite] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [preview, setPreview] = useState<Item | null>(null);

  const read = useCallback(async (next: Query, more = false) => {
    if (more && (queryKey(next) !== queryKey(currentQuery.current) || queryKey(next) !== queryKey(loadedQuery.current))) return;
    const generation = ++requestGeneration.current;
    const requestedQuery = { ...next, where: { ...next.where } };
    const address = shelfAddress(requestedQuery, more ? shelf.items.length : 0);
    setBusy(true);
    if (!more) {
      currentQuery.current = requestedQuery;
      setQuery(requestedQuery);
    }
    try {
      const page = await readJson<Shelf>(address);
      if (generation !== requestGeneration.current) return;
      if (more) {
        const key = queryKey(requestedQuery);
        if (key !== queryKey(currentQuery.current) || key !== queryKey(loadedQuery.current)) return;
        setShelf(current => ({ ...page, items: [...current.items, ...page.items] }));
      } else {
        loadedQuery.current = requestedQuery;
        setShelf(page);
      }
    } catch (error) {
      if (generation === requestGeneration.current) notify('The marketplace could not load', { kind: 'error', detail: reasonOf(error) });
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  }, [shelf.items.length]);

  const byKey = useMemo(() => new Map(shelf.items.map(item => [item.key, item])), [shelf.items]);
  const act = useCallback((item: Item, verb: string) => {
    if (verb === 'preview') { setPreview(item); return; }
    if (verb === 'open') { open(item); return; }
    if (verb === 'link') { seeOriginal(item); return; }
    if (verb === 'publish' && item.publish_terms) { setPricing(item); setPriceText(''); setShowOnSite(false); return; }
    const words = shelf.verbs[verb];
    change(verb, item, item.action_input ?? {})
      .then(() => { notify(`${item.title} ${words?.done ?? ''}`.trim(), { kind: 'success' }); void read(query); })
      .catch(error => notify(`${item.title} ${words?.failed ?? ''}`.trim(), { kind: 'error', detail: reasonOf(error) }));
  }, [query, read, shelf.verbs]);

  const publish = useCallback(async () => {
    if (!pricing) return;
    const amount = priceText.trim();
    if (amount && !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(amount)) { notify('Enter a dollar amount with up to four decimal places.', { kind: 'error' }); return; }
    const micros = amount ? Number(BigInt(amount.split('.')[0]) * 1000000n + BigInt((amount.split('.')[1] ?? '').padEnd(6, '0'))) : 0;
    if (amount && (!Number.isSafeInteger(micros) || micros <= 0)) { notify('Enter a price greater than zero.', { kind: 'error' }); return; }
    setPublishing(true);
    try {
      await change('publish', pricing, { ...(amount ? { usage_price: { amount_micros: micros, currency: 'usd' } } : {}), show_on_public_site: showOnSite });
      notify(`${pricing.title} is published for everyone`, { kind: 'success' });
      setPricing(null);
      await read(query);
    } catch (error) { notify(`${pricing.title} could not be published`, { kind: 'error', detail: reasonOf(error) }); }
    finally { setPublishing(false); }
  }, [pricing, priceText, showOnSite, read, query]);

  const mountCards = useCallback<NonNullable<RecordView['mount']>>((node, { records }) => {
    const keys = (records as Item[]).map(item => item.key);
    setHost(current => (current?.node === node && current.keys.join('\n') === keys.join('\n') ? current : { node, keys }));
    return () => setHost(current => (current?.node === node ? null : current));
  }, []);
  const views = useMemo<RecordView[]>(() => [{ id: 'cards', label: 'Cards', icon: 'LayoutGrid', mount: mountCards }, { id: 'table', label: 'Table', icon: 'Table' }], [mountCards]);
  // The words for opening an original are the owner's, read from the first item that has one.
  const linkWords = useMemo(() => shelf.items.find(item => item.link)?.link ?? null, [shelf.items]);
  const rowActions = useMemo<BulkAction[]>(() => [
    ...(linkWords ? [{
      id: 'link', label: linkWords.label, icon: linkWords.icon,
      appliesTo: (item: Item) => Boolean(item.link),
      run: (keys: string[]) => keys.forEach(key => { const item = byKey.get(key); if (item) seeOriginal(item); }),
    }] : []),
    ...Object.entries(shelf.verbs).map(([verb, words]) => ({
      id: verb, label: words.label, icon: words.icon,
      appliesTo: (item: Item) => item.can.includes(verb),
      run: (keys: string[]) => keys.forEach(key => { const item = byKey.get(key); if (item) act(item, verb); }),
    })),
  ], [act, byKey, linkWords, shelf.verbs]);
  // Filter identity includes kind on All: names and ids can repeat while their values mean different things.
  const filterKinds = query.kind === ALL ? shelf.kinds.filter(kind => kind.filters.length) : [];
  const filters = shelf.kinds.find(kind => kind.id === query.kind)?.filters ?? [];
  const chosen = Object.keys(query.where).length;
  const filterChoices = (kindId: string, field: Filter) => {
    const key = query.kind === ALL ? filterKey(kindId, field.id) : field.id;
    const row = (choice: string | null) => query.kind === ALL ? scopedFilterRow(kindId, field.id, choice) : filterRow(field.id, choice);
    return {
      id: row(null), label: field.label, icon: 'ListFilter', hint: field.choices.find(choice => choice.id === query.where[key])?.label,
      items: [
        { id: row(null), label: 'Any', icon: 'Asterisk', checked: !query.where[key] },
        ...field.choices.map(choice => ({ id: row(choice.id), label: choice.label, icon: 'Check', checked: query.where[key] === choice.id })),
      ],
    };
  };
  const filterItems = query.kind === ALL
    ? filterKinds.map(kind => ({ id: `kind:${kind.id}`, label: kind.label, icon: kind.icon, items: kind.filters.map(field => filterChoices(kind.id, field)) }))
    : filters.map(field => filterChoices(query.kind, field));
  const filterMenu = filterItems.length ? {
    label: 'Filter by', icon: 'SlidersHorizontal', ...(chosen ? { badge: chosen } : {}),
    items: filterItems,
    onAction: (row: string) => {
      if (query.kind === ALL) {
        const [kind, field, choice] = JSON.parse(row) as [string, string, string | null];
        const key = filterKey(kind, field);
        const rest = Object.fromEntries(Object.entries(query.where).filter(([current]) => current !== key));
        void read({ ...query, where: choice === null ? rest : { ...rest, [key]: choice } });
      } else {
        const [field, choice] = JSON.parse(row) as [string, string | null];
        const rest = Object.fromEntries(Object.entries(query.where).filter(([key]) => key !== field));
        void read({ ...query, where: choice === null ? rest : { ...rest, [field]: choice } });
      }
    },
  } : undefined;
  const shown = host ? host.keys.map(key => byKey.get(key)).filter((item): item is Item => Boolean(item)) : [];
  const allCount = shelf.kinds.reduce((sum, kind) => sum + kind.total, 0);

  return (
    <Container layout="vertical" height="full" gap="none" minHeight="0">
      <Container layout="horizontal" padding="sm" gap="sm" alignItems="center" justifyContent="between" wrap>
        <ExpandableTabs
          ariaLabel="Kinds"
          value={query.kind}
          onChange={kind => void read({ ...query, kind, where: {} })}
          items={[{ id: ALL, label: 'All', icon: 'LayoutGrid', badge: allCount, pinned: true }, ...shelf.kinds.map(kind => ({ id: kind.id, label: kind.label, icon: kind.icon, badge: kind.total, pinned: true }))]}
        />
        <ExpandableTabs
          ariaLabel="Whose"
          value={query.who}
          onChange={who => void read({ ...query, who })}
          items={shelf.who.map(who => ({ id: who.id, label: who.label, icon: who.icon, pinned: true }))}
        />
      </Container>
      <Container layout="vertical" flex={1} minHeight="0">
        {pricing ? (
          <Container layout="vertical" padding="sm" gap="sm" border="bottom" data-marketplace-publish="">
            <Text variant="body-sm">{`Publish ${pricing.title}`}</Text>
            <Input label={pricing.publish_terms?.price_label ?? 'Price for each completed run (USD)'} placeholder="Free" value={priceText} onChange={event => setPriceText(event.target.value)} />
            <Switch label={pricing.publish_terms?.site_label ?? 'Show on public website'} checked={showOnSite} onCheckedChange={setShowOnSite} />
            <Container layout="horizontal" gap="sm">
              <Button size="sm" variant="primary" disabled={publishing} onClick={() => publish()}>{publishing ? 'Publishing' : 'Publish'}</Button>
              <Button size="sm" variant="ghost" disabled={publishing} onClick={() => setPricing(null)}>Cancel</Button>
            </Container>
          </Container>
        ) : null}
        {preview ? (
          <MarketplacePreview
            item={preview}
            actionLabel={preview.use_verb && preview.can.includes(preview.use_verb) ? shelf.verbs[preview.use_verb]?.label : undefined}
            onAction={preview.use_verb && preview.can.includes(preview.use_verb) ? () => act(preview, preview.use_verb!) : undefined}
            onBack={() => setPreview(null)}
          />
        ) : null}
        <RecordViews
          label="Marketplace"
          fields={FIELDS}
          records={shelf.items}
          total={shelf.total}
          identify={(item: Item) => item.key}
          views={views}
          view={view}
          onViewChange={setView}
          search={{ value: query.q, placeholder: 'Search the marketplace', onCommit: q => void read({ ...query, q }) }}
          onOpen={key => { const item = byKey.get(key); if (item?.preview) setPreview(item); else if (item) open(item); }}
          rowActions={rowActions}
          moreActions={filterMenu}
          {...recordFilter}
          preferenceKey="trillion-marketplace"
          emptyMessage={query.q ? 'Nothing here matches.' : 'Nothing here yet.'}
        />
        {shelf.items.length < shelf.total ? (
          <Container layout="horizontal" padding="sm" justifyContent="center">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => read(query, true)}>
              {`Show more (${shelf.total - shelf.items.length} left)`}
            </Button>
          </Container>
        ) : null}
      </Container>
      {host ? createPortal(
        <ListingGrid label="Marketplace" listings={shown.map(listingOf(shelf.verbs))} onOpen={key => { const item = byKey.get(key); if (item?.preview) setPreview(item); else if (item) open(item); }} onAction={(key, verb) => { const item = byKey.get(key); if (item) act(item, verb); }} className="p-3" />,
        host.node,
      ) : null}
    </Container>
  );
}

// A tab may open the Marketplace on one kind and on yours or everyone's (surface input `kind` and `who`, ids the
// Worker's answer lists), as Automations does for workflows other people published.
const startOf = (input: Record<string, unknown> | undefined): Query => ({
  kind: typeof input?.kind === 'string' ? input.kind : ALL, who: typeof input?.who === 'string' ? input.who : '', q: '', where: {},
});

export function mountMarketplaceScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): () => void {
  const start = startOf(props.surfaceInput);
  const host = document.createElement('div');
  host.className = 'trillion-marketplace';
  element.replaceChildren(host);
  const screen = loadScreen(host, {
    loading: { label: 'Loading the marketplace', layout: 'gallery' },
    read: () => readJson<Shelf>(start.kind || start.who ? shelfAddress(start) : API),
    empty: shelf => (shelf.kinds.some(kind => kind.total > 0) ? null : {
      status: 'empty', icon: 'Store', title: 'Nothing in the marketplace yet',
      description: 'Ask your AI to find or build a tool or a workflow and publish it. Everything people publish shows here.',
      ask: askFor('marketplace'),
    }),
    failed: refusal('The marketplace could not load'),
    draw: shelf => mountSharedContent(host, <Marketplace first={shelf} start={start} />),
  });
  return () => { screen.dispose(); element.replaceChildren(); };
}
