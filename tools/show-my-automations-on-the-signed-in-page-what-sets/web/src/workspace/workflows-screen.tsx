// src/workspace/workflows-screen.tsx
//
// PURPOSE
//   Automations: every trigger (a rule), schedule and workflow this person has, and every workflow run, in one list on
//   the shared record views: what kind it is, what sets it off and what it does in plain words, when it last ran and
//   runs next, and an on/off switch (the one shared Switch) for each trigger and schedule. Run now and Delete sit on
//   each row's menu. Opening a workflow or a run shows it in its own tab on the board (parts/group board-screen, its
//   `source` input: the workflow's steps are cards, its lines connectors saying what flows, a run's state a badge on
//   each card, with the board's drawing, shapes, notes, pictures, frames, collapse and tidy around them); opening a
//   trigger or schedule shows it in its own tab, its when and then on the board the same way, with its switch, its
//   words to edit and Save / Run now / Delete. Reads and changes go through /work/api/workflows (src/work-workflows.mjs), the same routes the person's AI
//   calls (set_rule, set_schedule, run_now, remove_rule, remove_schedule, start_workflow).
//   Sources, the second list (switched from the view bar): every place things arrive from (Apple Notes, Voice Memos,
//   Email, each connected account, each schedule), with what arrived and when, what the last arrival started (the rule
//   and its workflow run) and whether that worked, and why it failed. Read from /work/api/workflows/sources
//   (src/automations.mjs readHealth); opening a source opens the run its last arrival started.
//   The list's Draw view is the one canvas (the shared record views' designed row `canvas`): every trigger and
//   schedule is a card on the board with a line into the workflow it starts (`starts`, a links field), framed by kind
//   past a handful of cards, with the board's pen, shapes, notes and tidy around them.
//   A workflow's own tab shows its steps on Draw (the board), a Document and a Table: three views of the one
//   workflow. A step's words changed on its board card, in the Document or in the Table save the workflow.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the person's real automations and runs; none yet says so in the shared empty state.
//   2. Kinds' and states' words and tones come from the Worker's answer (src/workflow-looks.json, and for Sources
//      src/automation-health-looks.json), never from this file.
//   3. Every element is a shared component; this file writes no markup.
//   4. A run moves on outside this page, so its tab reads itself again each time the person's store changes (store-changes
//      onStoreChange, and the board reads its source again the same way): its step cards light up, tick off and fail
//      with no press. Run starts the workflow and opens the run; a step's card hands a waiting step to the person's AI
//      or runs a failed one again.
//   5. A switch shows the new state at once and goes back, with the Worker's words, when the change is refused.
//   6. Resting on a row's name shows its graph in the shared hover card (parts/ui/show/automation-preview, source in
//      automation-preview-source.tsx); the editor shows the same graph, edits through fields drawn from what it runs'
//      input schema (the raw text only behind the field editor's own "Edit as text"), and "Edit with your AI" hands the change in words to the
//      person's AI (hand_off); the AI's answer comes back as a proposal the person reviews and saves, never saved alone.
//   7. A trigger's own tab lists what it did (What it did): each time it fired, how its run ended and what that run said
//      it did (for a notification, the ways the person was told), read from /work/api/workflows/history/<id>.
//   8. Run now marks its row "Running now" at once, then how the press went: "Ran just now", or "Could not run just now:"
//      with the refusal's own words, which the store keeps as the last run, so reading the list again agrees
//      (src/workspace/last-run-words.mjs).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mountRecordViews, RecordViews, type FieldDescriptor, type RecordView } from '../../parts/ui/show/record-views/record-views';
import { loadScreen, mountScreenState, ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { AutomationPreview, forgetAutomationPreview } from '../../parts/ui/show/automation-preview';
import { mountExpandableTabs } from '../../parts/ui/show/expandable-tabs';
import { Button, Container, DisclosureSection, Input, StatusDot, StructuredValueEditor, Switch, Text, Textarea } from '../../parts/ui';
import { NameAndCreate } from '../../parts/ui/show/name-and-create';
import { notify } from '../../parts/ui/show/coss/notifications';
import { recordFilter } from './record-filter';
import { readJson } from './api';
import { onStoreChange } from './store-changes';
import { askFor, reasonOf, refusal } from './failure';
import { goTo, openScreenOn } from './open-screen';
import { openAutomation } from './automation-preview-source';
import { BoardOf } from './board-of';
import { whereWords } from './where-words.mjs';
import { dateText, lastRunWords } from './last-run-words.mjs';
import workflowLooks from '../workflow-looks.json';
import { shareAction } from './sharing-sheet';
import { addSelectedToTrayAction } from './tray';
import { controlShown, useShowChange } from '../../parts/ui/show/show-rules/show-of';

type Look = { label: string; tone: string };
type Run = { run_id: string; workflow_id: string; label: string; state: string; started_at: string; step_now?: string | null; finished_at?: string; error?: string };
type Workflow = { workflow_id: string; label: string; job: string; made_by: string; steps: number; runs: number };
type Kind = 'trigger' | 'schedule' | 'workflow' | 'run';
type Automation = { id: string; open_id?: string; kind: Kind; name: string; when: string; does: string; starts?: string | null; enabled: boolean | null; made_by?: string; backs?: { screen: string; item: string }[]; last_run_at: string | null; last_problem: string | null; next_run_at: string | null };
type Listing = { looks: Record<string, Look>; kinds: Record<string, Look & { icon?: string }>; makers: Record<string, Look & { published?: boolean }>; automations: Automation[]; workflows: Workflow[]; runs: Run[] };
type Row = Automation & { state: string; running?: boolean };
type Started = { rule_id: string | null; rule_label: string | null; state: string; result: string; run_id?: string; task_id?: string; error_words?: string };
type Source = { source_id: string; kind: string; kind_label: string; label: string; connected: boolean; last: { at: string; title: string | null } | null; nothing_yet: string | null; last_started: Started[]; arrivals: Record<string, number>; rules: { rule_id: string; label: string; enabled: boolean }[]; fires: number; results: Record<string, number>; last_error: { words: string; at: string; rule_label?: string } | null; readers?: { computer: string; status: string; last_read_at: string | null; latest_item_at: string | null; problem: string | null }[]; reader_problem?: string | null; idle_words?: string | null; state: string; look: Look | null };
type Health = { sources: Source[]; periods: { id: string; label: string }[]; states: Record<string, Look>; results: Record<string, Look>; words: { started_nothing: string } };
type Then = { tool_id?: string; workflow_id?: string; input?: Record<string, unknown> };
type Schema = { type?: string; properties?: Record<string, Schema>; default?: unknown; items?: Schema } | null;
// A workflow's steps and lines as src/work-workflows.mjs answers them.
type StateLook = { label: string; tone?: string; pulse?: boolean };
type GraphStep = { id: string; title: string; does?: string; caption?: string; icon?: string; hands?: { name: string; kind: string }[]; state?: string; details?: { label: string; text: string }[] };
type GraphEdge = { from: string; to: string; label?: string };
type Detail = { kind: 'trigger' | 'schedule'; id: string; label: string; enabled: boolean; says: string; does: string; when?: unknown; every?: unknown; once_at?: string; then: Then; input_schema: Schema; next_run_at?: string | null; last_run?: { at: string; task_id?: string; run_id?: string; problem?: string } | null; graph: { steps: GraphStep[]; edges: GraphEdge[]; looks: Record<string, StateLook> } };
type Proposal = { label?: string; when?: unknown; every?: unknown; once_at?: string; then?: Then };
type AiEdit = { handoff_id: string; asked: string; state: string; asked_at: string; taken_by: string | null; answered_at: string | null; summary: string | null; proposal: Proposal | null; said?: string };
type Fire = { at: string; record_id: string | null; state: string; said?: string; problem?: string; task_id?: string; run_id?: string };
type WrittenStep = { id: string; title?: string; do: string; submit: unknown; [field: string]: unknown };
type Written = { id: string; label?: string; job: string; input_schema?: unknown; steps: WrittenStep[] };
type Graph = { written?: Written; yours?: boolean; workflow_id: string; title: string; job: string; made_by: string; made_from?: string[]; variations?: number; looks: Record<string, StateLook>; run: null | { run_id: string; state: string; look: Look | null; steps_left: number; error?: string; finished_at?: string }; steps: GraphStep[]; edges: GraphEdge[] };

// Each listed automation names the id it opens with (`open_id`, src/work-workflows.mjs): `automation:<id>` for a
// trigger or schedule, read back here to open its editor; a workflow or run opens as its own id.
const AUTOMATION = 'automation:';
const tabId = (row: Row) => row.open_id ?? row.id;
const openRow = (row: Row) => openAutomation(tabId(row), row.name);
const post = <T,>(action: string, body: unknown) => readJson<T>(`/work/api/workflows/${action}`, { method: 'POST', body: JSON.stringify(body) });
const problemOf = reasonOf;

// A trigger or schedule on or off, and run once now: the same calls the person's AI makes.
const setEnabled = (row: { kind: Kind; id: string }, enabled: boolean) => (row.kind === 'trigger' ? post('set-rule', { rule_id: row.id, enabled }) : post('set-schedule', { schedule_id: row.id, enabled }));
type Ran = { ran_at: string; task_id?: string; run_id?: string };
const runNow = (row: { kind: Kind; id: string }) => (row.kind === 'workflow' ? post<Ran>('start-workflow', { workflow_id: row.id }) : post<Ran>('run-now', row.kind === 'trigger' ? { rule_id: row.id } : { schedule_id: row.id }));
const removeOne = (row: { kind: Kind; id: string }) => (row.kind === 'workflow' ? post('remove-workflow', { workflow_id: row.id }) : row.kind === 'trigger' ? post('remove-rule', { rule_id: row.id }) : post('remove-schedule', { schedule_id: row.id }));

const fieldsFor = (listing: Listing, toggle: (row: Row, enabled: boolean) => void): FieldDescriptor[] => [
  { id: 'name', label: 'Name', icon: 'Zap', ruleKind: 'text', filterable: true, sortable: true, width: 260,
    render: (row: Row) => (row.kind === 'run' ? row.name : <AutomationPreview automationId={tabId(row)} title={row.name} side="right">{row.name}</AutomationPreview>) },
  { id: 'enabled', label: 'On', icon: 'Power', width: 72, read: (row: Row) => (row.enabled === null ? '' : row.enabled ? 'On' : 'Off'),
    // The switch is the control `automations.switch` (parts/ui part.json); hidden, the column still says On or Off.
    render: (row: Row) => (row.enabled === null ? null : !controlShown('automations.switch') ? (row.enabled ? 'On' : 'Off') : <Switch checked={row.enabled} label={`${row.name} ${row.enabled ? 'on' : 'off'}`} onCheckedChange={next => toggle(row, next)} />) },
  { id: 'kind', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 120, values: listing.kinds },
  { id: 'made_by', label: 'Made by', icon: 'UserRound', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 130, values: listing.makers },
  { id: 'when', label: 'What sets it off', icon: 'Play', ruleKind: 'text', filterable: true, width: 280 },
  { id: 'does', label: 'What it does', icon: 'Target', ruleKind: 'text', filterable: true, width: 280 },
  // The workflow a trigger or schedule starts: on Draw, a line from it into that workflow.
  { id: 'starts', label: 'Starts', icon: 'Workflow', width: 200, hiddenByDefault: true, links: { direction: 'to' },
    read: (row: Row) => row.starts ?? '', render: (row: Row) => (row.starts ? listing.workflows.find(item => item.workflow_id === row.starts)?.label ?? row.starts : null) },
  { id: 'last_run_at', label: 'Last run', icon: 'History', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 170, read: (row: Row) => lastRunWords({ at: row.last_run_at, problem: row.last_problem, running: row.running }), factValue: (row: Row) => (row.last_run_at ? Date.parse(row.last_run_at) : null), sortValue: (row: Row) => (row.last_run_at ? Date.parse(row.last_run_at) : 0) },
  { id: 'next_run_at', label: 'Next run', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 170, read: (row: Row) => dateText(row.next_run_at), factValue: (row: Row) => (row.next_run_at ? Date.parse(row.next_run_at) : null), sortValue: (row: Row) => (row.next_run_at ? Date.parse(row.next_run_at) : 0) },
  { id: 'state', label: 'State', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 140, hiddenByDefault: true, values: { ...listing.looks, on: { label: 'On', tone: 'success' }, off: { label: 'Off', tone: 'neutral' }, ready: { label: 'Ready', tone: 'neutral' } } },
];

// The worst way the last arrival's runs ended, so one tag says whether it worked.
const RESULT_ORDER = ['failed', 'working', 'succeeded'];
const lastResult = (source: Source) => RESULT_ORDER.find(result => source.last_started.some(item => item.result === result)) ?? '';
// Which rules the last arrival set off; whether each worked is its own column.
const startedWords = (source: Source, health: Health) => (!source.last ? '' : source.last_started.length
  ? [...new Set(source.last_started.map(item => item.rule_label ?? ''))].join(', ')
  : health.words.started_nothing);

const sourceFieldsFor = (health: Health): FieldDescriptor[] => [
  { id: 'label', label: 'Source', icon: 'Inbox', ruleKind: 'text', filterable: true, sortable: true, width: 190 },
  { id: 'state', label: 'State', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 130,
    read: (source: Source) => source.look?.label ?? '', values: Object.fromEntries(health.sources.filter(source => source.look).map(source => [source.look!.label, source.look!])) },
  { id: 'last', label: 'Last arrived', icon: 'Clock', ruleKind: 'text', filterable: true, sortable: true, width: 280,
    read: (source: Source) => (source.last ? [source.last.title, dateText(source.last.at)].filter(Boolean).join(' · ') : source.nothing_yet ?? ''),    sortValue: (source: Source) => (source.last ? Date.parse(source.last.at) : 0) },
  { id: 'last_on_computer', label: 'Last seen on computer', icon: 'Clock', ruleKind: 'text', filterable: true, sortable: true, width: 220,
    read: (source: Source) => (source.readers ?? []).map(reader => reader.latest_item_at ? `${reader.computer} · ${dateText(reader.latest_item_at)}` : '').filter(Boolean).join(', '),
    sortValue: (source: Source) => Math.max(0, ...(source.readers ?? []).map(reader => Date.parse(reader.latest_item_at ?? '') || 0)) },
  { id: 'started', label: 'What it started', icon: 'Workflow', ruleKind: 'text', filterable: true, width: 230, read: (source: Source) => startedWords(source, health) },
  { id: 'result', label: 'Did it work', icon: 'CircleCheck', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 120, read: lastResult,
    values: health.results },
  // The plain words for a source with no recent arrival ("Nothing has arrived since …", "No reader is set up …") close the list
  // of reasons, so a source that is not Working always says what is true instead of a blank.
  { id: 'problem', label: 'Why it failed', icon: 'TriangleAlert', ruleKind: 'text', filterable: true, width: 300,
    read: (source: Source) => source.reader_problem ?? source.last_started.find(item => item.error_words)?.error_words ?? source.last_error?.words ?? source.idle_words ?? '' },
  ...health.periods.map(period => ({ id: `arrived_${period.id}`, label: period.label, icon: 'Hash', ruleKind: 'number', filterable: true, sortable: true, width: 120, read: (source: Source) => source.arrivals[period.id] ?? 0 })),
  { id: 'kind_label', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 170 },
  { id: 'rules', label: 'Rules on it', icon: 'Zap', ruleKind: 'text', filterable: true, width: 220, hiddenByDefault: true, read: (source: Source) => source.rules.map(rule => rule.label).join(', ') },
];

type Shown = 'automations' | 'sources';
const SHOWN_TABS = [
  { id: 'automations', label: 'Automations', icon: 'Zap', pinned: true },
  { id: 'sources', label: 'Sources', icon: 'Inbox', pinned: true },
];

export function mountWorkflowsScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let rows: Row[] = [];
  const list = document.createElement('div');
  list.className = 'trillion-decisions';
  // Sources: its own list in the same place, switched from either list's view bar.
  const sourceList = document.createElement('div');
  sourceList.className = 'trillion-decisions';
  let sourceViews: ReturnType<typeof mountRecordViews> | null = null;
  let sourceScreen: ReturnType<typeof loadScreen> | null = null;
  let shown: Shown = 'automations';
  // Each list's view bar carries the switch, showing that list as the one chosen.
  const switcherFor = (own: Shown) => (host: HTMLElement) => mountExpandableTabs(host, { items: SHOWN_TABS, ariaLabel: 'Automations or sources', mode: 'choice', size: 'sm', value: own, onChange: id => showList(id as Shown) });
  const automationsSwitcher = switcherFor('automations');
  const sourcesSwitcher = switcherFor('sources');
  function showList(next: Shown) {
    if (next === shown) return;
    shown = next;
    element.replaceChildren(next === 'automations' ? list : sourceList);
    if (next === 'automations') void screen.reload();
    else if (!sourceScreen) sourceScreen = loadSources();
    else void sourceScreen.reload();
  }
  function loadSources() {
    return loadScreen(sourceList, {
      loading: { label: 'Loading your sources', layout: 'rows' },
      read: () => readJson<Health>('/work/api/workflows/sources'),
      failed: refusal('Your sources could not load'),
      clear: () => { sourceViews?.destroy(); sourceViews = null; },
      draw: health => {
        const records = health.sources;
        if (sourceViews) { sourceViews.update({ records, fields: sourceFieldsFor(health) }); return; }
        const find = (id: string) => records.find(source => source.source_id === id);
        sourceViews = mountRecordViews(sourceList, {
          label: 'Sources',
          fields: sourceFieldsFor(health),
          records,
          identify: (source: Source) => source.source_id,
          preferenceKey: 'trillion-automation-sources',
          views: [{ id: 'table', label: 'Table' }, { id: 'board', label: 'Board' }],
          view: 'table',
          toolbarStart: sourcesSwitcher,
          ...recordFilter,
          // Opening a source opens the workflow run its last arrival started.
          onOpen: (id: string) => {
            const run = find(id)?.last_started.find(item => item.run_id);
            if (run?.run_id) openAutomation(run.run_id, run.rule_label ?? find(id)!.label);
          },
          emptyMessage: 'Nothing matches.',
        });
      },
    });
  }
  element.replaceChildren(list);
  const show = (next: Row[]) => { rows = next; views?.update({ records: rows }); };
  const stateOf = (enabled: boolean) => (enabled ? 'on' : 'off');
  const rowsOf = (listing: Listing): Row[] => {
    const jobOf = (id: string) => listing.workflows.find(item => item.workflow_id === id)?.job ?? '';
    return [
      // A workflow someone made for everyone is not this person's automation: the Marketplace lists those (published).
      ...listing.automations.filter(item => !(item.made_by && listing.makers[item.made_by]?.published))
        .map(item => ({ ...item, state: item.enabled === null ? 'ready' : stateOf(item.enabled) })),
      ...listing.runs.map(run => ({ id: run.run_id, kind: 'run' as const, name: run.label, when: `Started ${dateText(run.started_at)}`, does: jobOf(run.workflow_id), enabled: null, last_run_at: run.started_at, last_problem: run.error ?? null, next_run_at: null, state: run.state })),
    ];
  };

  function toggle(row: Row, enabled: boolean) {
    show(rows.map(item => (item.id === row.id && item.kind === row.kind ? { ...item, enabled, state: stateOf(enabled) } : item)));
    setEnabled(row, enabled)
      .then(() => void screen.reload())
      .catch(error => {
        show(rows.map(item => (item.id === row.id && item.kind === row.kind ? { ...item, enabled: !enabled, state: stateOf(!enabled) } : item)));
        notify(`${row.name} could not be turned ${enabled ? 'on' : 'off'}`, { kind: 'error', detail: problemOf(error) });
      });
  }

  const screen = loadScreen(list, {
    loading: { label: 'Loading your automations', layout: 'rows' },
    read: () => readJson<Listing>('/work/api/workflows'),
    empty: listing => (rowsOf(listing).length ? null : {
      status: 'empty', icon: 'Zap', title: 'No automations yet',
      description: 'What your Trillion does by itself appears here: when you connect an account, or ask your AI to do something every morning or whenever an email arrives, it shows up here with a switch to turn it off.',
      ...(controlShown('automations.find') ? { action: { label: 'Find workflows others made', run: () => openScreenOn('trillion.marketplace', { kind: 'workflow', who: 'everyone' }) } } : {}),
      ask: askFor('automations'),
    }),
    failed: refusal('Your automations could not load'),
    clear: () => { views?.destroy(); views = null; },
    draw: listing => {
      if (views) { show(rowsOf(listing)); return; }
      rows = rowsOf(listing);
      const find = (id: string) => rows.find(row => row.id === id);
      const shareRecord = (row: Row) => row.kind === 'workflow' ? row.id : null;
      const share = shareAction(find, shareRecord, (row: Row) => row.name);
      const addToTray = addSelectedToTrayAction(list, find, shareRecord, (row: Row) => row.name);
      views = mountRecordViews(list, {
        label: 'Automations',
        fields: fieldsFor(listing, toggle),
        records: rows,
        identify: (row: Row) => row.id,
        shareRecord,
        preferenceKey: 'trillion-automations',
        views: [{ id: 'table', label: 'Table' }, { id: 'canvas', label: 'Draw', icon: 'PenTool' }, { id: 'board', label: 'Board' }],
        view: 'table',
        toolbarStart: automationsSwitcher,
        ...recordFilter,
        rowActions: [
          { id: 'run-now', label: 'Run now', icon: 'play', appliesTo: (row: Row) => row.kind !== 'run',
            run: ids => ids.map(find).filter((row): row is Row => Boolean(row)).forEach(row => {
              // The row says it is running at once, then how the press went (kept by the store, so reading again agrees).
              const mark = (change: Partial<Row>) => show(rows.map(item => (item.id === row.id && item.kind === row.kind ? { ...item, ...change } : item)));
              mark({ running: true });
              runNow(row).then(ran => { mark({ running: false, last_run_at: ran.ran_at, last_problem: null }); notify(`${row.name} ran`, { kind: 'success' }); void screen.reload(); })
                .catch(error => { mark({ running: false, last_run_at: new Date().toISOString(), last_problem: problemOf(error) }); notify(`${row.name} could not run`, { kind: 'error', detail: problemOf(error) }); void screen.reload(); });
            }) },
          { id: 'delete', label: 'Delete', icon: 'trash-2', tone: 'destructive', appliesTo: (row: Row) => row.kind === 'workflow' || row.kind === 'trigger' || row.kind === 'schedule',
            run: ids => ids.map(find).filter((row): row is Row => Boolean(row)).forEach(row => {
              removeOne(row).then(() => void screen.reload()).catch(error => notify(`${row.name} could not be deleted`, { kind: 'error', detail: problemOf(error) }));
            }) },
        ],
        bulkActions: [share, addToTray],
        onOpen: (id: string) => { const row = find(id); if (row) openRow(row); },
        emptyMessage: 'Nothing matches.',
      });
    },
  });
  // A run moves on outside this page, so coming back to the page reads the list again.
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    void (shown === 'automations' ? screen : sourceScreen)?.reload();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => { document.removeEventListener('visibilitychange', onVisible); screen.dispose(); sourceScreen?.dispose(); element.replaceChildren(); };
}

