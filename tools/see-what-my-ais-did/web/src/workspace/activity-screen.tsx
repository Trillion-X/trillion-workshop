// src/workspace/activity-screen.tsx
//
// PURPOSE
//   AI activity: retained calls captured by this person's Trillion (handed off work, ran a tool, saved a file,
//   published a tool...), newest first, each row marked with that AI app's own picture, in the shared record views
//   (search, filter by app or result, group, table or board). Grouped by For, the board shows the work organized
//   around what it was done for (a decision, what a message was about). A row whose item has its own screen opens it in
//   a tab; any row's "How this happened" opens its chain (activity-trace-screen.tsx), and a row with no screen of its
//   own opens its chain directly. Opened with surfaceInput `only: 'failed'` (the Errors tool) it lists only what did not
//   work, each with its reason, the AI, its model and the chat it works in.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only rows the Worker kept (src/activity.mjs); missing rows cannot prove that no action or failure happened.
//   2. No app, tool or item kind is named here: labels come with each row (src/activity-marks.json), each app's picture
//      comes from its own sign-in registration (/work/api/activity `apps`), and an app without one shows its initials.
//   3. Fields and result words are DATA (activityFields and RESULT below); a new column is one row, never drawing code.
//      The chain screen draws its steps with these same fields.
//   4. Which rows a mode lists and how it is worded is DATA (MODES below), read from the tab's own input.

import * as React from 'react';
import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { PersonTag } from '../../parts/ui/show/person-tag/PersonTag';
import { ProviderMark, providerIconRegistry } from '../../parts/ui';
import providerNames from './activity-providers.json';
import { recordFilter } from './record-filter';
import { readJson } from './api';
import { refusal } from './failure';
import { openScreen, openScreenOn } from './open-screen';
import { backingOn, withBacking } from './automation-preview-source';
import { activityAssociationEvidence, activityAssociationLabel, activityEvidence, ORIGIN_VALUES, CAPTURE_VALUES } from './activity-trace-view.mjs';

export type ActivityRow = {
  seq: number; at: string; app: string | null; agent: string | null; agent_name?: string | null; model?: string | null;
  user_agent?: string | null; client_version?: string | null; tool: string; label: string; item: string | null; title: string | null;
  opens: { surface: string; input: string } | null; uses?: string[]; for?: string[]; ok: boolean; reason: string | null; chat?: string | null;
  execution_ref?: string | null; origin?: string; capture_kind?: string; identity_basis?: string; for_basis?: Record<string, string>;
  identity_snapshot?: { basis?: string; selection_basis?: string; agent_id?: string; agent_name?: string; model?: string; conversation_id?: string };
};
export type AppMarks = Record<string, { picture: string | null; site: string | null }>;
type Row = ActivityRow;
type Screen = { items: Row[]; next_before: number | null; apps: AppMarks };

/** The screen that shows how an item came about (surfaces.json), opened on that item. */
const TRACE_SURFACE = 'trillion.activity-trace';
export function openTrace(row: Row): void {
  const ref = row.execution_ref ?? row.item;
  if (ref) openScreenOn(TRACE_SURFACE, { item: ref }, row.title ?? row.label);
}
/** Opens the row's item on its own screen when it has one, else how it came about. */
export function openRow(row: Row): void {
  if (row.opens && row.item) openScreenOn(row.opens.surface, { [row.opens.input]: row.item }, row.title ?? row.label);
  else openTrace(row);
}

/** What each way of opening this screen lists and says: every call, or (`only: 'failed'`) what did not work. */
const MODES: Record<string, { query: string; label: string; loading: string; failed: string; empty: { icon: string; title: string; description: string } }> = {
  all: { query: '', label: 'AI activity', loading: 'Loading recorded calls', failed: 'Your AI activity could not load',
    empty: { icon: 'Activity', title: 'No calls in retained activity', description: 'This feed shows captured calls within its retention window. Older or uncaptured actions may still have happened; missing rows do not establish their outcome.' } },
  failed: { query: '?failed=true', label: 'Errors', loading: 'Loading what did not work', failed: 'Errors could not load',
    empty: { icon: 'Search', title: 'No failed calls found in retained activity', description: 'This checks recorded call failures. A returned call can still have the wrong real-world result, and older or uncaptured failures may be missing.' } },
};

