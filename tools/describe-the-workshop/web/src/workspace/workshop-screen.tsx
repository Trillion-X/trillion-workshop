// src/workspace/workshop-screen.tsx
//
// PURPOSE
//   Runs, and one tool or run opened: every run of a tool the person's AI started, and what it made, so a person sees
//   how their AI's work went without asking it. Where tools are found, opened and published is the Marketplace
//   (marketplace-screen.tsx); this file draws what the Marketplace opens and what a run left behind. Three screens:
//   - Runs (entry `workshop`, at /runs and the older /workshop): every run this person started, newest first, with
//     how each ended, as a table or a board.
//   - One tool (entry `workshop-tool`, its id in the tab's input): what it does, the numbers from every account's
//     runs, what it needs, and this person's runs of it. The Marketplace opens a tool here.
//   - One run (entry `workshop-run`): how it ended in the shared run card, what it returned through the schema-aware
//     value view, the files it made (each opens in its own tab), and what the person said about it.
//   Every read goes through /work/api/workshop (src/work-workshop.mjs) to the person's own store, the same store
//   their AI runs tools through, so the screen and the AI always agree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every tool and run is one the store answered; an empty list says so in words.
//   2. Blind: every word a fact is said in (who made it, where it runs, states, tones, icons) comes from the Worker's
//      answer (src/workshop-looks.json); this file names no tool, place, maker or state.
//   3. Every element is a shared component (record views, listing cards, tabs, the guide, the shared empty, loading
//      and plan states); this file writes no markup.
//   4. Tools and runs change outside this page, so each screen reads again when the page is shown again.

import React, { useMemo, useState } from 'react';
import { RecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import type { Listing } from '../../parts/ui/show/listing-card';
import { Container, RunCard, SchemaValueView, Text, type JsonSchema, type StatusTone } from '../../parts/ui';
import { ActionForm, DEFAULT_FIELD_RENDERERS } from '../../parts/ui/show/action-affordance';
import { Button } from '../../parts/ui/show/coss/ui/button';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { loadScreen, mountScreenState } from '../../parts/ui/show/screen-state';
import type { GuideRow, GuideSection } from '../../parts/ui/show/coss/guide';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { recordFilter } from './record-filter';
import { readJson, postJsonByKey } from './api';
import { askFor, refusal } from './failure';
import { goTo, openFile } from './open-screen';
import { guideScreen, LOCAL, type Act } from './guide-screen';
import { inputFields, inputOf, type ToolInput, type ToolInputSchema } from './tool-inputs';
import looks from '../workshop-looks.json';

const own = looks.own_tool;

type Tone = { label: string; tone?: string };
type Tool = Listing & { made_by: string; shareable?: boolean; own?: boolean; has_screen?: boolean; service: string; runs_on: string[]; worked: string; runs: number };
type Run = { id: string; tool_id: string; title: string; job: string | null; state: string; tone: string; reported: string; started_at: string | null; finished_at?: string; seconds?: number; runs_on?: string; error?: string };
type Shelf = { tools: Tool[]; runs: Run[]; tags: { state: Record<string, { tone: string }> } };
type Input = { name: string; label: string; about: string | null; status: Tone };
type ToolPage = { tool: Tool; about: string | null; inputs: Input[]; tiles: { id: string; label: string; value: string; icon?: string; tone?: string }[]; runs: Run[] };
type MissingInputField = { name: string; label?: string; about?: string | null; schema: JsonSchema };
type PendingInput = { kind: 'missing_required_inputs'; version: string; fields: MissingInputField[]; run_url?: string; submit?: string };
type RunPage = { id: string; title: string; job: string | null; state: string; pending_input?: PendingInput; can_report?: boolean; tone: string; status_tone: StatusTone; started_at: string | null; finished_at?: string; seconds?: number; runs_on?: string; error?: string; problems?: string[]; output?: unknown; output_schema?: JsonSchema; files: { name: string; identity: string; media_type: string | null; bytes: number | null }[]; reports: { said: string; tone: string; summary: string; at: string; source_ref?: string; answered_by?: string }[] };

const API = '/work/api/workshop';
const open = (id: string, title: string, surfaceInput: Record<string, unknown>) => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id, title, surfaceInput } }));
const openRun = (run: { id: string; title: string }) => open('trillion.workshop-run', run.title, { id: run.id });
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const took = (seconds: number | undefined) => (seconds === undefined ? '' : seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 6) / 10} min`);
const size = (bytes: number | null) => (bytes === null ? '' : bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${Math.round(bytes / 1e5) / 10} MB`);

