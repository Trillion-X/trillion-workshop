// src/workspace/ai-work-screen.tsx
//
// PURPOSE
//   AI work: who handed what to which AI, what is waiting, what is being worked on now and by whom, and what is done
//   with what came of it; and every AI the person connected, with what it runs in, its model, whether it can take more
//   work, what it is working on now and what is waiting for it. Two tabs over the shared record views: Work (a board
//   by where each job is, a table, and the same jobs grouped by the AI doing them) and Your AIs. Each AI is marked with
//   its app's own picture, the way the AI activity screen marks it. The Work tab opens with one glance at the work (what
//   is stuck, what is moving, what finished lately) and draws the jobs as a tree too: a job an AI passed part of on sits
//   above the parts, the way the Mac app's Work screen showed its work tree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every job and AI is one the person's store answered (/work/api/ai-work, src/agents.mjs board);
//      having none is said plainly.
//   2. Show older reaches every job still open, then older finished work, in bounded pages without duplicates.
//   3. Fields are DATA (workFields, aiFields, CAN_TAKE below) and the words, tone and overview section of each place a
//      job can be come from the one shared work-state looks (parts/screen-look/show/work-state-looks.json); a new
//      column or state is one row, never drawing code. No app, AI or job is named here.
//   4. Every element is a shared component (record views, tabs, provider marks, person tags, screen states); this
//      file writes no markup.

import React, { useMemo, useState } from 'react';
import { RecordViews, type FieldDescriptor, type FieldMark, type RecordView } from '../../parts/ui/show/record-views/record-views';
import type { GroupLevel } from '../../parts/ui/show/record-views/group-sections';
import { ExpandableTabs } from '../../parts/ui/show/expandable-tabs';
import { Button, Container, ProviderMark, providerIconRegistry } from '../../parts/ui';
import { PersonTag } from '../../parts/ui/show/person-tag/PersonTag';
import { StatusOverview, type StatusLooks } from '../../parts/ui/show/status-overview/StatusOverview';
import workLooks from '../../parts/screen-look/show/work-state-looks.json';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { loadScreen } from '../../parts/ui/show/screen-state';
import providerNames from './activity-providers.json';
import type { AppMarks } from '../../../../see-what-my-ais-did/web/src/workspace/activity-screen';
import { recordFilter } from './record-filter';
import { readJson } from './api';
import { titleOf } from '../work-title.mjs';
import { refusal } from './failure';
import { openScreen, openScreenOn } from './open-screen';
import { AI_WORK, onStoreChange } from './store-changes';

type Job = {
  handoff_id: string; state: string; status: string; in_the_way: string | null; in_the_way_by: string | null; in_the_way_at: string | null; job: string; said: string | null; to_agent: string | null; from_agent: string | null; asked_by_app: string | null;
  case_id: string | null; parent_handoff_id: string | null; handed_on: string[]; depends_on?: string[]; handed_at: string; taken_by: string | null;
  taken_at: string | null; hold_until: string | null; finished_at: string | null; summary: string | null; progress?: string;
};
type Load = { status: string; max_concurrent: number | null; in_progress: number; available_slots: number };
type AI = {
  agent_id: string; name: string; description: string; harness: string | null; model: string | null; app: string | null;
  takes_work: boolean; finished: number; last_seen_at: string | null; capacity: Load; waiting_for_it: number;
};
type Page = { work: Job[]; agents: AI[]; next_before: string | null; apps: AppMarks };

const API = '/work/api/ai-work';
const ANY_AI = 'Any of your AIs';
const ANY_AI_IN_A_SENTENCE = 'any of your AIs';
const SOMEONE = 'Someone';
/** The mark of work any of the person's AIs may take. */
const EVERY_AI: FieldMark = { icon: 'Users', label: ANY_AI };
const LOOKS = workLooks as StatusLooks;
/** Where a job can be, in the order the board shows its columns: the shared work-state looks. */
const WHERE = Object.fromEntries(Object.entries(LOOKS.states).map(([id, look]) => [id, { label: look.label, tone: look.tone ?? 'grey', working: look.working }]));
/** Whether an AI can take more work, as its own last report says. */
const CAN_TAKE: Record<string, { label: string; tone: string }> = {
  available: { label: 'Free to take work', tone: 'success' },
  full: { label: 'Busy', tone: 'warning' },
  stale: { label: 'Not heard from lately', tone: 'neutral' },
  paused: { label: 'Not taking work', tone: 'neutral' },
  unknown: { label: 'Has not said', tone: 'neutral' },
};
/** The ways to look at the work, and what each groups by. */
const WORK_VIEWS: (RecordView & { groups: GroupLevel[] })[] = [
  { id: 'board', label: 'Board', icon: 'Kanban', groups: [{ field: 'where' }] },
  { id: 'table', label: 'Table', icon: 'Table', groups: [] },
  { id: 'gallery', label: 'By AI', icon: 'Bot', groups: [{ field: 'doer' }] },
  { id: 'canvas', label: 'Draw', icon: 'PenTool', groups: [] },
];
/** What a job is, as the person sees it: its short title (src/work-title.mjs); the whole job opens behind it. */
const whatOf = (job: Job) => titleOf(job);