const UNNAMED_APP = 'Recorder unknown';
const RESULT: Record<string, { label: string; tone: string }> = {
  done: { label: 'Call returned', tone: 'info' },
  failed: { label: 'Call failed', tone: 'danger' },
  unknown: { label: 'Call result unknown', tone: 'neutral' },
};
const appOf = (row: Row) => row.app ?? (row.tool === 'file_kept' ? 'Unidentified uploader' : UNNAMED_APP);
const providerOf = (row: Row) => row.app ? (providerNames.names as Record<string, string>)[row.app] : null;
/** Every item a list of rows made, by its id, named by its title where a row gave one. */
export const titlesOf = (rows: Row[]) => new Map(rows.filter(row => row.item && row.title).map(row => [row.item as string, row.title as string]));
const named = (ids: string[] | undefined, titles: Map<string, string>) => (ids ?? []).map(id => titles.get(id) ?? id);

/** The fields a row of what an AI did is shown with, here and on the chain screen; `titles` names the ids rows point at. */
export const activityFields = (apps: AppMarks, titles: Map<string, string>): FieldDescriptor[] => [
  { id: 'label', label: 'Recorded call', icon: 'Activity', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 210 },
  { id: 'actor', label: 'Recorded actor reference', icon: 'Bot', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 240, read: (row: Row) => activityEvidence(row).actor, preview: true },
  { id: 'app', label: 'Recorded app', icon: 'NotebookPen', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, read: appOf, preview: true,
    render: (row: Row) => <span title={[row.model, row.client_version, row.user_agent].filter(Boolean).join(' · ')} className="inline-flex items-center gap-2">
      {providerOf(row) ? <ProviderMark providerSlug={providerOf(row)!} providerName={row.app!} registry={providerIconRegistry} size="sm" decorative />
        : <PersonTag name={appOf(row)} picture={row.app ? apps[row.app]?.picture : null} size="sm" />}
      <span>{appOf(row)}</span>
    </span> },
  { id: 'title', label: 'Item', icon: 'Box', ruleKind: 'text', filterable: true, sortable: true, width: 340, read: (row: Row) => row.title ?? row.item ?? '' },
  { id: 'result', label: 'Call result', icon: 'Send', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 150, values: RESULT, read: (row: Row) => (row.ok === true ? 'done' : row.ok === false ? 'failed' : 'unknown'), preview: true },
  { id: 'origin', label: 'Origin', icon: 'FlaskConical', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 160, values: ORIGIN_VALUES, read: (row: Row) => activityEvidence(row).origin, preview: true },
  { id: 'reason', label: 'Why it did not work', icon: 'MessageCircleWarning', ruleKind: 'text', filterable: true, width: 320, read: (row: Row) => row.reason ?? '' },
  { id: 'chat', label: 'Recorded chat reference', icon: 'MessagesSquare', ruleKind: 'text', filterable: true, groupable: true, width: 220, hiddenByDefault: true, preview: true, read: (row: Row) => activityEvidence(row).actor_conversation ?? row.chat ?? '' },
  { id: 'for', label: 'Recorded association', icon: 'Target', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 280,
    read: (row: Row) => (row.for ?? []).map(id => `${titles.get(id) ?? id} — ${activityAssociationLabel(row, id)}`).join('\n') },
  { id: 'work_basis', label: 'Association evidence', icon: 'Fingerprint', ruleKind: 'text', filterable: true, width: 280, hiddenByDefault: true, preview: true,
    read: (row: Row) => activityAssociationEvidence(row) },
  { id: 'used', label: 'Used', icon: 'Link', ruleKind: 'text', filterable: true, width: 280, hiddenByDefault: true, read: (row: Row) => named(row.uses, titles).join(', ') },
  { id: 'tool', label: 'Tool', icon: 'Wrench', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170, hiddenByDefault: true, read: (row: Row) => row.tool },
  { id: 'agent', label: 'Recorded agent reference', icon: 'UserRound', ruleKind: 'text', filterable: true, groupable: true, width: 240, hiddenByDefault: true, preview: true, read: (row: Row) => row.identity_snapshot?.agent_id ?? row.agent ?? '' },
  { id: 'model', label: 'Recorded model', icon: 'Cpu', ruleKind: 'choice', filterable: true, groupable: true, width: 170, hiddenByDefault: true, read: (row: Row) => row.model ?? '' },
  { id: 'actor_basis', label: 'Actor evidence', icon: 'Fingerprint', ruleKind: 'text', filterable: true, width: 280, hiddenByDefault: true, preview: true, read: (row: Row) => activityEvidence(row).actor_basis },
  { id: 'recorder_basis', label: 'Recorder evidence', icon: 'Fingerprint', ruleKind: 'text', filterable: true, width: 300, hiddenByDefault: true, preview: true, read: (row: Row) => activityEvidence(row).recorder_basis },
  { id: 'capture_kind', label: 'Capture basis', icon: 'ScanLine', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180, values: CAPTURE_VALUES, hiddenByDefault: true, preview: true, read: (row: Row) => activityEvidence(row).capture },
  { id: 'execution_ref', label: 'Execution reference', icon: 'Route', ruleKind: 'text', filterable: true, width: 340, hiddenByDefault: true, preview: true, read: (row: Row) => row.execution_ref ?? '',
    render: (row: Row) => <span className="break-all whitespace-normal">{row.execution_ref ?? ''}</span> },
  { id: 'at', label: 'When', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, groupable: true, sortable: true, width: 180,
    read: (row: Row) => new Date(row.at).toLocaleString(), factValue: (row: Row) => Date.parse(row.at), sortValue: (row: Row) => Date.parse(row.at) },
];