type Value = Record<string, unknown>;
// What sets a rule off: its own fields in the schema-built form, and each test it holds under `where` as one line in
// plain words from its values ("Text contains 'invoice'") that opens to edit that test.
function WhenEditor({ title, when, onChange }: { title: string; when: Value; onChange: (next: Value) => void }) {
  const { where, ...rest } = when as Value & { where?: unknown };
  const tests = Array.isArray(where) && where.every(test => test && typeof test === 'object') ? (where as Value[]) : null;
  const own = tests ? rest : when;
  const setTest = (at: number, next: Value) => onChange({ ...when, where: tests!.map((test, index) => (index === at ? next : test)) });
  return (
    <DisclosureSection title={title} titleLook="caption">
      <Container layout="vertical" gap="sm">
        {Object.keys(own).length ? <StructuredValueEditor value={own} onChange={next => onChange(tests ? { ...(next as Value), where: tests } : (next as Value))} /> : null}
        {(tests ?? []).map((test, at) => (
          <DisclosureSection key={at} title={whereWords(test, workflowLooks.test_words)} titleLook="caption" headingLevel={4} collapsible defaultOpen={false} divider={false}>
            <StructuredValueEditor value={test} onChange={next => setTest(at, next as Value)} />
          </DisclosureSection>
        ))}
      </Container>
    </DisclosureSection>
  );
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Every input the schema names, with what is set now (or its default, or an empty value of its type), so each input
// has a field even before it is filled. Values the schema does not name are kept.
function inputsFrom(schema: Schema, current: unknown): unknown {
  if (!schema || schema.type !== 'object' || !schema.properties) return current ?? (schema?.type === 'object' ? {} : '');
  const held = isObject(current) ? current : {};
  const empty = (field: Schema) => (field?.default !== undefined ? field.default : field?.type === 'number' || field?.type === 'integer' ? 0 : field?.type === 'boolean' ? false : field?.type === 'array' ? [] : field?.type === 'object' ? inputsFrom(field, {}) : '');
  return { ...Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => [key, key in held ? (field?.type === 'object' && isObject(held[key]) && !('fill' in (held[key] as object)) ? inputsFrom(field, held[key]) : held[key]) : empty(field)])), ...Object.fromEntries(Object.entries(held).filter(([key]) => !(key in (schema.properties ?? {})))) };
}

