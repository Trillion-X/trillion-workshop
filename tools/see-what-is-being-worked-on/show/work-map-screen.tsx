// parts/work-map/show/work-map-screen.tsx
//
// PURPOSE
//   The work map: everything being worked on, by every AI and every person, as one tree, the way an org chart shows
//   teams, sub-teams and seats. Goals hold the goals under them, the decisions made for them and the jobs those
//   decisions started; a job hangs under the job it is part of; work under no goal hangs under the AI doing it; each
//   space holds its people. Each card leads with who is doing it (a person's face, an AI's app), takes its colour from
//   its state, moves while someone works on it, and shows how much of the work under it is done. Above the map, the
//   same work at a glance: what needs you, what is moving, what finished lately. Tapping a card opens it. The same
//   records also read as a board by state, a table and a timeline.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A view, never a store: every card is a row the person's own reads answered (read-data/work-map-sources.json
//      names the reads), joined by read-data/join-records.mjs; nothing is copied or kept, and it is read again when the
//      person's store changes (/work/live).
//   2. States are DATA: each state's words, tone, motion and whether it counts as done come from the one shared
//      work-state looks (parts/screen-look/show/work-state-looks.json); a new state is one row there.
//   3. Progress is never guessed: a card's done count is the settled states under it, worked out by the shared roll-up
//      (parts/ui/show/node-graph/roll-up.ts, read by the Draw design's records-on-a-board.ts); a card with no stated work
//      under it shows none.
//   4. Every element is a shared component (record views, status overview, person tags, provider marks, screen
//      states); this file writes no markup.
//   5. One export, `mount(element, { surfaceInput })`, returning how to take the screen down: the module kind's contract.
//   6. Starting from one goal is a view of the same tree (read-data/join-records.mjs branchOf): the goal and everything
//      under it, with the glance above saying where to go now (what needs the person first, then what is moving).
//      Which kinds can be started from is DATA (`start_from` on a source); `{ goal: <id> }` opens the map there.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React, { useMemo, useState } from 'react';
import { ProviderMark, providerIconRegistry, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../../ui';
import { RecordViews, type FieldDescriptor, type FieldMark, type RecordView } from '../../ui/show/record-views/record-views';
import { PersonTag } from '../../ui/show/person-tag/PersonTag';
import { StatusOverview, type StatusLooks } from '../../ui/show/status-overview/StatusOverview';
import { mountSharedContent } from '../../ui/show/coss/shared-content';
import { loadScreen } from '../../ui/show/screen-state';
import workLooks from '../../screen-look/show/work-state-looks.json';
import { branchOf, joinRecords, valueAt } from '../read-data/join-records.mjs';
import settings from '../read-data/work-map-sources.json';
import providerNames from '#workspace/activity-providers.json';
import { readJson } from '#workspace/api.ts';
import { refusal } from '#workspace/failure.ts';
import { openScreen, openScreenOn } from '#workspace/open-screen.ts';
import { recordFilter } from '#workspace/record-filter.ts';
import { AI_WORK, onStoreChange } from '#workspace/store-changes.ts';

type Source = { id: string; icon?: string; start_from?: boolean; opens?: { surface: string; input?: Record<string, string[]> } };
type Node = { id: string; source: string; kind: string; icon?: string; title: string; detail: string; at?: string; status?: string; who?: string; root?: boolean; row?: Record<string, unknown> };
type Line = { id: string; from: string; to: string };
type Apps = Record<string, { picture: string | null; site: string | null }>;
type Answers = Record<string, unknown> & { work?: { apps?: Apps } };

const LOOKS = workLooks as StatusLooks & { states: Record<string, { label: string; tone?: string; working?: boolean; settled?: boolean }> };
const SOURCES = settings.sources as Source[];
const sourceOf = new Map(SOURCES.map(source => [source.id, source]));
/** Each state's words, tone, motion and whether it counts as done, as the shared looks say. */
const STATES = Object.fromEntries(Object.entries(LOOKS.states).map(([id, look]) => [id, { label: look.label, tone: look.tone ?? 'grey', working: look.working, settled: look.settled }]));
const VIEWS: RecordView[] = [
  // The one canvas, Draw (the record views' designed row `canvas`): the tree's cards and lines on the board.
  { id: 'canvas', label: 'Draw', icon: 'PenTool' },
  { id: 'board', label: 'Board', icon: 'Kanban' },
  { id: 'table', label: 'Table', icon: 'Table' },
  { id: 'changelog', label: 'Timeline', icon: 'History' },
];

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** A face for whoever a card is: a person's own, an AI's app mark, else the kind's icon. */
function markOf(node: Node, byId: Map<string, Node>, apps: Apps): FieldMark | undefined {
  const app = (one: Node) => (one.row && typeof one.row.app === 'string' ? one.row.app : null);
  const face = (one: Node) => {
    const provider = app(one) ? (providerNames.names as Record<string, string>)[app(one)!] : undefined;
    return provider ? <ProviderMark providerSlug={provider} providerName={app(one)!} registry={providerIconRegistry} size="sm" decorative />
      : <PersonTag name={one.title} picture={app(one) ? apps[app(one)!]?.picture ?? null : null} size="sm" />;
  };
  const doer = node.who ? byId.get(node.who) : undefined;
  if (doer) return face(doer);
  if (node.source === 'ai' || node.source === 'person') return face(node);
  return node.icon ? { icon: node.icon, label: node.kind } : undefined;
}

function fieldsOf(byId: Map<string, Node>, apps: Apps): FieldDescriptor[] {
  const kinds = Object.fromEntries([...new Set([...byId.values()].map(node => node.kind))].map(kind => [kind, { label: kind }]));
  return [
    { id: 'title', label: 'What', icon: 'Target', ruleKind: 'text', filterable: true, sortable: true, width: 380, preview: 'heading', mark: (node: Node) => markOf(node, byId, apps) },
    { id: 'status', label: 'Where it is', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 190, values: STATES },
    { id: 'kind', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 140, values: kinds },
    { id: 'who', label: 'Who', icon: 'Users', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, read: (node: Node) => (node.who ? byId.get(node.who)?.title ?? '' : '') },
    { id: 'detail', label: 'Now', icon: 'MessageSquare', ruleKind: 'text', filterable: true, width: 320, preview: true },
    { id: 'at', label: 'When', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 180,
      read: (node: Node) => when(node.at), sortValue: (node: Node) => (node.at ? Date.parse(node.at) : 0) },
  ];
}

/** Opens a card on the screen its source names, given the fields that screen takes. */
function open(node: Node | undefined) {
  const opens = node ? sourceOf.get(node.source)?.opens : undefined;
  if (!node || !opens) return;
  const input = Object.fromEntries(Object.entries(opens.input ?? {}).map(([key, path]) => [key, valueAt(node.row ?? {}, path)[0]]).filter(([, value]) => value !== undefined));
  if (Object.keys(input).length) openScreenOn(opens.surface, input, node.title);
  else openScreen(opens.surface);
}

const EVERYTHING = 'everything';

function WorkMap({ tree, apps, start }: { tree: { nodes: Node[]; lines: Line[] }; apps: Apps; start: string | null }) {
  const [view, setView] = useState('canvas');
  // Where the map starts: everything, or one goal (any row of a start_from source) with only what it holds, so a person
  // can begin from the goal they care about and find their way down to what needs them.
  const starts = useMemo(() => tree.nodes.filter(node => sourceOf.get(node.source)?.start_from), [tree]);
  const [from, setFrom] = useState(start && starts.some(node => node.id === start) ? start : EVERYTHING);
  const { nodes, lines } = useMemo(() => (from === EVERYTHING ? tree : branchOf(tree, from)), [tree, from]);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const fields = useMemo(() => fieldsOf(byId, apps), [byId, apps]);
  const glance = useMemo(() => nodes.filter(node => node.status).map(node => ({ id: node.id, title: node.title, status: node.status!, detail: node.detail || undefined, since: node.at || null })), [nodes]);
  return (
    <Container layout="vertical" height="full" gap="none" minHeight="0">
      {starts.length > 0 && (
        <Container layout="horizontal" padding="sm" minWidth="0">
          <Select value={from} onValueChange={value => setFrom(typeof value === 'string' ? value : EVERYTHING)}>
            <SelectTrigger aria-label="Start from"><SelectValue>{from === EVERYTHING ? 'Everything' : byId.get(from)?.title ?? 'Everything'}</SelectValue></SelectTrigger>
            <SelectPopup>
              <SelectItem value={EVERYTHING}>Everything</SelectItem>
              {starts.map(node => <SelectItem key={node.id} value={node.id}>{node.title}</SelectItem>)}
            </SelectPopup>
          </Select>
        </Container>
      )}
      {glance.length > 0 && <Container layout="vertical" padding="sm"><StatusOverview label={from === EVERYTHING ? 'All the work at a glance' : 'Where to go now'} looks={LOOKS} records={glance} /></Container>}
      <Container layout="vertical" flex={1} minHeight="0">
        <RecordViews
          label="Work map"
          fields={fields}
          records={nodes}
          identify={(node: Node) => node.id}
          views={VIEWS}
          view={view}
          onViewChange={setView}
          links={() => lines}
          statusField="status"
          onOpen={id => open(byId.get(id))}
          preferenceKey="trillion-work-map"
          {...recordFilter}
          emptyMessage="Nothing matches."
        />
      </Container>
    </Container>
  );
}

/** The card a map opened with `{ goal: <id> }` (or `{ from: <card id> }`) starts from. */
function startOf(input: Record<string, unknown> = {}): string | null {
  if (typeof input.from === 'string') return input.from;
  const source = SOURCES.find(one => one.start_from);
  return source && typeof input.goal === 'string' ? `${source.id}:${input.goal}` : null;
}

export function mount(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const host = document.createElement('div');
  host.className = 'trillion-work-map';
  element.replaceChildren(host);
  const reads = Object.entries(settings.reads as Record<string, string>);
  const screen = loadScreen(host, {
    loading: { label: 'Loading everything being worked on', layout: 'rows' },
    // Each read stands alone: one that fails leaves its branch out, and the rest still draw.
    read: async () => {
      const answers = Object.fromEntries(await Promise.all(reads.map(async ([id, url]) => [id, await readJson<unknown>(url).catch(() => null)] as const))) as Answers;
      if (reads.every(([id]) => answers[id] === null)) throw new Error('Nothing could be read.');
      return answers;
    },
    empty: answers => (joinRecords({ root: settings.root, sources: SOURCES, answers }).nodes.length > 1 ? null : {
      status: 'empty', icon: 'Network', title: 'Nothing is being worked on yet',
      description: 'When you set a goal, decide something or hand work to an AI or a person, it shows here, joined to what it is part of.',
      action: { label: 'Connect an AI', run: () => openScreen('trillion.ai') },
    }),
    failed: refusal('Your work map could not load'),
    draw: answers => {
      const { nodes, lines } = joinRecords({ root: settings.root, sources: SOURCES, answers });
      mountSharedContent(host, <WorkMap tree={{ nodes: nodes as Node[], lines }} apps={answers.work?.apps ?? {}} start={startOf(props.surfaceInput)} />);
    },
  });
  const stopListening = onStoreChange(() => screen.reload(), AI_WORK);
  return () => { stopListening(); screen.dispose(); element.replaceChildren(); };
}