const runFields = (tags: Shelf['tags']): FieldDescriptor[] => [
  { id: 'title', label: 'Tool', icon: 'Wrench', ruleKind: 'text', filterable: true, sortable: true, groupable: true, width: 220 },
  { id: 'state', label: 'How it ended', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170, values: tags.state },
  { id: 'job', label: 'What it was for', icon: 'Target', ruleKind: 'text', filterable: true, width: 340 },
  { id: 'started_at', label: 'Started', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 180, read: (run: Run) => when(run.started_at), factValue: (run: Run) => (run.started_at ? Date.parse(run.started_at) : 0), sortValue: (run: Run) => (run.started_at ? Date.parse(run.started_at) : 0) },
  { id: 'seconds', label: 'Took', icon: 'Timer', ruleKind: 'number', sortable: true, width: 90, read: (run: Run) => took(run.seconds), sortValue: (run: Run) => run.seconds ?? 0 },
  { id: 'reported', label: 'Reported outcome', icon: 'MessageSquare', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 200 },
];


function Runs({ shelf }: { shelf: Shelf }) {
  const byId = useMemo(() => new Map(shelf.runs.map(run => [run.id, run])), [shelf.runs]);
  return (
    <Container layout="vertical" height="full" gap="none" minHeight="0">
      <RecordViews
        label="Runs"
        fields={runFields(shelf.tags)}
        records={shelf.runs}
        identify={(run: Run) => run.id}
        views={[{ id: 'table', label: 'Table', icon: 'Table' }, { id: 'board', label: 'Board', icon: 'Columns3' }]}
        view="table"
        onOpen={id => { const run = byId.get(id); if (run) openRun(run); }}
        preferenceKey="trillion-workshop-runs"
        {...recordFilter}
        emptyMessage={shelf.runs.length ? 'No run matches.' : 'No runs yet. When your AI runs a tool, the run shows here with how it ended.'}
      />
    </Container>
  );
}

export function mountWorkshopScreen(element: HTMLElement): () => void {
  const host = document.createElement('div');
  host.className = 'trillion-workshop';
  element.replaceChildren(host);
  const screen = loadScreen(host, {
    loading: { label: 'Loading your runs', layout: 'gallery' },
    read: () => readJson<Shelf>(`${API}?runs_only=true`),
    empty: shelf => (shelf.runs.length ? null : {
      status: 'empty', icon: 'History', title: 'No runs yet',
      description: 'When your AI runs a tool, the run shows here with how it ended and what it made. Find tools in the Marketplace.',
      action: goTo('Open the Marketplace', 'trillion.marketplace'),
      ask: askFor('runs'),
    }),
    failed: refusal('Your runs could not load'),
    draw: shelf => mountSharedContent(host, <Runs shelf={shelf} />),
  });
  const onVisible = () => { if (document.visibilityState === 'visible') void screen.reload(); };
  document.addEventListener('visibilitychange', onVisible);
  return () => { document.removeEventListener('visibilitychange', onVisible); screen.dispose(); element.replaceChildren(); };
}

const runRows = (runs: Run[], act: Act): GuideRow[] => runs.map(run => ({
  id: run.id,
  title: run.job ?? run.title,
  detail: [when(run.started_at), took(run.seconds), run.error].filter(Boolean).join(' · '),
  status: { label: run.state, tone: run.tone },
  actions: [act({ label: 'Open', tone: 'quiet', icon: 'ArrowUpRight' }, async () => { openRun(run); })],
}));