// The asks made of the person's AI about one automation, read again every few seconds while one is still waiting.
function useAiEdits(id: string) {
  const [edits, setEdits] = useState<AiEdit[]>([]);
  const read = useCallback(async () => { setEdits((await readJson<{ edits: AiEdit[] }>(`/work/api/workflows/ai-edits/${encodeURIComponent(id)}`)).edits); }, [id]);
  useEffect(() => { void read().catch(() => undefined); }, [read]);
  const waiting = edits.some(edit => edit.state !== 'finished');
  useEffect(() => {
    if (!waiting) return;
    const every = window.setInterval(() => void read().catch(() => undefined), 4000);
    return () => window.clearInterval(every);
  }, [waiting, read]);
  return { edits, read };
}

// One trigger or schedule: its graph, its switch, fields for what sets it off and what it runs, Save / Run now /
// Delete, and "Edit with your AI".
function AutomationDetail({ id }: { id: string }) {
  // Each control here is a show-rules control (parts/ui part.json `automations.*`, `ai.automation-edit`).
  useShowChange();
  const loaded = useScreenLoad(`automation:${id}`, {
    loading: { label: 'Loading this automation', layout: 'editor' },
    read: () => readJson<Detail>(`/work/api/workflows/automation/${encodeURIComponent(id)}`),
    failed: refusal('This automation could not load'),
  });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [label, setLabel] = useState('');
  const [when, setWhen] = useState<unknown>({});
  const [onceAt, setOnceAt] = useState('');
  const [inputs, setInputs] = useState<unknown>({});
  const [asking, setAsking] = useState('');
  const [fromAi, setFromAi] = useState<string | null>(null);
  const ai = useAiEdits(id);
  // Each answer read is what the fields start from.
  useEffect(() => {
    const next = loaded.value;
    if (!next) return;
    setDetail(next); setLabel(next.label); setFromAi(null);
    setWhen(next.kind === 'trigger' ? next.when : next.every ?? {}); setOnceAt(next.once_at ?? '');
    setInputs(inputsFrom(next.input_schema, next.then.input ?? {}));
  }, [loaded.value]);
  const read = loaded.reload;
  if (gone) return <ScreenState state={{ status: 'empty', icon: 'Trash2', title: 'Deleted', description: 'It will not run again.', action: goTo('Open Automations', 'trillion.workflows') }} />;
  if (loaded.state) return <ScreenState state={loaded.state} />;
  if (!detail) return <ScreenState state={{ status: 'loading', label: 'Loading this automation', layout: 'editor' }} />;
  const row = { kind: detail.kind, id: detail.id };
  const target = detail.then.workflow_id ? { workflow_id: detail.then.workflow_id } : { tool_id: detail.then.tool_id };
  const act = async (work: () => Promise<string | null>) => {
    setBusy(true); setSaid(null); setProblem(null);
    try { const words = await work(); if (words) setSaid(words); } catch (error) { setProblem(problemOf(error)); } finally { setBusy(false); }
  };
  const changed = async () => { forgetAutomationPreview(`${AUTOMATION}${id}`); await read(); };
  const save = () => act(async () => {
    const then = { ...target, input: inputs };
    if (detail.kind === 'trigger') await post('set-rule', { rule_id: id, label, when, then });
    else await post('set-schedule', { schedule_id: id, label, then, ...(detail.once_at ? { once_at: onceAt.trim() } : { every: when }) });
    await changed();
    return fromAi ? 'Saved your AI\'s change.' : 'Saved.';
  });
  const toggle = (enabled: boolean) => act(async () => { setDetail({ ...detail, enabled }); await setEnabled(row, enabled); await changed(); return enabled ? 'On. It runs by itself again.' : 'Off. It will not run until you turn it on.'; });
  const run = () => act(async () => { await runNow(row).finally(() => read()); return 'Ran just now.'; });
  const remove = () => act(async () => { await removeOne(row); setGone(true); return null; });
  const ask = () => act(async () => {
    await post('ask-ai', { id, words: asking });
    setAsking('');
    await ai.read();
    return 'Handed to your AI. Its answer shows here for you to look over and save.';
  });
  // An answer from the AI fills the fields; nothing is saved until the person presses Save.
  const takeAnswer = (edit: AiEdit) => {
    const proposal = edit.proposal!;
    if (proposal.label) setLabel(proposal.label);
    if (proposal.when !== undefined) setWhen(proposal.when);
    if (proposal.every !== undefined) setWhen(proposal.every);
    if (proposal.once_at) setOnceAt(proposal.once_at);
    if (proposal.then?.input) setInputs(inputsFrom(detail.input_schema, proposal.then.input));
    setFromAi(edit.handoff_id);
    setSaid('Your AI\'s change is in the fields below. Look it over, then Save.');
  };
  const nextWords = detail.enabled ? (detail.next_run_at ? `Next run ${dateText(detail.next_run_at)}` : null) : 'Off';
  const lastWords = detail.last_run?.at ? `Last run: ${lastRunWords({ at: detail.last_run.at, problem: detail.last_run.problem })}` : 'Not run yet';
  const whenLabel = detail.kind === 'trigger' ? 'What sets it off' : 'When it runs';
  return (
    <Container layout="vertical" gap="md" padding="lg" data-automation={id} style={{ maxWidth: 820 }}>
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between">
        <Container layout="vertical" gap="xs" flex={1} style={{ minWidth: 0 }}>
          <Text variant="heading-xs" truncate>{detail.label}</Text>
          <Text variant="caption" color="muted">{[detail.says, nextWords, lastWords].filter(Boolean).join(' · ')}</Text>
        </Container>
        {controlShown('automations.switch') ? <Switch checked={detail.enabled} disabled={busy} label={`${detail.label} ${detail.enabled ? 'on' : 'off'}`} onCheckedChange={next => void toggle(next)} /> : null}
      </Container>
      <Container layout="vertical" style={{ height: 440, overflow: 'hidden' }} data-automation-graph={id}>
        <BoardOf boardId={`automation:${id}`} title={detail.label} source={{ key: `automation:${id}`, read: `/work/api/workflows/board/${encodeURIComponent(`${AUTOMATION}${id}`)}` }} />
      </Container>
      {controlShown('ai.automation-edit') ? <Container layout="vertical" gap="sm" data-automation-ask-ai>
        <Textarea label="Edit with your AI" rows={2} placeholder="Say what to change, like: only for emails from my accountant" value={asking} onChange={event => setAsking(event.currentTarget.value)} />
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Button size="sm" variant="secondary" disabled={busy || !asking.trim()} onClick={() => ask()}>Ask your AI</Button>
        </Container>
        {ai.edits.map(edit => (
          <Container key={edit.handoff_id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" data-ai-edit={edit.state}>
            <Container layout="vertical" gap="xs" flex={1} style={{ minWidth: 0 }}>
              <Text variant="body-xs">"{edit.asked}"</Text>
              <Text variant="caption" color="muted">{edit.state === 'finished' ? (edit.proposal ? `Your AI answered ${dateText(edit.answered_at)}${edit.summary ? `: ${edit.summary}` : ''}` : `Your AI answered: ${edit.said ?? edit.summary ?? 'with no change'}`) : edit.taken_by ? 'Your AI is working on it' : 'Waiting for one of your AIs to pick it up'}</Text>
            </Container>
            {edit.proposal ? <Button size="sm" variant="ghost" disabled={busy || fromAi === edit.handoff_id} onClick={() => takeAnswer(edit)}>{fromAi === edit.handoff_id ? 'In the fields' : 'Use this answer'}</Button> : null}
          </Container>
        ))}
      </Container> : null}
      {controlShown('automations.edit') ? <>
        <Input label="Name" value={label} onChange={event => setLabel(event.currentTarget.value)} />
        {detail.once_at
          ? <Input label={whenLabel} value={onceAt} onChange={event => setOnceAt(event.currentTarget.value)} />
          : <WhenEditor title={whenLabel} when={when as Value} onChange={setWhen} />}
        <DisclosureSection title={`What it does: ${detail.does}`} titleLook="caption"><StructuredValueEditor value={inputs} onChange={setInputs} /></DisclosureSection>
      </> : null}
      <Container layout="horizontal" gap="sm" alignItems="center">
        {controlShown('automations.edit') ? <Button size="sm" onClick={() => save()} disabled={busy}>Save</Button> : null}
        {controlShown('automations.run') ? <Button size="sm" variant="secondary" onClick={() => run()} disabled={busy}>Run now</Button> : null}
        {controlShown('automations.delete') ? <Button size="sm" variant="ghost" onClick={() => remove()} disabled={busy}>Delete</Button> : null}
        {said ? <Text variant="caption" color="muted" data-automation-said>{said}</Text> : null}
        {problem ? <Text variant="caption" color="error">{problem}</Text> : null}
      </Container>
      {detail.kind === 'trigger' ? <RuleHistory id={id} /> : null}
    </Container>
  );
}

// What one trigger did: each time it fired, newest first, with how its run ended and what it said it did.
function RuleHistory({ id }: { id: string }) {
  const [fires, setFires] = useState<Fire[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    readJson<{ fires: Fire[] }>(`/work/api/workflows/history/${encodeURIComponent(id)}`)
      .then(answer => { if (live) setFires(answer.fires); }, error => { if (live) setProblem(problemOf(error)); });
    return () => { live = false; };
  }, [id]);
  const looks = workflowLooks.run_states as Record<string, Look>;
  return (
    <Container layout="vertical" gap="none" data-automation-history={id}>
      <DisclosureSection title="What it did" titleLook="caption">
        <Container layout="vertical" gap="sm">
          {problem ? <Text variant="caption" color="error">{problem}</Text> : null}
          {fires && !fires.length ? <Text variant="caption" color="muted">It has not been set off yet.</Text> : null}
          {(fires ?? []).map(fire => (
            <Container key={`${fire.at}:${fire.record_id}`} layout="horizontal" gap="sm" alignItems="center" data-automation-fire={fire.state}>
              <StatusDot size="sm" status={(looks[fire.state]?.tone ?? 'idle') as never} />
              <Container layout="vertical" gap="none" flex={1} style={{ minWidth: 0 }}>
                <Text variant="body-xs">{`${dateText(fire.at)} · ${looks[fire.state]?.label ?? fire.state}`}</Text>
                {fire.said || fire.problem ? <Text variant="caption" color={fire.problem ? 'error' : 'muted'}>{fire.problem ?? fire.said}</Text> : null}
              </Container>
            </Container>
          ))}
        </Container>
      </DisclosureSection>
    </Container>
  );
}