export function mountActivityScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): () => void {
  const mode = MODES[String(props.surfaceInput?.only ?? 'all')] ?? MODES.all;
  let views: ReturnType<typeof mountRecordViews> | null = null;
  const list = document.createElement('div');
  list.className = 'trillion-activity';
  element.replaceChildren(list);

  const screen = loadScreen(list, {
    loading: { label: mode.loading, layout: 'rows' },
    read: () => Promise.all([readJson<Screen>(`/work/api/activity${mode.query}`), backingOn('trillion.activity')]),
    empty: ([answer]) => (answer.items.length ? null : {
      status: 'empty', ...mode.empty,
      ...(mode === MODES.all ? { action: { label: 'Connect an AI', run: () => openScreen('trillion.ai') } } : {}),
    }),
    failed: refusal(mode.failed),
    clear: () => { views?.destroy(); views = null; },
    draw: ([answer, behind]) => {
      const options = {
        label: mode.label,
        fields: withBacking(activityFields(answer.apps, titlesOf(answer.items)), behind),
        records: answer.items,
        identify: (row: Row) => String(row.seq),
        preferenceKey: mode === MODES.all ? 'trillion-activity' : 'trillion-activity-failed',
        views: [{ id: 'table', label: 'Table' }, { id: 'board', label: 'Board' }, { id: 'gallery', label: 'Cards' }],
        defaultView: window.matchMedia('(max-width: 600px)').matches ? 'gallery' : 'table',
        status: <p className="text-sm text-muted-foreground" role="status">This is a bounded feed of recorded calls. A returned call does not verify the intended outcome. Open “How this happened” for durable sources and observed evidence.{answer.next_before !== null ? ' Older retained calls also exist beyond this page.' : ''}</p>,
        ...recordFilter,
        // A row whose item has its own screen (a file, a decision) opens it beside the list; any other, its chain.
        onOpen: (id: string) => {
          const row = answer.items.find(item => String(item.seq) === id);
          if (row) openRow(row);
        },
        rowActions: [{ id: 'trace', label: 'How this happened', icon: 'route', lead: true, appliesTo: (row: Row) => Boolean(row.execution_ref ?? row.item), run: (ids: string[]) => {
          const row = answer.items.find(item => String(item.seq) === ids[0]);
          if (row) openTrace(row);
        } }],
        emptyMessage: 'Nothing matches.',
      };
      if (views) views.update(options); else views = mountRecordViews(list, options);
    },
  });
  return () => { screen.dispose(); element.replaceChildren(); };
}