export function mountWorkshopToolScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const id = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : '';
  if (!id) {
    mountScreenState(element, { status: 'empty', icon: 'Wrench', title: 'No tool was named', description: 'Open a tool from the Marketplace.', action: goTo('Open the Marketplace', 'trillion.marketplace') });
    return () => element.replaceChildren();
  }
  // A tool the person removed here says so in its place, with where to find others.
  let removed: string | null = null;
  const screen = guideScreen(element, 'Loading the tool', async act => {
    if (removed) return { status: 'empty', icon: 'Trash2', title: own.removed_title.replace('{title}', removed), description: own.removed_about, action: goTo(own.open_marketplace, 'trillion.marketplace') };
    const page = await readJson<ToolPage>(`${API}/tool/${encodeURIComponent(id)}`);
    const { tool } = page;
    const sections: GuideSection[] = [
      { profile: { name: tool.title, tag: tool.badge?.label ?? tool.byline, detail: page.about ?? tool.text, facts: [{ label: 'Made by', value: tool.byline ?? '', icon: 'UserRound' }, ...(tool.facts ?? []), ...(tool.value ? [{ label: 'Price', value: tool.valueLabel ?? `${tool.value}${tool.unit ?? ''}`, icon: 'Receipt' }] : []), ...(tool.signal ? [{ label: 'Did it work', value: tool.signal.label, icon: 'ThumbsUp' }] : [])] },
        // One of this person's own tools opens the one share sheet: a space, named people, a link for a time, by email or text.
        // Their own tool is also renamed (asked in place) and removed (after a confirmation) here, through the same
        // save and delete an AI uses (src/work-workshop.mjs /tool/<id>/rename, /delete-tool/<id>).
        actions: [
          // Its own screen opens as its sidebar row does: the placeable screen whose id is the tool's id (toolSurfaces).
          ...(tool.has_screen ? [act({ label: 'Open', tone: 'quiet', icon: 'ArrowUpRight' }, async () => { open(id, tool.title, { tool_id: id }); return LOCAL; })] : []),
          ...(tool.shareable ? [act({ label: 'Share', tone: 'quiet', icon: 'Share2' }, async () => { (await import('./sharing-sheet')).openSharing(id, { title: tool.title, anchor: document.activeElement }); return LOCAL; })] : []),
          ...(tool.own ? [
            act({ label: own.rename, tone: 'quiet', icon: 'Pencil', send: { path: '', ask: { name: 'label', label: own.rename_ask, value: tool.title } } }, async values => {
              await readJson(`${API}/tool/${encodeURIComponent(id)}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: values.label }) });
            }),
            act({ label: own.remove, tone: 'danger', icon: 'Trash2', send: { path: '', confirm: own.remove_confirm.replace('{title}', tool.title) } }, async () => {
              await readJson(`${API}/delete-tool/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              removed = tool.title;
              return LOCAL;
            }),
          ] : []),
        ] },
      { stats: page.tiles },
      { heading: 'What it needs', ...(page.inputs.length ? { rows: page.inputs.map(input => ({ id: input.name, title: input.label, detail: input.about ?? undefined, status: input.status })) } : { note: 'It needs nothing to run.' }) },
      { heading: 'Your runs', ...(page.runs.length ? { rows: runRows(page.runs, act) } : { note: 'You have not run this tool yet. Ask your AI to use it for a job.' }) },
    ];
    return { title: tool.title, hide_header: true, sections };
  });
  return () => screen.unmount();
}

const RUN_READ_AGAIN_MS = 4000;

function RunSummary({ run }: { run: RunPage }) {
  const outputs = [
    ...(run.runs_on ? [{ key: 'runs_on', label: 'Where it ran', value: run.runs_on, priority: 1 }] : []),
    ...(run.started_at ? [{ key: 'started_at', label: 'Started', value: when(run.started_at), priority: 2 }] : []),
    ...(run.seconds !== undefined ? [{ key: 'seconds', label: 'Took', value: took(run.seconds), priority: 3 }] : []),
  ];
  const error = [run.error, ...(run.problems ?? [])].filter(Boolean).join('\n') || null;
  // The state arrives in the person's words with its tone (src/workshop-looks.json run_states and status_tones).
  const overrides = { [run.state.toLowerCase()]: { label: run.state, tone: run.status_tone } };
  return <RunCard title={run.title} detail={run.job} status={run.state} statusOverrides={overrides} outputs={outputs} errorMessage={error} />;
}

function RunResult({ run }: { run: RunPage }) {
  return <SchemaValueView value={run.output} schema={run.output_schema} />;
}