// One step as the workflow's views read it: the step itself, the steps it comes after, and its state's words.
type StepRecord = GraphStep & { after: string[] };
const detailOf = (step: GraphStep, label: string) => step.details?.find(detail => detail.label === label)?.text ?? '';

// The fields of a workflow's steps, the same for its Draw, its Outline and its Table: what it is, what it does, who
// does it, what it hands on, what it comes after (a line on Draw) and where it stands.
const stepFields = (steps: StepRecord[], looks: Record<string, StateLook>, editable: boolean): FieldDescriptor[] => {
  const titleOf = new Map(steps.map(step => [step.id, step.title]));
  return [
    { id: 'title', label: 'Step', icon: 'Workflow', ruleKind: 'text', filterable: true, width: 260, editable, mark: (step: StepRecord) => (step.icon ? { icon: step.icon, label: step.caption ?? '' } : null) },
    // The step's words: what the Document view reads under each step (the `body` role).
    { id: 'does', label: 'What it does', icon: 'Target', ruleKind: 'text', filterable: true, width: 360, read: (step: StepRecord) => step.does ?? detailOf(step, 'What it does'), role: 'body', editable },
    { id: 'caption', label: 'Who does it', icon: 'UserRound', ruleKind: 'text', filterable: true, groupable: true, width: 180 },
    { id: 'hands', label: workflowLooks.value_kinds.hands_on, icon: 'ArrowRightFromLine', ruleKind: 'text', filterable: true, width: 260, read: (step: StepRecord) => (step.hands ?? []).map(hand => `${hand.name} (${hand.kind})`).join(', ') },
    { id: 'after', label: 'Comes after', icon: 'CornerDownRight', width: 200, links: { direction: 'from' }, read: (step: StepRecord) => step.after, render: (step: StepRecord) => step.after.map(id => titleOf.get(id) ?? id).join(', ') || null },
    { id: 'state', label: 'State', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 160,
      values: Object.fromEntries(Object.entries(looks).map(([key, look]) => [key, { label: look.label, tone: look.tone, working: look.pulse === true, settled: look.flow === 'completed' }])) },
  ];
};

