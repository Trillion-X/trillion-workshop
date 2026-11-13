// src/workspace/controls-screen.tsx
//
// PURPOSE
//   An interface of live controls an AI made for one thing a person wants to adjust (make_controls,
//   src/made-controls.mjs), opened at /controls/<id>. It reads the interface from its records (no AI, no generation),
//   draws its controls with the shared tuning panel beside the tool's own preview (controls-previews.tsx), and lets the
//   person move them: the preview changes at once, Undo and Redo step back and forth, Reset returns to where it started,
//   and the values settled on are kept. Keeping a full copy runs the tool once with those values; what comes back is
//   kept with the interface and shown in the same preview.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a tool, an input or a kind of preview. Rows, preview and the keep button's words come
//      from the interface's read.
//   2. Each control and the interface itself show only as the person's show rules say (show-of.ts: subject `control`
//      with { interface, input, tool }, subject `controls` with { interface, tool }).
//   3. Moving a control never runs the tool; only the keep button does, once per press, under its own request key.
//   4. Every change is one step of the shared history (canvas-history), so Undo and Redo are the same everywhere.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button, Card, Container, Input, Text } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { TuningPanel, type TuningSetting, type TuningValue } from '../../parts/ui/show/tuning-panel';
import { useCanvasHistory } from '../../parts/ui/show/canvas-history';
import { createSettledWrite } from '../../parts/ui/show/tuning-panel/settled-write.mjs';
import { OpenChoice } from '../../parts/ui/show/choice-tiles';
import { showOf, useShowChange } from '../../parts/ui/show/show-rules/show-of';
import { postJson, readJson } from './api';
import { onStoreChange } from './store-changes';
import { forgetQuietDeviceDraftIfValue, keepQuietDeviceDraft, readQuietDeviceDraft } from './quiet-writes';
import { askYourAi, reasonOf, refusal } from './failure';
import { ControlsPreview, supportsControlsPreview, type Kept } from './controls-previews';
import { projectViewInputs, projectedInput, requiredControlSubjects } from '../../../made-controls.mjs';
import { evaluateFormula } from './list-targets';

type Row = TuningSetting & { key: string };
type DeviceDraft = { values: Record<string, TuningValue>; based_on: Record<string, TuningValue> };
type Interface = {
  interface_id: string; title: string; intent: string;
  tool: { id: string; label: string; input_schema?: Record<string, unknown> };
  subject: string[]; rows: Row[]; all_rows?: Row[]; defaults: Record<string, unknown>;
  semantic_settings?: Row[];
  input_schema?: Record<string, unknown>;
  projected_input?: Record<string, unknown>;
  views?: { id: string; tool_id: string; label: string; preview: Record<string, unknown>; input_schema?: Record<string, unknown>; inputs: Record<string, { from: 'input' | 'values' | 'bind'; key: string }> }[];
  preview: Record<string, unknown>; commit: { label?: string; busy_label?: string; done_label?: string; takes?: string }; result: { file?: string };
  runs: boolean; layout: string | null;
  recovered_values?: boolean;
  server_values?: Record<string, unknown>;
  device_draft?: DeviceDraft;
  conflicting_draft?: DeviceDraft;
  state: { bind: Record<string, unknown>; values: Record<string, unknown>; kept: Kept[]; pending?: { task_id?: string | null; request_key: string; values: Record<string, unknown>; terminal?: boolean } | null; last_error?: string | null };
};

const POLL_MS = 2000;
const SAVE_AFTER_MS = 600;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const definitionOf = (found: Interface) => ({
  title: found.title, intent: found.intent, tool: found.tool, subject: found.subject, rows: found.rows,
  defaults: found.defaults, preview: found.preview, commit: found.commit, result: found.result,
  runs: found.runs, layout: found.layout,
  input_schema: found.input_schema, semantic_settings: found.semantic_settings, views: found.views,
});

/** Where each control starts: the person's own settled value, else the interface's, else the tool's neutral one. */
function startingValues(found: Interface): Record<string, TuningValue> {
  return Object.fromEntries(found.rows.map(row => [row.key, (found.state.values[row.key] ?? found.defaults[row.key] ?? row.default_value) as TuningValue]));
}