type RunOutcomeSubmission = Readonly<{ result: string; summary: string; request_key: string }>;
type RunOutcomeAcknowledgement = { task_id: string; source_ref: string; report: { source_ref: string; result: string; summary: string }; source_capture?: { state?: string } };
const reportForm = looks.outcome_report_form;
const missingInputWords = looks.missing_input;
const inputFieldContract = (schema: unknown, ignoreEnum = false): string => {
  const withoutPresentation = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutPresentation);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['title', 'description', '$comment', 'examples', ...(ignoreEnum ? ['enum'] : [])].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, withoutPresentation(item)]));
  };
  return JSON.stringify(withoutPresentation(schema)) ?? '';
};

type MissingInputSubmission = Readonly<{ input_version: string; replay_key: string; input: Record<string, unknown>; answers: Record<string, string | string[]> }>;
type MissingInputAcknowledgement = { task_id: string; state: string; pending_input?: PendingInput | null };

/** Keep one exact answer and replay key until the owner confirms this task resumed. */
export function createMissingInputResponder(taskId: string, send: (body: Omit<MissingInputSubmission, 'answers'>) => Promise<MissingInputAcknowledgement>, nextKey: () => string = () => crypto.randomUUID()) {
  let pending: MissingInputSubmission | null = null;
  let pendingSchema: ToolInputSchema | null = null;
  let draftAnswers: Record<string, string | string[]> = {};
  let active: Promise<MissingInputAcknowledgement> | null = null;
  let observed: { version: string; schema: ToolInputSchema } | null = null;
  const freeze = <T,>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(item => freeze(item));
      Object.freeze(value);
    }
    return value;
  };
  const keepCompatible = (from: ToolInputSchema | null, to: ToolInputSchema, values: Record<string, string | string[]>) => {
    const kept: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(values)) {
      const before = from?.properties?.[name], after = to.properties?.[name];
      if (!before || !after) continue;
      const exact = inputFieldContract(before) === inputFieldContract(after);
      const enumOnly = inputFieldContract(before, true) === inputFieldContract(after, true);
      if (!exact && (!enumOnly || (Array.isArray(after.enum) && !after.enum.some(option => String(option) === String(value))))) continue;
      if (Array.isArray(after.enum) && !after.enum.some(option => String(option) === String(value))) continue;
      try { inputOf({ properties: { [name]: after }, required: [name] }, { [name]: value }); }
      catch { continue; }
      kept[name] = Array.isArray(value) ? [...value] : value;
    }
    return kept;
  };
  const reconcile = () => {
    const next = observed;
    observed = null;
    if (!next || !pending || pending.input_version === next.version) return;
    // A new contract makes the old replay key unusable. Keep only answers that
    // still have the same typed field contract; the next press gets a fresh key.
    draftAnswers = keepCompatible(pendingSchema, next.schema, pending.answers);
    pending = null;
    pendingSchema = null;
  };
  return {
    get pending() { return pending; },
    get answers() { return draftAnswers; },
    observe(version: string, schema: ToolInputSchema) {
      observed = { version, schema };
      if (!active) reconcile();
    },
    resumed() { pending = null; pendingSchema = null; draftAnswers = {}; observed = null; },
    submit(version: string, schema: ToolInputSchema, answers: Record<string, string | string[]>): Promise<MissingInputAcknowledgement> {
      const input = inputOf(schema, answers);
      if (pending && (pending.input_version !== version || JSON.stringify(pending.answers) !== JSON.stringify(answers))) {
        return Promise.reject(new Error(missingInputWords.retry_unchanged));
      }
      if (active) return active;
      const savedAnswers = Object.fromEntries(Object.entries(answers).map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]));
      if (!pending) {
        pendingSchema = schema;
        pending = Object.freeze({ input_version: version, replay_key: nextKey(), input: freeze(input), answers: freeze(savedAnswers) });
      }
      draftAnswers = pending.answers;
      const body = pending;
      active = Promise.resolve().then(() => send({ input_version: body.input_version, replay_key: body.replay_key, input: body.input })).then(answer => {
        if (answer?.task_id !== taskId) throw new Error(missingInputWords.unconfirmed);
        if (answer.state !== 'waiting_for_input') { pending = null; pendingSchema = null; draftAnswers = {}; }
        return answer;
      }).finally(() => { active = null; reconcile(); });
      return active;
    },
  };
}

