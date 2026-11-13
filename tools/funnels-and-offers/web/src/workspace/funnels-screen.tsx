// src/workspace/funnels-screen.tsx
//
// PURPOSE
//   Funnels: every funnel this person keeps in their files (the Funnels folder, one JSON file per funnel), in the
//   shared record views with its stages, how many entered and how many came out the end; opening one draws it in its
//   own tab as the shared funnel canvas (parts/funnel-offer-graph FunnelCanvas) with live conversion per stage, read
//   from the facts the funnel names (inline, or a file of records such as visits, leads, sales or customer steps).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the person's own files; no funnel yet says so, and offers the words to give their AI to make one.
//   2. A funnel file is DATA read by the shared resolver (funnelStages); nothing here names a stage or a field.
//   3. Every element is a shared component; this file writes no markup.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen, mountScreenState, ScreenState, useScreenLoad, type EmptyScreenState } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { Button, Container, Text } from '../../parts/ui';
import { FunnelCanvas } from '../../parts/funnel-offer-graph/show/FunnelCanvas';
import { type Funnel } from '../../parts/funnel-offer-graph/read-data/stage-projection';
import { FUNNELS_FOLDER as FOLDER, loadFunnel as loadFunnelFrom } from '../funnel-read.mjs';
import { bodyOf, readFileText, readJson, readListing } from './api';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { goTo } from './open-screen';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Listed = { name: string; identity: string | null };
type Listing = { names: Listed[]; next_after: string | null };
type Loaded = { path: string; funnel: Funnel | null; problem?: string };

// The readers the shared funnel read (src/funnel-read.mjs) is handed here: the person's files, their commercial events
// that name the graph's id, their price experiments, and the counted visits and clicks a funnel's interaction rows ask
// for, each through the same /work routes as every other screen.
const readers = {
  bytes: async (name: string): Promise<string | null> => {
    try { return await readFileText(name); } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  },
  events: async (funnelId: string) => (await readJson<{ events?: unknown[] }>(`/work/api/commercial-events?funnel_id=${encodeURIComponent(funnelId)}`)).events ?? [],
  experiments: async () => (await readJson<{ experiments?: unknown[] }>('/work/api/price-experiments')).experiments ?? [],
  interactions: async (rows: unknown[], stageField: string) => {
    const response = await fetch('/work/api/interactions/funnel-facts', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows, stage_field: stageField }),
    });
    if (!response.ok) throw new Error(`The visit counts could not be read (${response.status}).`);
    return ((await bodyOf(response, answer => answer.json())) as { facts?: unknown[] }).facts ?? [];
  },
};

/** One funnel file, with the facts it names, as the stages the canvas draws. */
async function loadFunnel(path: string): Promise<Loaded> {
  try {
    return await loadFunnelFrom(path, readers) as Loaded;
  } catch (error) {
    // Trillion not answering is the screen's failure, not this file's problem.
    if (error instanceof TypeError || ((error as { status?: number }).status ?? 0) >= 500) throw error;
    return { path, funnel: null, problem: errorWords(error) };
  }
}

const openFunnel = (path: string, title: string) => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.funnel', title, surfaceInput: { id: path } } }));

type Row = { id: string; name: string; stages: number; entered: number; finished: number; rate: string; problem: string };
const FIELDS: FieldDescriptor[] = [
  { id: 'name', label: 'Funnel', icon: 'Filter', ruleKind: 'text', filterable: true, sortable: true, width: 300 },
  { id: 'stages', label: 'Stages', icon: 'Layers', kind: 'number', ruleKind: 'number', sortable: true, width: 110 },
  { id: 'entered', label: 'Entered', icon: 'LogIn', kind: 'number', ruleKind: 'number', sortable: true, width: 120 },
  { id: 'finished', label: 'Reached the end', icon: 'Flag', kind: 'number', ruleKind: 'number', sortable: true, width: 160 },
  { id: 'rate', label: 'End to end', icon: 'Percent', ruleKind: 'text', width: 130 },
  { id: 'problem', label: 'Needs fixing', icon: 'TriangleAlert', ruleKind: 'text', width: 320 },
];

const queueFunnel = async () => {
  const response = await fetch('/work/api/queue', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', origin: location.origin },
    body: JSON.stringify({ job_id: 'make-funnel', label: 'Ask my AI to make this funnel', context: { name: 'my-funnel' }, press_key: `funnels-${Date.now()}` }),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error ?? 'Your AI could not be reached.');
  notify(answer.said ?? 'Sent to your AI.', { kind: 'done' });
};