// How jobs connect on the board (Draw): a bigger job to its parts, and each job a job waits for to the job waiting on
// it, so the board draws the work's dependency graph, each job a card with its state live.
const partLines = (jobs: Job[]) => [
  ...jobs.filter(job => job.parent_handoff_id).map(job => ({ from: job.parent_handoff_id!, to: job.handoff_id })),
  ...jobs.flatMap(job => (job.depends_on ?? []).map(waitedFor => ({ from: waitedFor, to: job.handoff_id }))),
];

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

/** An AI's picture: its app's provider mark when known, else the app's own picture, else its initials. */
function pictureOf(name: string, app: string | null, apps: AppMarks): FieldMark {
  const provider = app ? (providerNames.names as Record<string, string>)[app] : undefined;
  return provider ? <ProviderMark providerSlug={provider} providerName={app!} registry={providerIconRegistry} size="sm" decorative />
    : <PersonTag name={name} picture={app ? apps[app]?.picture : null} size="sm" />;
}

/** The fields a job is shown with; `ais` names each AI by id and `jobs` names the jobs a job links to. */
function workFields(ais: Map<string, AI>, jobs: Map<string, Job>, apps: AppMarks): FieldDescriptor[] {
  const nameOf = (id: string | null) => (id ? ais.get(id)?.name ?? id : null);
  const appOf = (id: string | null) => (id ? ais.get(id)?.app ?? null : null);
  // An AI the person has is named as itself; else the app that asked (Trillion for its own asks), never a bare agent id first.
  const asker = (job: Job) => (job.from_agent ? ais.get(job.from_agent)?.name : undefined) ?? job.asked_by_app ?? job.from_agent ?? SOMEONE;
  const doerId = (job: Job) => job.taken_by ?? job.to_agent;
  const doer = (job: Job) => nameOf(doerId(job)) ?? ANY_AI;
  const jobOf = (id: string) => { const job = jobs.get(id); return job ? whatOf(job) : id; };
  // Every job named by the job it is part of, so grouping by it nests the parts inside the jobs they belong to.
  const bigger = Object.fromEntries([...jobs.values()].map(job => [job.handoff_id, { label: whatOf(job), ...(job.parent_handoff_id ? { parent: job.parent_handoff_id } : {}) }]));
  return [
    // The job's own picture is the AI doing it, so every card and row shows at a glance whose it is.
    { id: 'job', label: 'What', icon: 'Target', ruleKind: 'text', filterable: true, sortable: true, width: 380, preview: 'heading', read: whatOf,
      mark: (job: Job) => (doerId(job) ? pictureOf(doer(job), appOf(doerId(job)), apps) : EVERY_AI) },
    { id: 'who', label: 'Who asked whom', icon: 'Users', ruleKind: 'text', filterable: true, width: 300, read: (job: Job) => `${asker(job)} asked ${doerId(job) ? doer(job) : ANY_AI_IN_A_SENTENCE}` },
    { id: 'progress', label: 'Progress', icon: 'CirclePercent', ruleKind: 'text', filterable: true, width: 220, read: (job: Job) => job.progress ?? 'Not measured' },
    { id: 'summary', label: 'What came of it', icon: 'MessageSquare', ruleKind: 'text', filterable: true, width: 320, preview: true, read: (job: Job) => job.summary ?? '' },
    { id: 'handed_at', label: 'Asked', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, groupable: true, sortable: true, width: 180,
      read: (job: Job) => when(job.handed_at), factValue: (job: Job) => time(job.handed_at), sortValue: (job: Job) => time(job.handed_at) },
    { id: 'where', label: 'Where it is', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 190, values: WHERE, read: (job: Job) => job.status },
    { id: 'in_the_way', label: 'What is in the way', icon: 'TriangleAlert', ruleKind: 'text', filterable: true, width: 320, preview: true,
      read: (job: Job) => (job.status === 'blocked' && job.in_the_way ? `${nameOf(job.in_the_way_by) ?? SOMEONE}: ${job.in_the_way}` : '') },
    { id: 'asker', label: 'Who asked', icon: 'UserRound', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, hiddenByDefault: true, read: asker,
      mark: (job: Job) => pictureOf(asker(job), appOf(job.from_agent) ?? job.asked_by_app, apps) },
    { id: 'doer', label: 'Who is doing it', icon: 'Bot', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, hiddenByDefault: true, read: doer,
      mark: (job: Job) => (doerId(job) ? pictureOf(doer(job), appOf(doerId(job)), apps) : EVERY_AI) },
    { id: 'hold_until', label: 'Holding it until', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', sortable: true, width: 180, hiddenByDefault: true,
      read: (job: Job) => (job.state === 'taken' ? when(job.hold_until) : ''), sortValue: (job: Job) => time(job.hold_until) },
    { id: 'finished_at', label: 'Done at', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', sortable: true, width: 180, hiddenByDefault: true,
      read: (job: Job) => when(job.finished_at), sortValue: (job: Job) => time(job.finished_at) },
    { id: 'part_of', label: 'Bigger job', icon: 'GitBranch', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 260, values: bigger, read: (job: Job) => job.parent_handoff_id ?? '' },
    { id: 'passed_on', label: 'Passed on to', icon: 'Link', ruleKind: 'text', filterable: true, width: 260, read: (job: Job) => job.handed_on.map(jobOf).join(', ') },
    { id: 'waits_for', label: 'Waits for', icon: 'Hourglass', ruleKind: 'text', filterable: true, width: 260, hiddenByDefault: true, read: (job: Job) => (job.depends_on ?? []).map(jobOf).join(', ') },
  ];
}

