// src/workspace/activity-trace-screen.tsx
//
// PURPOSE
//   How this happened: the bounded activity chain and durable receipts from the existing execution, task, effect
//   and Sent owners, in one shared record view. Capture identity, dispatch and independently observed evidence
//   remain separate. A missing receipt cannot establish that no action happened, or identify its original caller.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only evidence returned by the existing trace owner is drawn. No new store, inferred actor or success verdict.
//   2. Exact references survive filtering, copying and opening, including long IDs and ambiguous provider IDs.
//   3. Shared record views own table, cards, filtering and details. Phone starts on cards; preferences remain owned there.
//   4. References open their authorized existing owner/trace. They do not grant access to a sender's private records.
//
// DESIGN REVIEW
//   21st.dev/@moumensoliman/components/interactive-logs-table-shadcnui and
//   21st.dev/@kuratlielia/components/timeline: searchable records with expandable evidence. Existing shared parts
//   supply this behavior. Mobbin incident/activity examples were found, but opening their screens was unavailable.
//   test/record-inspection-flow.test.mjs exercises the shared screen and inspector with explicit fixture data at
//   desktop and phone widths. Release records retain separate evidence of the serving build and live account reads.

import * as React from 'react';
import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { canRetainAfterReadFailure, loadScreen } from '../../parts/ui/show/screen-state';
import { Button } from '../../parts/ui/show/button';
import { readJson } from './api';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { openRow, type ActivityRow, type AppMarks } from './activity-screen';
import { openScreenOn } from './open-screen';
import { traceRows, traceCoverage, ORIGIN_VALUES, CAPTURE_VALUES, DISPATCH_VALUES, OUTCOME_VALUES, OBSERVATION_VALUES } from './activity-trace-view.mjs';
import { mountRecordModelInspection, RecordReference, type ModelRead } from './record-model-inspection';
import { modelLabels, modelPart } from './record-model-view.mjs';

type Step = ActivityRow & { link: string; about: string; because: number | null; depth: number };
type LookupCoverage = Record<string, unknown> & { complete?: boolean; next_cursor?: string | null; more?: boolean; index_complete?: boolean; model_index_complete?: boolean };
type Trace = { item: string | null; steps: Step[]; apps?: AppMarks; records?: { id: string; value: Record<string, unknown> }[]; related_records?: { ref: string; title?: string; via?: string }[]; ambiguous?: boolean;
  coverage?: Record<string, unknown> & { durable?: LookupCoverage; related_records?: LookupCoverage; activity?: Record<string, unknown> & { limit_reached?: boolean } } };
type TracePage = { answer: Trace; cursor: string | null };
type Row = ReturnType<typeof traceRows>[number];
const when = (at: unknown) => typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString() : 'Time not captured';

// A continuation is another bounded current read. De-duplicate exact owner identities, retain earlier evidence
// when a page is empty, and never turn several partial live reads into a complete historical snapshot.
function accumulatedTrace(pages: Trace[]): Trace {
  const last = pages.at(-1)!;
  const unique = <T,>(rows: T[], key: (row: T) => string) => [...new Map(rows.map(row => [key(row), row])).values()];
  return { ...last,
    records: unique(pages.flatMap(page => page.records ?? []), row => row.id),
    steps: unique(pages.flatMap(page => page.steps ?? []), row => JSON.stringify([row.seq, row.at, row.link, row.about, row.because, row.depth])),
    related_records: unique(pages.flatMap(page => page.related_records ?? []), row => JSON.stringify([row.ref, row.via])),
    ambiguous: pages.some(page => page.ambiguous),
    coverage: { ...last.coverage,
      activity: { ...last.coverage?.activity, limit_reached: pages.some(page => page.coverage?.activity?.limit_reached) },
      durable: { ...last.coverage?.durable, complete: pages.length === 1 && last.coverage?.durable?.complete === true,
        ...(pages.some(page => page.coverage?.durable?.index_complete === false) ? { index_complete: false } : {}),
        ...(pages.some(page => page.coverage?.durable?.model_index_complete === false) ? { model_index_complete: false } : {}) },
    },
  };
}