function Controls({ found: initial, refresh }: { found: Interface; refresh: () => Promise<void> }) {
  const [found, setFound] = React.useState(initial);
  useShowChange();
  const history = useCanvasHistory(200);
  const starting = React.useMemo(() => startingValues(found), [found.interface_id]);
  const [values, setValues] = React.useState<Record<string, TuningValue>>(starting);
  const [projection, setProjection] = React.useState<{ input: Record<string, unknown>; views: Record<string, Record<string, unknown>>; viewMissing?: Record<string, string[]>; error?: string } | null>(null);
  const [projectionPending, setProjectionPending] = React.useState(true);
  const [kept, setKept] = React.useState<Kept[]>(found.state.kept ?? []);
  const [pending, setPending] = React.useState(found.state.pending?.terminal ? null : found.state.pending ?? null);
  const [busy, setBusy] = React.useState(false);
  const [retryRun, setRetryRun] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [definition, setDefinition] = React.useState({ title: found.title, settings: found.rows.map(row => row.key), layout: found.layout ?? 'beside' });
  const [editError, setEditError] = React.useState('');
  const [said, setSaid] = React.useState('');
  const [saveError, setSaveError] = React.useState('');
  const [runError, setRunError] = React.useState(found.state.last_error ?? '');
  const [conflictingDraft, setConflictingDraft] = React.useState(found.conflicting_draft ?? null);
  const currentFound = React.useRef(found);
  currentFound.current = found;
  const reconciledRead = React.useRef<Interface | null>(null);
  const mounted = React.useRef(true);
  const requestKey = React.useRef<string | null>(null);
  const latest = React.useRef(values);
  latest.current = values;
  const keptRef = React.useRef(kept);
  keptRef.current = kept;
  const clearHistory = history.clear;
  const accepted = React.useRef(startingValues({ ...found, state: { ...found.state, values: found.server_values ?? found.state.values } }));
  const localDraft = React.useRef<DeviceDraft | null>(found.device_draft ?? null);
  const stepStart = React.useRef<{ key: string; from: TuningValue; to: TuningValue; at: number } | null>(null);
  const id = found.interface_id;
  const projectionRows = React.useMemo(() => ({
    settings: (found.all_rows ?? found.rows).filter(row => !(found.semantic_settings ?? []).some(semantic => semantic.key === row.key)),
    semantic_settings: found.semantic_settings ?? found.rows.filter(row => Boolean((row as Row & { schema?: unknown }).schema)),
    input_schema: found.input_schema ?? found.tool.input_schema ?? {},
    subject: found.subject,
  }), [found.all_rows, found.rows, found.semantic_settings, found.input_schema, found.tool.input_schema, found.subject]);

  // A projection is the one input contract for the primary preview, composed screens and Keep. Keep the last valid
  // picture mounted while the next values resolve; only a completed failure replaces it with an error.
  React.useEffect(() => {
    let current = true;
    setProjectionPending(true);
    void projectedInput(projectionRows, found.state.bind, values, async (binding, context) => evaluateFormula({ binding, context }))
      .then(input => {
        for (const view of found.views ?? []) {
          if (!supportsControlsPreview(view.preview)) throw new Error(`${view.label} uses a screen that is not available here.`);
        }
        const projectedViews = projectViewInputs(found.views, found.state.bind, values, input);
        const views = Object.fromEntries(projectedViews.map(view => [view.id, view.projected_input ?? {}]));
        const viewMissing = Object.fromEntries(projectedViews.filter(view => view.missing_inputs?.length).map(view => [view.id, view.missing_inputs]));
        if (current) { setProjection({ input, views, viewMissing }); setProjectionPending(false); }
      })
      .catch(error => { if (current) { setProjection({ input: {}, views: {}, error: reasonOf(error) }); setProjectionPending(false); } });
    return () => { current = false; };
  }, [projectionRows, found.state.bind, values, found.views]);

  // One serialized writer keeps the complete state, flushes on departure and
  // retains a failed edit for retry. No failed write is silently discarded.
  const writer = React.useMemo(() => createSettledWrite({
    delay: SAVE_AFTER_MS,
    write: async (next: Record<string, TuningValue>) => {
      const body = JSON.stringify({ id, values: next });
      await readJson('/work/api/controls/keep', { method: 'POST', body, keepalive: new TextEncoder().encode(body).length < 60000 });
      accepted.current = next;
      const draft = localDraft.current;
      if (draft && same(draft.values, next)) {
        await forgetQuietDeviceDraftIfValue(`controls:${id}`, draft);
        if (localDraft.current === draft) localDraft.current = null;
      } else if (draft) {
        const rebased = { values: draft.values, based_on: next };
        localDraft.current = rebased;
        await keepQuietDeviceDraft(`controls:${id}`, rebased);
      }
    },
    onError: (failure: unknown) => { if (mounted.current) setSaveError(reasonOf(failure)); },
    onSaved: () => { if (mounted.current) setSaveError(''); },
  }), [id]);
  React.useEffect(() => {
    mounted.current = true;
    const depart = () => { void writer.flush().catch(() => {}); };
    window.addEventListener('pagehide', depart);
    if (found.recovered_values && !pending) { writer.put(latest.current); void writer.flush().catch(() => {}); }
    return () => { mounted.current = false; window.removeEventListener('pagehide', depart); depart(); };
  }, [writer]);

  // Another AI can change the definition, values or run state while this screen is open.
  // Accept clean server values and keep only local values that still differ from their accepted baseline.
  React.useEffect(() => {
    if (initial.interface_id !== id) return;
    // Other state updates (including clearing history) can rerun this effect.
    // Only a new screen read is allowed to replace the locally accepted result
    // of saveDefinition; replaying the same prop would restore stale controls.
    if (reconciledRead.current === initial) return;
    reconciledRead.current = initial;
    const serverValues = startingValues(initial.server_values
      ? { ...initial, state: { ...initial.state, values: initial.server_values } }
      : initial);
    const baseline = accepted.current;
    const localWritePending = writer.pending || localDraft.current !== null;
    const allowed = new Set(initial.rows.map(row => row.key));
    const dirty = Object.fromEntries(Object.entries(latest.current).filter(([key, value]) =>
      allowed.has(key) && localWritePending && !same(value, baseline[key])));
    const next = { ...serverValues, ...dirty };
    const current = currentFound.current;
    const definitionChanged = !same(definitionOf(current), definitionOf(initial));
    const stateChanged = !same(serverValues, baseline);
    if (definitionChanged || stateChanged) { clearHistory(); stepStart.current = null; }
    if (!same(latest.current, next) || definitionChanged || stateChanged) setProjectionPending(true);
    accepted.current = serverValues;
    latest.current = next;
    setFound(initial);
    setValues(next);
    const keptNow = initial.state.kept ?? [];
    const waiting = initial.state.pending && !initial.state.pending.terminal ? initial.state.pending : null;
    const keptChanged = !same(keptRef.current, keptNow);
    keptRef.current = keptNow;
    setKept(keptNow);
    setPending(waiting);
    setRunError(initial.state.last_error ?? '');
    const request = requestKey.current;
    const confirmed = Boolean(request && (
      initial.state.pending?.request_key === request && initial.state.pending.terminal
      || initial.state.kept?.some(item => item.request_key === request)
    ));
    if (confirmed) requestKey.current = null;
    setRetryRun(Boolean(requestKey.current));
    setConflictingDraft(initial.conflicting_draft ?? null);
    if (waiting) setSaid('');
    else if (!initial.state.last_error && (keptChanged || confirmed)) setSaid(initial.commit.done_label ?? 'Done');
    if (Object.keys(dirty).length) {
      const draft = { values: next, based_on: serverValues };
      localDraft.current = draft;
      void keepQuietDeviceDraft(`controls:${id}`, draft);
      writer.put(next);
    } else {
      const draft = localDraft.current;
      localDraft.current = null;
      if (draft) void forgetQuietDeviceDraftIfValue(`controls:${id}`, draft);
      if (writer.pending) writer.put(next);
    }
  }, [initial, id, clearHistory, writer]);

  const changeValues = React.useCallback((next: Record<string, TuningValue>) => {
    setProjectionPending(true);
    latest.current = next;
    setValues(next);
    const draft = { values: next, based_on: accepted.current };
    localDraft.current = draft;
    void keepQuietDeviceDraft(`controls:${id}`, draft);
    writer.put(next);
  }, [writer, id]);

  const acceptRun = React.useCallback((answer: Interface) => {
    if (!mounted.current) return;
    const keptNow = answer.state.kept ?? [];
    keptRef.current = keptNow;
    setKept(keptNow);
    const waiting = answer.state.pending && !answer.state.pending.terminal ? answer.state.pending : null;
    setPending(waiting);
    setRunError(answer.state.last_error ?? '');
    const request = requestKey.current;
    const confirmed = Boolean(request && (
      answer.state.pending?.request_key === request && answer.state.pending.terminal
      || answer.state.kept?.some(item => item.request_key === request)
    ));
    if (confirmed) requestKey.current = null;
    setRetryRun(Boolean(requestKey.current));
    if (!waiting && !answer.state.last_error && (!requestKey.current || confirmed)) {
      requestKey.current = null;
      setSaid(found.commit.done_label ?? 'Done');
    }
  }, [found.commit.done_label]);
  // The action owner retains the task and exact input. Leaving the pane does
  // not cancel it; reopening reconciles its real output into this same record.
  React.useEffect(() => {
    if (!pending) return undefined;
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const answer = await readJson<Interface>(`/work/api/controls/${encodeURIComponent(id)}`, {}, true);
        if (gone) return;
        acceptRun(answer);
        if (answer.state.pending && !answer.state.pending.terminal) timer = setTimeout(refresh, POLL_MS);
      } catch (failure) {
        if (gone) return;
        setRunError(reasonOf(failure));
        timer = setTimeout(refresh, POLL_MS * 3);
      }
    };
    timer = setTimeout(refresh, POLL_MS);
    return () => { gone = true; clearTimeout(timer); };
  }, [pending?.request_key, id, acceptRun]);

  // One move of a control is one step of the history: a drag of a slider is gathered into the step it started.
  const onChange = React.useCallback((key: string, value: TuningValue) => {
    const before = latest.current[key];
    if (pending || busy || retryRun) return;
    changeValues({ ...latest.current, [key]: value });
    const now = Date.now();
    const open = stepStart.current;
    if (open && open.key === key && now - open.at < 700) { open.at = now; open.to = value; return; }
    const step = { key, from: before, to: value, at: now };
    stepStart.current = step;
    history.record({
      apply: () => { stepStart.current = null; changeValues({ ...latest.current, [key]: step.to }); },
      revert: () => { stepStart.current = null; changeValues({ ...latest.current, [key]: step.from }); },
    });
  }, [history, changeValues, pending, busy, retryRun]);

  const reset = () => {
    const before = latest.current;
    const back = Object.fromEntries(found.rows.map(row => [row.key, (found.defaults[row.key] ?? row.default_value) as TuningValue]));
    changeValues(back);
    stepStart.current = null;
    history.record({ apply: () => changeValues(back), revert: () => changeValues(before) });
  };

  const keep = async () => {
    if (busy || pending || projectionPending || projection === null || projection.error) return;
    setBusy(true);
    setSaid('');
    setRunError('');
    try {
      const exactInput = await projectedInput(projectionRows, found.state.bind, latest.current, async (binding, context) => evaluateFormula({ binding, context }));
      projectViewInputs(found.views, found.state.bind, latest.current, exactInput);
      await writer.flush();
      requestKey.current ??= crypto.randomUUID();
      const answer = await postJson<Interface>('/work/api/controls/run', { id, values: latest.current, request_key: requestKey.current });
      acceptRun(answer);
    } catch (failure) {
      const status = (failure as { status?: number })?.status;
      const refused = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (refused) requestKey.current = null;
      if (mounted.current) { setRunError(reasonOf(failure)); setRetryRun(!refused && Boolean(requestKey.current)); }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const saveDefinition = async () => {
    if (busy || pending || retryRun || !definition.title.trim() || !definition.settings.length) return;
    setBusy(true);
    setEditError('');
    try {
      await writer.flush();
      await postJson('/work/api/controls/make', {
        id, intent: found.intent, title: definition.title.trim(), tool_id: found.tool.id,
        settings: definition.settings.map(input => { const row = found.rows.find(row => row.key === input); return { input, ...(row ? { label: row.label, note: row.note } : {}) }; }),
        semantic_controls: (found.semantic_settings ?? []).map(({ key, label, note, schema, bindings }) => ({ key, label, note, schema, bindings })),
        views: (found.views ?? []).map(({ id: viewId, tool_id, inputs }) => ({ id: viewId, tool_id, inputs })),
        layout: definition.layout, demo: false, open_now: false,
      });
      const next = await readJson<Interface>(`/work/api/controls/${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store' });
      if (!mounted.current) return;
      setFound(next);
      const nextValues = startingValues(next);
      accepted.current = nextValues;
      latest.current = nextValues;
      setProjectionPending(true);
      setValues(nextValues);
      const nextKept = next.state.kept ?? [];
      keptRef.current = nextKept;
      setKept(nextKept);
      localDraft.current = null;
      history.clear();
      stepStart.current = null;
      setEditing(false);
      // Supersede any screen read that began before this save. The screen's
      // fresh read remains authoritative if another AI already changed it.
      await refresh();
    } catch (failure) { if (mounted.current) setEditError(reasonOf(failure)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const thing = { interface: id, tool: found.tool.id };
  if (showOf('controls', thing).hidden) return <ScreenState state={{ status: 'empty', icon: 'EyeOff', title: 'This is hidden for you', description: 'Your rules hide these controls here.' }} />;
  const shown = found.rows.filter(row => !showOf('control', { ...thing, input: row.key }).hidden);
  const unbound = requiredControlSubjects(projectionRows).filter(name => found.state.bind[name] === undefined || found.state.bind[name] === '');
  const changed = found.rows.some(row => !same(values[row.key], found.defaults[row.key] ?? row.default_value));
  const commitLabel = found.commit.label ?? 'Run';
  const working = busy || Boolean(pending);
  const locked = working || retryRun;
  const edit = askYourAi(`Change my saved controls for "${found.intent}". Read this interface (${id}) and use make_controls with the same id to change its name, controls or layout. Keep my current work. Ask what I want changed.`);

  const footer = (
    <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
        <Button variant="ghost" size="sm" onClick={() => history.undo()} disabled={locked || !history.canUndo} data-controls-undo>Undo</Button>
        <Button variant="ghost" size="sm" onClick={() => history.redo()} disabled={locked || !history.canRedo}>Redo</Button>
        <Button variant="ghost" size="sm" onClick={reset} disabled={locked || !changed}>Reset</Button>
      </Container>
      {found.runs && commitLabel ? (
        <Button variant="primary" onClick={() => keep()} disabled={working || projectionPending || unbound.length > 0 || projection === null || Boolean(projection.error)} data-controls-keep aria-busy={working}>
          {working ? (found.commit.busy_label ?? 'Working…') : retryRun ? 'Retry' : commitLabel}
        </Button>
      ) : null}
      {working && found.commit.takes ? <Text variant="caption" color="muted">{found.commit.takes}</Text> : null}
      {saveError ? <Container layout="vertical" gap="xs"><Text variant="body-sm" role="alert">{saveError}</Text><Button variant="ghost" size="sm" onClick={() => writer.flush()}>Retry keeping changes</Button></Container> : null}
      {runError ? <Text variant="body-sm" role="alert">{runError}</Text> : null}
      {projection?.error ? <Text variant="body-sm" color="error" role="alert">These controls cannot be applied yet: {projection.error}</Text> : null}
      {said ? <Text variant="body-sm" role="status" data-controls-said>{said}</Text> : null}
      {conflictingDraft ? <Container layout="vertical" gap="xs">
        <Text variant="body-sm">An earlier edit is kept on this device. Your current saved values are shown.</Text>
        <Container layout="horizontal" gap="sm" wrap="wrap">
          <Button disabled={locked} onClick={() => { changeValues({ ...latest.current, ...conflictingDraft.values }); setConflictingDraft(null); }}>Restore those edits</Button>
          <Button variant="ghost" disabled={locked} onClick={async () => { await forgetQuietDeviceDraftIfValue(`controls:${id}`, conflictingDraft); setConflictingDraft(null); }}>Keep current values</Button>
        </Container>
      </Container> : null}
      {editing ? (
        <Container layout="vertical" gap="sm" data-controls-definition>
          <Input label="Name" value={definition.title} disabled={working} onChange={event => { const title = event.currentTarget.value; setDefinition(current => ({ ...current, title })); }} />
          <TuningPanel
            sections={[{ id: 'definition', title: 'Change your controls', settings: [
              { key: 'settings', label: 'Controls to show', widget: 'many', options: (found.all_rows ?? found.rows).map(row => ({ value: row.key, label: row.label })) },
              { key: 'layout', label: 'Preview position', widget: 'choices', options: [{ value: 'beside', label: 'Beside' }, { value: 'above', label: 'Above' }] },
            ] }]}
            values={{ settings: definition.settings, layout: definition.layout }} disabled={working}
            onChange={(key, value) => setDefinition(current => key === 'settings' && Array.isArray(value) ? { ...current, settings: value.map(String) } : key === 'layout' && typeof value === 'string' ? { ...current, layout: value } : current)}
          />
          <Container layout="horizontal" gap="sm">
            <Button disabled={working || !definition.title.trim() || !definition.settings.length} onClick={() => saveDefinition()}>Save controls</Button>
            <Button variant="ghost" disabled={working} onClick={() => setEditing(false)}>Cancel</Button>
          </Container>
          {editError ? <Text role="alert" variant="body-sm">{editError}</Text> : null}
        </Container>
      ) : <Button variant="ghost" size="sm" disabled={locked} onClick={() => { setDefinition({ title: found.title, settings: found.rows.map(row => row.key), layout: found.layout ?? 'beside' }); setEditing(true); }}>Change controls</Button>}
      <OpenChoice choices={edit.choices} remember={edit.remember} words={edit.words} labels={edit.labels} />
    </Container>
  );

  return (
    <Container layout="vertical" height="full" minHeight="0" minWidth="0" gap="md" padding="md" className="overflow-y-auto" data-controls={id}>
      <Text as="h1" variant="heading-lg">{found.title}</Text>
      <Container layout="vertical" gap="lg" minWidth="0" className={found.layout === 'above' || !shown.length ? '' : 'lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start'}>
        {projection?.error ? (
          <Text variant="body-sm" color="error" role="alert" data-controls-projection-error>{projection.error}</Text>
        ) : projection ? (
          <Container layout="vertical" gap="md" minWidth="0" className={found.views?.length ? 'grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3' : ''} data-controls-composition>
            <Card variant="outline" padding="md" layout="column" minWidth="0" className="gap-3" data-controls-view="primary">
              {found.views?.length ? <Text as="h2" variant="heading-sm">{found.tool.label}</Text> : null}
              <ControlsPreview key={JSON.stringify(found.preview)} preview={found.preview} values={projection.input} controlValues={values} bind={found.state.bind} kept={kept} title={found.title} labels={Object.fromEntries(found.rows.map(row => [row.key, row.label]))} hiddenInputs={found.rows.filter(row => showOf('control', { ...thing, input: row.key }).hidden).map(row => row.key)} onValueChange={locked ? undefined : (key, value) => onChange(key, value as TuningValue)} />
            </Card>
            {(found.views ?? []).map(view => (
              <Card key={view.id} variant="outline" padding="md" layout="column" minWidth="0" className="gap-3" data-controls-view={view.id}>
                <Text as="h2" variant="heading-sm">{view.label}</Text>
                {projection.viewMissing?.[view.id]?.length ? (
                  <ScreenState state={{ status: 'empty', title: `Choose ${projection.viewMissing[view.id].join(', ')}`, description: `Set the required controls to show ${view.label}.` }} />
                ) : <ControlsPreview key={JSON.stringify(view.preview)} preview={view.preview} values={projection.views[view.id] ?? {}} bind={{}} kept={kept} title={view.label} />}
              </Card>
            ))}
          </Container>
        ) : (
          <ScreenState state={{ status: 'loading', label: 'Updating your preview', layout: 'editor' }} />
        )}
        <TuningPanel sections={shown.length ? [{ id: 'controls', title: found.tool.label, settings: shown }] : []} values={values} onChange={onChange} disabled={locked} footer={footer} />
      </Container>
    </Container>
  );
}

function ControlsRoot({ id }: { id: string }) {
  const loaded = useScreenLoad(`controls:${id}`, {
    loading: { label: 'Opening your controls', layout: 'editor' },
    read: async () => {
      const found = await readJson<Interface>(`/work/api/controls/${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store' });
      const draft = await readQuietDeviceDraft<DeviceDraft>(`controls:${id}`);
      if (!draft?.values || !draft.based_on || typeof draft.values !== 'object' || Array.isArray(draft.values) || found.state.pending && !found.state.pending.terminal) return found;
      const allowed = new Set(found.rows.map(row => row.key));
      const values = Object.fromEntries(Object.entries(draft.values).filter(([key]) => allowed.has(key)));
      if (!Object.keys(values).length) return found;
      const current = startingValues(found);
      if (same(current, values)) { await forgetQuietDeviceDraftIfValue(`controls:${id}`, draft); return found; }
      if (!same(current, draft.based_on)) return { ...found, conflicting_draft: draft };
      return { ...found, recovered_values: true, server_values: found.state.values, device_draft: draft, state: { ...found.state, values: { ...found.state.values, ...values } } };
    },
    failed: refusal('These controls could not open'),
  });
  React.useEffect(() => id ? onStoreChange(() => loaded.reload()) : undefined, [id, loaded.reload]);
  if (!id) return <ScreenState state={{ status: 'empty', icon: 'SlidersHorizontal', title: 'No controls chosen', description: 'Ask your AI to make controls for what you want to adjust.' }} />;
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <Controls key={loaded.value.interface_id} found={loaded.value} refresh={loaded.reload} />;
}

export function mountControlsScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): () => void {
  const id = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : '';
  return mountReactSurface(element, <ControlsRoot id={id} />);
}