/** The fields an AI is shown with. */
const aiFields = (apps: AppMarks): FieldDescriptor[] => [
  { id: 'name', label: 'AI', icon: 'Bot', ruleKind: 'text', filterable: true, sortable: true, width: 240, mark: (ai: AI) => pictureOf(ai.name, ai.app, apps) },
  { id: 'can_take', label: 'Can it take more', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, values: CAN_TAKE, read: (ai: AI) => ai.capacity.status },
  { id: 'in_progress', label: 'Working on now', icon: 'Activity', ruleKind: 'number', filterable: true, sortable: true, width: 150, read: (ai: AI) => ai.capacity.in_progress },
  { id: 'waiting_for_it', label: 'Waiting for it', icon: 'CalendarClock', ruleKind: 'number', filterable: true, sortable: true, width: 140 },
  { id: 'finished', label: 'Done', icon: 'CheckCheck', ruleKind: 'number', filterable: true, sortable: true, width: 100 },
  { id: 'harness', label: 'Runs in', icon: 'Monitor', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 180, read: (ai: AI) => ai.harness ?? ai.app ?? '' },
  { id: 'model', label: 'Model', icon: 'Cpu', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170, read: (ai: AI) => ai.model ?? '' },
  { id: 'description', label: 'What it does', icon: 'Target', ruleKind: 'text', filterable: true, width: 360 },
  { id: 'last_seen_at', label: 'Last seen', icon: 'History', kind: 'date', ruleKind: 'date', sortable: true, width: 180, hiddenByDefault: true,
    read: (ai: AI) => when(ai.last_seen_at), sortValue: (ai: AI) => time(ai.last_seen_at) },
];