const NO_FUNNEL: EmptyScreenState = {
  status: 'empty', icon: 'Filter', title: 'No funnel yet',
  description: `Trillion can ask your linked AI to lay out a funnel in your ${FOLDER.slice(1)} folder, using your real offers and records.`,
  action: { label: 'Ask my AI to make this funnel', run: () => void queueFunnel().catch(error => notify(errorWords(error), { kind: 'error' })) },
};

// The funnel files, each read with its facts; a person with no Funnels folder yet has no funnels.
async function readFunnels(): Promise<Loaded[]> {
  let listing: Listing;
  try { listing = await readListing<Listing>(FOLDER, { limit: 200 }); } catch (error) {
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
  return Promise.all(listing.names.filter(item => item.name.endsWith('.json')).map(item => loadFunnel(item.name)));
}

export function mountFunnelsScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  const list = document.createElement('div');
  list.className = 'trillion-decisions';
  element.replaceChildren(list);
  const screen = loadScreen(list, {
    loading: { label: 'Loading your funnels', layout: 'rows' },
    read: readFunnels,
    empty: loaded => (loaded.length ? null : NO_FUNNEL),
    failed: refusal('Your funnels could not load'),
    clear: () => { views?.destroy(); views = null; },
    draw: loaded => {
      const rows: Row[] = loaded.map(({ path, funnel, problem }) => {
        const first = funnel?.stages[0]?.measures.visits ?? 0;
        const last = funnel?.stages.at(-1)?.measures.conversions ?? 0;
        return { id: path, name: funnel?.title ?? path.split('/').pop()!, stages: funnel?.stages.length ?? 0, entered: first, finished: last, rate: first ? `${Math.round((last / first) * 1000) / 10}%` : '', problem: problem ?? '' };
      });
      const options = {
        label: 'Funnels', fields: FIELDS, records: rows, identify: (row: Row) => row.id, preferenceKey: 'trillion-funnels',
        ...recordFilter,
        views: [{ id: 'table', label: 'Table' }], view: 'table',
        onOpen: (id: string) => openFunnel(id, rows.find(row => row.id === id)?.name ?? 'Funnel'),
        emptyMessage: 'Nothing matches.',
      };
      if (views) views.update(options); else views = mountRecordViews(list, options);
    },
  });
  return () => { screen.dispose(); element.replaceChildren(); };
}

function OneFunnel({ path }: { path: string }) {
  // A funnel file that cannot be drawn fails as the shared failed state, in the resolver's own words.
  const loaded = useScreenLoad(path, {
    loading: { label: 'Loading the funnel', layout: 'preview' },
    read: async () => { const one = await loadFunnel(path); if (!one.funnel) throw new Error(one.problem); return one; },
    failed: refusal('This funnel could not be drawn'),
  });
  const read = loaded.reload;
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const funnel = loaded.value.funnel!;
  return (
    <Container layout="vertical" height="full" gap="none" minHeight="0" data-funnel={funnel.id}>
      <Container layout="horizontal" gap="md" padding="md" alignItems="center" justifyContent="between">
        <Container layout="vertical" gap="xs" flex={1} style={{ minWidth: 0 }}>
          <Text variant="heading-xs" truncate>{funnel.title}</Text>
          <Text variant="caption" truncate>{funnel.measured ? `${funnel.stages.length} stages, measured from your records` : `${funnel.stages.length} stages, no visits counted yet`}</Text>
        </Container>
        <Button size="sm" variant="ghost" onClick={() => read()}>Read again</Button>
      </Container>
      <Container layout="vertical" flex={1} minHeight="0">
        <FunnelCanvas funnel={funnel} />
      </Container>
    </Container>
  );
}

export function mountFunnelScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const path = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : '';
  if (!path) { mountScreenState(element, { status: 'empty', icon: 'Filter', title: 'No funnel was named', description: 'Open a funnel from Funnels.', action: goTo('Open Funnels', 'trillion.funnels') }); return () => element.replaceChildren(); }
  const host = document.createElement('div');
  host.className = 'trillion-funnels';
  // The loading state the tool host draws here gives the element the shared control scope; a funnel is drawn without it, as it was before it moved.
  element.classList.remove('coss-ui');
  element.replaceChildren(host);
  const root = createRoot(host);
  root.render(<OneFunnel path={path} />);
  return () => { root.unmount(); element.replaceChildren(); };
}