function Reference({ value, current, work = false, names = new Map(), compact = false }: { value: string; current: string; work?: boolean; names?: Map<string, any>; compact?: boolean }) {
  return <RecordReference value={value} current={current} named={names.get(value)} kind={work ? 'work' : 'trace'} compact={compact} />;
}

const linksField = (id: string, label: string, icon: string, current: string, work = false, names = new Map()): FieldDescriptor => ({
  id, label, icon, ruleKind: 'text', filterable: true, width: 320, hiddenByDefault: true, preview: true,
  read: (row: Row) => (row[id] ?? []).join('\n'),
  render: (row: Row) => <span className="flex min-w-0 flex-col gap-1">{(row[id] ?? []).map((value: string) => <span key={value} className="flex min-w-0 flex-col gap-1">
    <Reference value={value} current={current} work={work} names={names} />
    {work ? <span className="text-xs text-muted-foreground">{row.work_associations?.[value] ?? 'Recorded association; source not captured'}</span> : null}
  </span>)}</span>,
});
const detail = (id: string, label: string, icon: string, width = 240): FieldDescriptor => ({ id, label, icon, ruleKind: 'text', filterable: true, width, hiddenByDefault: true, preview: true });

export const traceFields = (current: string, names = new Map()): FieldDescriptor[] => [
  { id: 'label', label: 'What was captured', icon: 'Activity', ruleKind: 'text', filterable: true, sortable: true, width: 250 },
  { id: 'reference_evidence', label: 'Captured references', icon: 'Link', ruleKind: 'text', width: 340, filterable: true, preview: true,
    read: (row: Row) => (row.reference_evidence ?? []).map(reference => `${reference.role}: ${reference.ref} · ${reference.basis_label}`).join('\n'),
    // A table row has one line. The exact receipt opens its complete reference
    // facts, roles and paths through the same inspector as every other record.
    render: (row: Row) => {
      const references = row.reference_evidence ?? [];
      const first = references[0];
      return first ? <span className="flex min-w-0 max-w-full items-center gap-2" title={references.map(reference => `${reference.role} · ${reference.basis_label} · ${reference.path_label}`).join('\n')}>
        <Reference value={first.ref} current={current} names={names} compact />
        {references.length > 1 ? <span className="shrink-0 text-xs text-muted-foreground">+{references.length - 1}</span> : null}
      </span> : null;
    } },
  { id: 'actor', label: 'Recorded actor reference', icon: 'Bot', ruleKind: 'choice', filterable: true, groupable: true, width: 220, preview: true },
  { id: 'recorder', label: 'Recorded by', icon: 'NotebookPen', ruleKind: 'choice', filterable: true, groupable: true, width: 220, preview: true },
  { id: 'outcome', label: 'Outcome', icon: 'MessageCircleWarning', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180, values: OUTCOME_VALUES, preview: true },
  { id: 'origin', label: 'Source origin', icon: 'FlaskConical', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 160, values: ORIGIN_VALUES, preview: true },
  { id: 'effect_origin', label: 'Effect origin', icon: 'FlaskConical', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 160, values: ORIGIN_VALUES, preview: true },
  { id: 'dispatch', label: 'Dispatch result', icon: 'Send', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180, values: DISPATCH_VALUES, preview: true },
  { id: 'account', label: 'Provider account', icon: 'UserRound', ruleKind: 'text', filterable: true, groupable: true, width: 250, preview: true },
  { id: 'independent', label: 'Independent observation', icon: 'ScanEye', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 240, values: OBSERVATION_VALUES, preview: true },
  { id: 'at', label: 'Captured / updated', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 190, preview: true,
    read: (row: Row) => when(row.at), factValue: (row: Row) => Date.parse(row.at) || null, sortValue: (row: Row) => Date.parse(row.at) || 0 },
  { id: 'kind_label', label: 'Evidence record', icon: 'Files', ruleKind: 'choice', filterable: true, groupable: true, width: 180, hiddenByDefault: true, preview: true },
  { id: 'capture', label: 'Capture basis', icon: 'ScanLine', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180, values: CAPTURE_VALUES, hiddenByDefault: true, preview: true },
  detail('actor_basis', 'Actor evidence', 'Fingerprint'),
  detail('capture_coverage', 'Capture coverage', 'ScanLine', 340),
  detail('recorder_basis', 'Recorder evidence', 'Fingerprint'),
  detail('claimed_actor', 'Claimed actor / app', 'MessageSquareQuote'),
  detail('dispatch_basis', 'Dispatch evidence', 'ScanLine'),
  detail('provider', 'Provider', 'Network'),
  detail('provider_object', 'Provider object ID', 'KeyRound', 320),
  detail('route', 'Provider route', 'Route', 300),
  detail('provider_basis', 'Provider evidence', 'ScanLine', 320),
  detail('connection_id', 'Readback connection', 'Network', 300),
  detail('provider_origin', 'Readback provider origin', 'Globe', 300),
  detail('from', 'Recorded From', 'AtSign'),
  detail('reply_to', 'Recorded Reply-To', 'Reply'),
  detail('observed', 'Readback contents', 'ScanEye', 380),
  { ...detail('observation_at', 'Readback time', 'CalendarClock'), read: (row: Row) => row.observation_at ? when(row.observation_at) : '' },
  detail('observation_reason', 'Why observation is unavailable', 'CircleHelp', 340),
  detail('report_author', 'Report author', 'UserRound'),
  detail('report_attribution', 'Report attribution basis', 'Fingerprint'),
  detail('report_summary', 'What was reported', 'MessageSquareQuote', 380),
  { ...detail('report_at', 'Reported observation time', 'CalendarClock'), read: (row: Row) => row.report_at ? when(row.report_at) : '' },
  linksField('source_refs', 'Linked source', 'Link', current, false, names),
  linksField('conversation_refs', 'Recorded conversation reference', 'MessagesSquare', current, false, names),
  linksField('claimed_source_refs', 'Client-supplied source', 'MessageSquareQuote', current, false, names),
  linksField('work_refs', 'Recorded work associations', 'ListChecks', current, true, names),
  detail('work_basis', 'Association evidence', 'Fingerprint', 340),
  linksField('proof_refs', 'Outcome sources', 'ScanEye', current, false, names),
  linksField('task_refs', 'Tool runs', 'Wrench', current, false, names),
  linksField('other_refs', 'Other linked records', 'Link', current, false, names),
  { ...detail('record_ref', 'Exact record reference', 'Fingerprint', 360), render: (row: Row) => row.record_ref ? <Reference value={row.record_ref} current={current} names={names} /> : null },
  { ...detail('corrects', 'Corrects this receipt', 'History', 320), render: (row: Row) => row.corrects ? <Reference value={row.corrects} current={current} names={names} /> : null },
  detail('correction_reason', 'Correction reason', 'MessageCircleWarning', 320),
  detail('note', 'Record note', 'MessageSquareQuote', 380),
  detail('intake_state', 'Intake state', 'Inbox'),
  detail('connection', 'How the step connects', 'Route'),
  detail('distance', 'How far back', 'History'),
  detail('reason', 'Call failure reason', 'CircleAlert', 340),
];