function AIWork({ page, older, latest }: { page: Page; older: (() => void) | null; latest: (() => void) | null }) {
  const [tab, setTab] = useState('work');
  const [view, setView] = useState(() => (window.matchMedia('(max-width: 600px)').matches ? 'table' : 'board'));
  const [groups, setGroups] = useState(() => Object.fromEntries(WORK_VIEWS.map(option => [option.id, option.groups])) as Record<string, GroupLevel[]>);
  const [reveal, setReveal] = useState<{ id: string; nonce: number } | undefined>();
  const ais = useMemo(() => new Map(page.agents.map(ai => [ai.agent_id, ai])), [page.agents]);
  const jobs = useMemo(() => new Map(page.work.map(job => [job.handoff_id, job])), [page.work]);
  const fields = useMemo(() => workFields(ais, jobs, page.apps), [ais, jobs, page.apps]);
  const show = (id: string | null) => { if (id && jobs.has(id)) setReveal({ id, nonce: Date.now() }); };
  const openDecision = (job: Job | undefined) => { if (job?.case_id) openScreenOn('trillion.decision', { screen: 'decision', id: job.case_id }, whatOf(job)); };
  const openRun = (job: Job | undefined) => { if (job) openScreenOn('trillion.job-run', { handoff: job.handoff_id }, whatOf(job)); };
  const working = page.work.filter(job => job.state === 'taken').length;
  const glance = useMemo(() => page.work.map(job => ({ id: job.handoff_id, title: whatOf(job), status: job.status, detail: job.in_the_way ?? job.summary ?? undefined, since: job.finished_at ?? job.in_the_way_at ?? job.taken_at ?? job.handed_at })), [page.work]);
  return (
    <Container layout="vertical" height="full" gap="none" minHeight="0">
      <Container layout="horizontal" padding="sm" alignItems="center">
        <ExpandableTabs
          ariaLabel="The work, or your AIs"
          value={tab}
          onChange={setTab}
          items={[{ id: 'work', label: 'Work', icon: 'Kanban', badge: working || undefined, pinned: true }, { id: 'ais', label: 'Your AIs', icon: 'Bot', badge: page.agents.length, pinned: true }]}
        />
      </Container>
      <Container layout="vertical" flex={1} minHeight="0">
        {tab === 'work' ? (
          <Container layout="vertical" height="full" gap="none" minHeight="0">
          {glance.length > 0 && <Container layout="vertical" padding="sm"><StatusOverview label="Work at a glance" looks={LOOKS} records={glance} /></Container>}
          <Container layout="vertical" flex={1} minHeight="0">
          <RecordViews
            label="AI work"
            fields={fields}
            records={page.work}
            identify={(job: Job) => job.handoff_id}
            views={WORK_VIEWS}
            view={view}
            onViewChange={setView}
            groupLevels={groups[view] ?? []}
            onGroupLevelsChange={levels => setGroups(current => ({ ...current, [view]: levels }))}
            links={partLines}
            reveal={reveal}
            onOpen={id => openRun(jobs.get(id))}
            rowActions={[
              { id: 'decision', label: 'Open the decision', icon: 'compass', lead: true, appliesTo: (job: Job) => Boolean(job.case_id), run: ids => openDecision(jobs.get(ids[0])) },
              { id: 'part-of', label: 'Show what it is part of', icon: 'git-branch', appliesTo: (job: Job) => Boolean(job.parent_handoff_id && jobs.has(job.parent_handoff_id)), run: ids => show(jobs.get(ids[0])?.parent_handoff_id ?? null) },
              { id: 'passed-on', label: 'Show what it passed on', icon: 'link', appliesTo: (job: Job) => job.handed_on.some(id => jobs.has(id)), run: ids => show(jobs.get(ids[0])?.handed_on.find(id => jobs.has(id)) ?? null) },
            ]}
            primaryAction={older ? { label: 'Show older', icon: 'History', onSelect: older } : undefined}
            toolbarStart={latest ? toolbar => mountSharedContent(toolbar, <Button variant="outline" size="sm" onClick={latest}>Show latest</Button>) : undefined}
            preferenceKey="trillion-ai-work"
            {...recordFilter}
            emptyMessage="Nothing matches."
          />
          </Container>
          </Container>
        ) : (
          <RecordViews
            label="Your AIs"
            fields={aiFields(page.apps)}
            records={page.agents}
            identify={(ai: AI) => ai.agent_id}
            views={[{ id: 'table', label: 'Table', icon: 'Table' }, { id: 'board', label: 'Board', icon: 'Kanban' }]}
            view="table"
            preferenceKey="trillion-ai-work-ais"
            {...recordFilter}
            emptyMessage={page.agents.length ? 'Nothing matches.' : 'No AI has said what it is yet. When one connects and says what it does, it shows here.'}
          />
        )}
      </Container>
    </Container>
  );
}

export function mountAIWorkScreen(element: HTMLElement): () => void {
  const host = document.createElement('div');
  host.className = 'trillion-ai-work';
  element.replaceChildren(host);
  // Only one bounded page and its continuation cursor stay in memory. Returning to the latest page needs no history stack.
  let before: string | null = null;
  let latest: Page | null = null;
  let screen: ReturnType<typeof loadScreen<Page>>;
  const draw = () => {
    if (!latest) return;
    const page = latest;
    mountSharedContent(host, <AIWork
      page={page}
      older={page.next_before ? () => { before = page.next_before; void screen.reload(); } : null}
      latest={before ? () => { before = null; void screen.reload(); } : null}
    />);
  };
  screen = loadScreen(host, {
    loading: { label: 'Loading what your AIs are working on', layout: 'rows' },
    read: () => readJson<Page>(before ? `${API}?${new URLSearchParams({ before })}` : API),
    empty: page => (page.work.length || page.agents.length ? null : {
      status: 'empty', icon: 'Kanban', title: 'No work yet',
      description: 'When one of your AIs asks another to do something, you see here who asked, who is doing it, and when it is done.',
      action: { label: 'Connect an AI', run: () => openScreen('trillion.ai') },
    }),
    failed: refusal('Your AI work could not load'),
    // Refresh the current bounded page from current records so a taken job cannot remain shown as running after it ends.
    draw: page => { latest = page; draw(); },
  });
  const stopListening = onStoreChange(() => screen.reload(), AI_WORK);
  return () => { stopListening(); screen.dispose(); element.replaceChildren(); };
}