// The views of one workflow: its steps drawn on Draw (the board, each step a card with its state live), read as a
// Document (one heading per step, in order, with what it does under it) or listed in a Table. One workflow, three
// views of the same steps.

function WorkflowGraph({ id }: { id: string }) {
  useShowChange();
  const loaded = useScreenLoad(id, {
    loading: { label: 'Loading the workflow', layout: 'preview' },
    read: () => readJson<Graph>(`/work/api/workflows/graph/${encodeURIComponent(id)}`),
    failed: refusal('This workflow could not load'),
  });
  const read = loaded.reload;
  // A run moves on wherever its steps are done (the person's AI, a tool, another tab): the views read themselves again
  // each time the person's store changes, and the board reads its source again the same way.
  useEffect(() => onStoreChange(() => read()), [read]);
  const graph = loaded.value;
  const steps = useMemo<StepRecord[]>(() => (graph ? graph.steps.map(step => ({ ...step, after: [...new Set(graph.edges.filter(edge => edge.to === step.id).map(edge => edge.from))] })) : []), [graph]);
  const fields = useMemo(() => (graph ? stepFields(steps, graph.looks, Boolean(graph.written)) : []), [graph, steps]);
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const workflowId = graph?.workflow_id;
  const title = graph?.title;
  const runId = graph?.run?.run_id;
  // Draw is the board: the workflow's own board, its steps drawn there from the workflow (board-screen
  // `source`), with everything the board does around them. A run draws on the same board, its states on the cards.
  const views = useMemo<RecordView[]>(() => {
    if (!workflowId) return [];
    const source = {
      key: workflowId,
      read: `/work/api/workflows/board/${encodeURIComponent(id)}`,
      write: `/work/api/workflows/board-edit?workflow=${encodeURIComponent(workflowId)}`,
      ...(runId ? { act: `/work/api/workflows/board-act?run=${encodeURIComponent(runId)}` } : {}),
      // Add step on the board: a step or a Marketplace tool, searched as the person types, added where they look.
      // Someone else's workflow takes it in the person's own copy, which opens in its own tab.
      palette: '/work/api/workflows/board-palette',
      add: async (body: Record<string, unknown>) => {
        const added = await post<{ id: string; workflow_id: string; copied: boolean }>(`board-add?workflow=${encodeURIComponent(workflowId)}`, body);
        if (added.copied) openAutomation(added.workflow_id, title ?? '');
        return added;
      },
      add_label: workflowLooks.board_palette.label,
      add_placeholder: workflowLooks.board_palette.placeholder,
    };
    const canvas: RecordView = {
      id: 'canvas', label: 'Draw', icon: 'PenTool', fadeEdges: [],
      render: () => (
        <Container layout="vertical" data-workflow-canvas={id} style={{ height: 'var(--canvas-view-height, max(420px, calc(100dvh - 300px)))' }}>
          <BoardOf boardId={`workflow:${workflowId}`} title={title ?? ''} source={source} />
        </Container>
      ),
    };
    // Every other view any list is offered (the Document, timeline, outline, cards...) draws the same steps too.
    return [canvas, { id: 'table', label: 'Table', icon: 'Table' }];
  }, [workflowId, title, runId, id]);
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const run = graph.run;
  const summary = run
    ? `${run.look?.label ?? run.state}${run.state === 'working' ? `, ${run.steps_left} ${run.steps_left === 1 ? 'step' : 'steps'} left` : ''}${run.error ? `: ${run.error}` : ''}`
    : `Not run yet · made by ${graph.made_by}`;
  // Where this workflow came from and how many were made from it, said only when there is one.
  const lineage = [
    ...(graph.made_from?.length ? [`made from ${graph.made_from.join(', ')}`] : []),
    ...(graph.variations ? [`${graph.variations} ${graph.variations === 1 ? 'variation' : 'variations'}`] : []),
  ].join(' · ');
  // Run starts this workflow and opens the run beside it, where its steps light up as they are done.
  const start = async () => {
    const started = await post<{ run_id: string }>('start-workflow', { workflow_id: run ? graph.workflow_id : id });
    openAutomation(started.run_id, graph.title);
  };
  // Every view edits the one workflow: a step's name or words changed in the Table, or a step added, saves the whole
  // workflow. Someone else's (Trillion's own) is saved as this person's own copy made from it, which opens in its tab.
  const written = graph.written;
  const save = async (next: WrittenStep[]) => {
    if (!written) return;
    const own = graph.yours === true;
    const workflow = { ...written, steps: next, ...(own ? {} : { id: `${written.id}-yours`, made_from: [written.id] }) };
    setSaving(true);
    try {
      await post('save-workflow', { workflow });
      if (own) await read();
      else { notify('Saved as your own workflow', { kind: 'success' }); openAutomation(workflow.id, workflow.label ?? graph.title); }
    } catch (error) {
      notify('This change could not be saved', { kind: 'error', detail: problemOf(error) });
    } finally { setSaving(false); }
  };
  const editStep = (stepId: string, field: string, value: string) => {
    if (!written || !written.steps.some(step => step.id === stepId)) return;
    const key = field === 'title' ? 'title' : field === 'does' ? 'do' : null;
    if (!key || !value.trim()) return;
    void save(written.steps.map(step => (step.id === stepId ? { ...step, [key]: value.trim() } : step)));
  };
  const addStep = () => {
    const words = adding.trim();
    if (!written || !words) return;
    const base = words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'step';
    let stepId = base;
    for (let n = 2; written.steps.some(step => step.id === stepId); n += 1) stepId = `${base}-${n}`;
    const title = words.split(/[.!?\n]/)[0].slice(0, 80);
    setAdding('');
    void save([...written.steps, { id: stepId, title, do: words, submit: { type: 'object' } }]);
  };
  return (
    <Container layout="vertical" height="full" gap="none" minHeight="0" data-workflow-graph={id}>
      <Container layout="horizontal" gap="md" padding="md" alignItems="center" justifyContent="between">
        <Container layout="horizontal" gap="xs" alignItems="center" flex={1} style={{ minWidth: 0 }}>
          {run?.look ? <StatusDot size="sm" status={run.look.tone as never} pulse={run.state === 'working'} /> : null}
          <Text variant="caption" truncate title={graph.job}>{lineage ? `${summary} · ${lineage}` : summary}</Text>
        </Container>
        <Container layout="horizontal" gap="sm" alignItems="center">
          {run?.state === 'working' || !controlShown('automations.run') ? null : <Button size="sm" variant={run ? 'outline' : 'primary'} data-workflow-run onClick={start}>{run ? 'Run again' : 'Run'}</Button>}
        </Container>
      </Container>
      <Container layout="vertical" flex={1} minHeight="0" style={{ overflow: 'auto' }} data-workflow-views={id}>
        <RecordViews
          label={graph.title}
          fields={fields}
          records={steps}
          identify={(step: StepRecord) => step.id}
          views={views}
          view="canvas"
          preferenceKey="trillion-workflow-views"
          detailLevels={null}
          {...(written && controlShown('automations.edit') ? { onEditFieldValue: editStep } : {})}
          {...recordFilter}
          emptyMessage="Nothing matches."
        />
      </Container>
      {written && controlShown('automations.edit') ? (
        <Container padding="md" data-workflow-add-step>
          <NameAndCreate label="What should the next step do?" value={adding} onChange={setAdding} onSubmit={addStep} actionLabel="Add step" disabled={saving || !adding.trim()} />
        </Container>
      ) : null}
    </Container>
  );
}

export function mountWorkflowScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const id = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : '';
  if (!id) {
    mountScreenState(element, { status: 'empty', icon: 'Zap', title: 'Nothing was named to open', description: 'Open an automation from Automations.', action: goTo('Open Automations', 'trillion.workflows') });
    return () => element.replaceChildren();
  }
  const host = document.createElement('div');
  host.className = 'trillion-workflow';
  element.replaceChildren(host);
  const root = createRoot(host);
  root.render(id.startsWith(AUTOMATION) ? <AutomationDetail id={id.slice(AUTOMATION.length)} /> : <WorkflowGraph id={id} />);
  return () => { root.unmount(); element.replaceChildren(); };
}