const missingInputSchema = (pending: PendingInput | undefined): ToolInputSchema | null => {
  if (pending?.kind !== 'missing_required_inputs' || typeof pending.version !== 'string' || !pending.version || !Array.isArray(pending.fields)) return null;
  const fields = pending.fields.filter(field => field && typeof field.name === 'string' && field.name && field.schema && typeof field.schema === 'object');
  if (fields.length !== pending.fields.length || !fields.length || new Set(fields.map(field => field.name)).size !== fields.length) return null;
  return { properties: Object.fromEntries(fields.map(field => [field.name, field.schema])) as ToolInputSchema['properties'], required: fields.map(field => field.name) };
};

/** Keep the exact pending report until its owner acknowledges it. A retry never reruns the tool or changes its words. */
export function createRunOutcomeReporter(taskId: string, send: (body: RunOutcomeSubmission) => Promise<unknown>, nextKey: () => string = () => crypto.randomUUID()) {
  let pending: RunOutcomeSubmission | null = null;
  let active: Promise<RunOutcomeAcknowledgement> | null = null;
  return {
    get pending() { return pending; },
    submit(answers: Record<string, unknown>): Promise<RunOutcomeAcknowledgement> {
      const result = typeof answers.result === 'string' ? answers.result : '';
      const summary = typeof answers.summary === 'string' ? answers.summary.trim() : '';
      if (!reportForm.fields.find(field => field.id === 'result')?.options?.some(option => option.value === result)) return Promise.reject(new Error(reportForm.choose_result));
      if (!summary || summary.length > 4000) return Promise.reject(new Error(reportForm.summary_length));
      if (pending && (pending.result !== result || pending.summary !== summary)) return Promise.reject(new Error(reportForm.retry_unchanged));
      if (active) return active;
      pending ??= Object.freeze({ result, summary, request_key: nextKey() });
      const body = pending;
      active = Promise.resolve().then(async () => {
        const answer = await send(body) as RunOutcomeAcknowledgement | null;
        if (answer?.task_id !== taskId || typeof answer.source_ref !== 'string' || !answer.source_ref || answer.report?.source_ref !== answer.source_ref
          || answer.report.result !== body.result || answer.report.summary !== body.summary) throw new Error(reportForm.unconfirmed);
        pending = null;
        return answer;
      }).finally(() => { active = null; });
      return active;
    },
  };
}