export function mountActivityTraceScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const item = typeof props.surfaceInput?.item === 'string' ? props.surfaceInput.item : '';
  let canonicalItem = item;
  let names = new Map<string, any>();
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let screen: ReturnType<typeof loadScreen<TracePage>> | null = null;
  const pages = new Map<string, Trace>();
  let readCursor: string | null = null;
  let loadingMore = false, pageFailed = false, disposed = false;
  const details = document.createElement('div');
  details.className = 'min-w-0';
  const list = document.createElement('div');
  list.className = 'trillion-activity';
  const captureHeading = document.createElement('h2');
  captureHeading.className = 'mt-6 mb-3 text-lg font-semibold';
  captureHeading.textContent = 'Captured work';
  element.replaceChildren(details, captureHeading, list);

  const drawPages = () => {
      const answer = accumulatedTrace([...pages.values()]);
      const rows = traceRows(answer);
      for (const named of answer.related_records ?? []) if (!names.has(named.ref)) names.set(named.ref, named);
      const next = answer.coverage?.durable?.next_cursor;
      const options = {
        label: 'How this happened', ...recordFilter,
        fields: traceFields(canonicalItem, names), records: rows, identify: (row: Row) => row.id,
        preferenceKey: 'trillion-activity-trace',
        views: [{ id: 'table', label: 'Table' }, { id: 'board', label: 'Board' }, { id: 'gallery', label: 'Cards' }],
        defaultView: window.matchMedia('(max-width: 600px)').matches ? 'gallery' : 'table',
        detailLevels: { default_level: 'evidence', levels: [
          { id: 'evidence', label: 'Evidence', fields: 9, tile_px: 300 },
          { id: 'brief', label: 'A few details', fields: 3, tile_px: 240 },
          { id: 'names', label: 'Names only', fields: 0, tile_px: 160 },
        ] },
        status: <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-muted-foreground" role="status">{traceCoverage(answer).text}</p>
          {pageFailed ? <p className="text-sm text-muted-foreground" role="status">More captured work could not load. The pages already read are still shown.</p> : null}
          {next || pages.size > 1 ? <div className="flex flex-wrap items-center gap-2">
            {next ? <Button type="button" variant="outline" size="sm" work={null} loading={loadingMore} pendingLabel="Reading more" onClick={async () => {
              if (loadingMore || !screen) return;
              loadingMore = true; pageFailed = false; readCursor = next;
              drawPages();
              try { await screen.reload(); }
              finally { loadingMore = false; if (!disposed && views && pages.size) drawPages(); }
            }}>{pageFailed ? 'Retry more captured work' : 'Load more captured work'}</Button> : null}
            <span className="text-xs text-muted-foreground">{pages.size} {pages.size === 1 ? 'page' : 'pages'} loaded. Historical coverage remains incomplete.</span>
          </div> : null}
        </div>,
        onOpen: (id: string) => {
          const row = rows.find(one => one.id === id);
          if (row?.raw_step) {
            if (!(row.raw_step.item === canonicalItem && !row.raw_step.opens)) openRow(row.raw_step);
          } else if (row?.kind === 'task' && row.task_refs[0]) openScreenOn('trillion.workshop-run', { id: row.task_refs[0] });
          else if (row?.record_ref && row.record_ref !== canonicalItem) openScreenOn('trillion.activity-trace', { item: row.record_ref }, row.label);
        },
        emptyMessage: rows.length ? 'No captured evidence matches these filters.' : 'No captured evidence on the pages read so far.',
      };
      if (views) views.update(options); else views = mountRecordViews(list, options);
  };
  const acceptPage = ({ answer, cursor }: TracePage) => {
    if (answer.coverage?.durable?.private_reach_required) pages.clear();
    pages.set(cursor ?? '', answer);
    pageFailed = false;
    drawPages();
  };
  const startTrace = (model: ModelRead | null) => {
    const nextItem = model?.id ?? item;
    names = modelLabels(model ?? {});
    const changed = canonicalItem !== nextItem;
    canonicalItem = nextItem;
    if (screen) {
      if (!changed) return;
      screen.dispose(); screen = null;
      pages.clear(); readCursor = null; pageFailed = false; loadingMore = false;
    }
    screen = loadScreen<TracePage>(list, {
      loading: { label: 'Reading the captured evidence', layout: 'rows' },
      read: async () => {
        const target = canonicalItem, cursor = readCursor;
        const answer = await readJson<Trace>(`/work/api/activity/trace?${new URLSearchParams({ item: target, ...(cursor ? { cursor } : {}) })}`);
        if (answer.item !== target) throw new Error('The trace owner returned another record.');
        return { answer, cursor };
      },
      empty: ({ answer, cursor }) => !cursor && traceCoverage(answer).empty && !answer.coverage?.durable?.next_cursor ? {
        status: 'empty', icon: 'Route', title: 'No source evidence found in this read', description: traceCoverage(answer).text,
      } : null,
      failed: (error, retry) => {
        if (!canRetainAfterReadFailure(error)) { pages.clear(); readCursor = null; pageFailed = false; }
        return refusal('How this happened could not load')(error, retry);
      },
      laterFailure: () => { pageFailed = true; if (pages.size && views) drawPages(); },
      clear: () => { views?.destroy(); views = null; },
      draw: acceptPage,
      update: acceptPage,
    });
  };
  const stopDetails = mountRecordModelInspection(details, item, { part: modelPart(props.surfaceInput?.part), resolved: startTrace });
  return () => { disposed = true; stopDetails(); screen?.dispose(); pages.clear(); element.replaceChildren(); };
}