function RunOutcomeReport({ reporter, onSaved }: { reporter: ReturnType<typeof createRunOutcomeReporter>; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<'saved' | 'source_incomplete' | null>(null);
  const locked = busy || reporter.pending !== null;
  return <Container layout="vertical" gap="sm">
    <Text variant="caption">{reportForm.about}</Text>
    {saved ? <Text variant="caption" role="status">{reportForm[saved]}</Text> : null}
    {reporter.pending && !busy ? <Text variant="caption">{reportForm.retry_note}</Text> : null}
    <Button variant="outline" work={null} disabled={busy} onClick={() => { setSaved(null); setOpen(true); }}>
      {reporter.pending ? reportForm.retry : reportForm.action}
    </Button>
    {open ? <ActionForm
      open title={reportForm.title} fields={reportForm.fields} initialValues={reporter.pending ?? undefined}
      submitLabel={reporter.pending ? reportForm.retry : reportForm.submit}
      renderers={{
        text: context => DEFAULT_FIELD_RENDERERS.text({ ...context, disabled: locked }),
        select: context => locked
          ? <Text variant="caption">{context.options.find(option => option.value === context.value)?.label ?? ''}</Text>
          : DEFAULT_FIELD_RENDERERS.select(context),
      }}
      onCancel={() => { if (!busy) setOpen(false); }}
      onSubmit={async answers => {
        setBusy(true);
        try {
          const answer = await reporter.submit(answers);
          setOpen(false);
          setSaved(answer.source_capture?.state === 'incomplete' ? 'source_incomplete' : 'saved');
          await onSaved();
        } finally { setBusy(false); }
      }}
    /> : null}
  </Container>;
}

export function mountWorkshopRunScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const id = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : '';
  if (!id) {
    mountScreenState(element, { status: 'empty', icon: 'Wrench', title: 'No run was named', description: 'Open a run from Runs.', action: goTo('Open Runs', 'trillion.workshop') });
    return () => element.replaceChildren();
  }
  // A run still working is read again every few seconds, so the page shows how it ends without being reopened.
  let again: ReturnType<typeof setTimeout> | undefined;
  let shown: RunPage | null = null;
  let readOwnerAfterReport = false;
  // Kept outside the guide part so a read/redraw cannot discard an unacknowledged submission.
  const reporter = createRunOutcomeReporter(id, body => postJsonByKey(`${API}/run/${encodeURIComponent(id)}/result`, body));
  const inputResponder = createMissingInputResponder(id, body => readJson<MissingInputAcknowledgement>(`${API}/run/${encodeURIComponent(id)}/input`, { method: 'POST', body: JSON.stringify(body) }, true));
  const screen = guideScreen(element, 'Loading the run', async act => {
    const run = await readJson<RunPage>(`${API}/run/${encodeURIComponent(id)}`, readOwnerAfterReport ? { method: 'GET' } : {}, readOwnerAfterReport);
    readOwnerAfterReport = false;
    shown = run;
    if (run.state !== 'waiting_for_input') inputResponder.resumed();
    clearTimeout(again);
    if (!run.finished_at && !run.error) again = setTimeout(() => void screen.reload(), RUN_READ_AGAIN_MS);
    const pendingInput = run.state === 'waiting_for_input' ? run.pending_input : undefined;
    const schema = missingInputSchema(pendingInput);
    if (pendingInput && schema) inputResponder.observe(pendingInput.version, schema);
    const inputSection = pendingInput && schema ? (() => {
      const inputs: Record<string, ToolInput> = Object.fromEntries(pendingInput.fields.map(field => [field.name, {
        ...(field.label ? { label: field.label } : {}),
        ...(field.about ? { placeholder: field.about } : {}),
      }]));
      const fields = inputFields(schema, inputs, { includeComplex: true }).map(field => {
        const value = inputResponder.answers[field.name];
        const contract = inputFieldContract(pendingInput.fields.find(item => item.name === field.name)?.schema, true);
        if (value === undefined) return { ...field, input_contract: contract };
        return Array.isArray(value) ? { ...field, input_contract: contract, values: value } : { ...field, input_contract: contract, value };
      });
      const submit = act({ label: inputResponder.pending ? missingInputWords.retry : missingInputWords.submit, tone: 'primary', icon: 'ArrowRight', busy_label: missingInputWords.submitting, send: { path: 'missing-input', with_fields: true } }, async answers => {
        await inputResponder.submit(pendingInput.version, schema, answers);
      });
      return { heading: missingInputWords.heading, rows: [{ id: 'missing-input', title: missingInputWords.title, detail: inputResponder.pending ? missingInputWords.retry_note : missingInputWords.about, fields, starts_open: true, actions: [submit] }] };
    })() : null;
    const sections: GuideSection[] = [
      { part: 'run-summary' },
      ...(inputSection ? [inputSection] : []),
      ...(run.output !== undefined ? [{ heading: 'What it returned', part: 'run-result' }] : []),
      ...(run.files.length ? [{ heading: 'Files it made', rows: run.files.map(file => ({ id: file.identity, title: file.name, detail: [file.media_type, size(file.bytes)].filter(Boolean).join(' · '), actions: [act({ label: 'Open', tone: 'quiet', icon: 'ArrowUpRight' }, async () => { openFile({ id: file.identity, name: file.name, type: file.media_type }); })] })) }] : []),
      { heading: 'Reported outcomes', ...(run.reports.length ? { rows: run.reports.map((report, index) => ({ id: report.source_ref ?? `${report.at}:${index}`, title: report.summary, detail: when(report.at), status: { label: report.said, tone: report.tone } })) } : { note: 'There is no report of the actual outcome yet. A completed run shows that execution finished; its real result is recorded separately.' }) },
      ...(run.can_report ? [{ part: 'run-outcome-report' }] : []),
    ];
    return { title: run.title, hide_header: true, sections };
  }, {
    parts: {
      'run-summary': () => shown ? <RunSummary run={shown} /> : null,
      'run-result': () => shown ? <RunResult run={shown} /> : null,
      'run-outcome-report': () => shown?.can_report ? <RunOutcomeReport reporter={reporter} onSaved={async () => { readOwnerAfterReport = true; await screen.reload(); }} /> : null,
    },
  });
  return () => { clearTimeout(again); screen.unmount(); };
}
