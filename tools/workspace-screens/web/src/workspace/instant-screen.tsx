// src/workspace/instant-screen.tsx
//
// PURPOSE
//   Under the message box (Home's box and the box every screen opens), the working screen the words pick while they
//   are typed, before Send and before any AI: the person types "timer 25 min" and their timer is there with 25
//   minutes in it, to use at once, open in its own tab, keep for these words, rename or remove. Pressing Send still
//   asks their AIs, and a screen an AI makes for those words is saved with them (`screen.asked`, a made interface's
//   intent), so the same words pick it at once next time. The pick and its share are src/instant-screens.mjs; the
//   values are src/input-parsers.mjs; the screen itself is the same screen a pane mounts (screen-mounts.ts), so it
//   acts on the person's real records through its own validated owner.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No model is asked for the pick or for the first paint: the catalog is on this device and the pick is made in
//      the same frame as the keystroke. Only the screen's description (for its inputs) and the optional fill provider
//      (instant-screens.json `fill.provider`, none unless named) leave the device, after the words rest
//      `debounce_ms`; each such read is aborted when newer words arrive and answered only for the newest words
//      (a rising sequence number), and the fill provider is never tried again.
//   2. Calm: the shown screen changes only as decide() says, and a new screen replaces the shown one only once it has
//      drawn (or after `swap_after_ms`); until then the screen shown stays.
//   3. Complete actions: Open (its own tab, with the filled values), Keep (the words and values, as the person's
//      kept screen), Rename and Remove a kept screen, and Delete a screen an AI made through that screen's owner
//      (remove-workflow for a made interface, delete-tool for a saved tool screen). Every write goes through the
//      shared owners (records.ts preferences, the Workshop and workflow routes); a refusal is said in words.
//   4. Words are DATA (instant-screens.json `words`); everything is drawn with the shared parts.
//   5. Bounded: answers are kept for `remembered_answers` texts, descriptions for the same number of tools.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Button, Card, Container, Text } from '../../parts/ui';
import { NamedIcon } from '../../parts/ui/show/icon';
import { ActionMenu, type ActionMenuItem } from '../../parts/ui/show/action-menu';
import { RenamePanel } from '../../parts/ui/show/node-editors';
import { notify } from '../../parts/ui/show/coss/notifications';
import { readWithKeptAnswers } from '../../parts/ui/show/request/kept-answers';
import { catalogOf, choose, createAnswers, decide, keepAsk, keptAsks, NO_PICK, rank, removeAsk, renameAsk, INSTANT_SCREENS } from '../instant-screens.mjs';
import { fillInputs } from '../input-parsers.mjs';
import { postJson, readJson } from './api';
import { openScreenOn, useOfferedScreens, type OfferedScreen } from './open-screen';
import { updateWorkspacePreferenceDurably, useWorkspacePreference } from './records';
import { onStoreChange } from './store-changes';
import { FILLED_INPUTS, filledInputs, type ToolInputSchema } from './tool-inputs';
import { toolScreenRequest } from './tool-screen-requests.mjs';
import { reasonOf } from './failure';
import { screens } from './screen-mounts';
import type { Unmount } from './lazy-screen';

type Entry = { key: string; kind: 'kept' | 'made' | 'screen'; screen: string; input: Record<string, unknown>; label: string; icon?: string; about: string; source: { tool_id?: string; made?: boolean; ask_id?: string; workflow_id?: string } };
type Pick = { entry: Entry; score: number; matched: [number, number][] };
type Ranked = { text: string; picks: Pick[] };
type Memory = { shown: Pick | null; challenger: { key: string; wins: number } | null; forced: string | null };
type Made = { interface_id: string; title: string; intent: string; tool_id: string };
type Described = { descriptor: { input_schema?: ToolInputSchema; screen?: { inputs?: Record<string, { choices?: { value: string; label: string }[] }> } } };

const settings = INSTANT_SCREENS;
const NONE: Record<string, unknown> = {};
const words = settings.words;
const say = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
// The marks a measuring page reads (PerformanceObserver): only the newest of each is kept, so they never pile up.
const mark = (name: string, detail: Record<string, unknown>) => {
  if (typeof performance === 'undefined' || !performance.mark) return;
  performance.clearMarks(name);
  performance.mark(name, { detail });
};
const afterPaint = (then: () => void) => requestAnimationFrame(() => setTimeout(then, 0));

/** The person's made interfaces (src/made-controls.mjs list): read when the box first draws and when the store changes. */
function useMade(): Made[] {
  const [made, setMade] = React.useState<Made[]>([]);
  React.useEffect(() => {
    let gone = false;
    const read = async () => {
      try {
        const answer = await postJson<{ interfaces: Made[] }>(settings.made.read, {});
        if (!gone) setMade(Array.isArray(answer.interfaces) ? answer.interfaces : []);
      } catch { /* The made interfaces stay as last read; every other screen is still a candidate. */ }
    };
    void read();
    const stop = onStoreChange(read);
    return () => { gone = true; stop(); };
  }, []);
  return made;
}

/** The calm pick for the words: ranked on this device (remembered per text), then decided against what is shown. */
function usePick(words: string, rows: OfferedScreen[], made: Made[], asks: ReturnType<typeof keptAsks>) {
  const catalog = React.useMemo(() => catalogOf({ rows, made, asks }), [rows, made, asks]);
  const answers = React.useMemo(() => createAnswers(settings.remembered_answers), [catalog]);
  const memory = React.useRef<Memory>(NO_PICK);
  const [shown, setShown] = React.useState<{ memory: Memory; ranked: Ranked }>({ memory: NO_PICK, ranked: { text: '', picks: [] } });
  React.useLayoutEffect(() => {
    const started = performance.now();
    const ranked: Ranked = answers.get(words) ?? rank(catalog, words);
    answers.set(words, ranked);
    memory.current = decide(memory.current, ranked) as Memory;
    mark('instant:picked', { words, ms: performance.now() - started, screen: memory.current.shown?.entry.key ?? null });
    setShown({ memory: memory.current, ranked });
  }, [words, catalog, answers]);
  const chooseOne = React.useCallback((pick: Pick) => {
    memory.current = choose(pick, words) as Memory;
    setShown(current => ({ ...current, memory: memory.current }));
  }, [words]);
  return { ...shown, choose: chooseOne };
}

/** The tool description a picked screen fills from: read once the same tool has stayed picked `debounce_ms` (each
 *  newer pick aborts the read before it), through the same kept answer the tool's own screen reads, and kept for
 *  `remembered_answers` tools. */
function useDescribed(toolId: string | undefined) {
  const schemas = React.useMemo(() => createAnswers(settings.remembered_answers), []);
  const [described, setDescribed] = React.useState<{ toolId: string; described: Described } | null>(null);
  React.useEffect(() => {
    if (!toolId) return undefined;
    const known = schemas.get(toolId) as Described | undefined;
    if (known) { setDescribed({ toolId, described: known }); return undefined; }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const path = toolScreenRequest(toolId, {}, 'describe').path;
      readWithKeptAnswers(() => readJson<Described>(path, { signal: abort.signal }, true, { applyFocus: false })).then(answer => {
        schemas.set(toolId, answer);
        if (!abort.signal.aborted) setDescribed({ toolId, described: answer });
      }, () => { /* Without its description the screen opens with its kept values; the person fills the rest. */ });
    }, settings.debounce_ms);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [toolId, schemas]);
  return described && described.toolId === toolId ? described.described : null;
}

/** The values the words give the picked screen: its kept values, then what the parsers read from the words (at once,
 *  once its description is here), then what the optional fill provider adds after the words rest (invariant 1).
 *  Answered only for the newest words. */
function useFilled(pick: Pick | null, row: OfferedScreen | undefined, typed: string) {
  // A kept screen of a tool fills as the tool's own screen does: its tool is the one its screen row opens.
  const rowTool = (row?.source as { tool_id?: unknown } | undefined)?.tool_id ?? (row?.surface_input as { tool_id?: unknown } | undefined)?.tool_id;
  const toolId = pick?.entry.source.tool_id ?? (typeof rowTool === 'string' ? rowTool : undefined);
  const described = useDescribed(toolId);
  const key = pick?.entry.key ?? '';
  const kept = React.useMemo(() => filledInputs(pick?.entry.input ?? {}), [pick?.entry.input]);
  const parsed = React.useMemo(() => {
    if (!pick || !described) return {};
    const choices = Object.fromEntries(Object.entries(described.descriptor.screen?.inputs ?? {}).map(([name, shown]) => [name, shown?.choices ?? []]));
    return fillInputs(described.descriptor.input_schema, typed, { used: pick.matched, choices }).values as Record<string, unknown>;
  }, [pick, described, typed]);
  const [provided, setProvided] = React.useState<{ key: string; words: string; values: Record<string, unknown> } | null>(null);
  const sequence = React.useRef(0);
  React.useEffect(() => {
    if (described) afterPaint(() => mark('instant:filled', { words: typed, screen: key, inputs: Object.keys(parsed) }));
  }, [described, parsed, typed, key]);
  React.useEffect(() => {
    const id = ++sequence.current;
    const provider = settings.fill.provider as string | null;
    const schema = described?.descriptor.input_schema;
    const unfilled = Object.keys(schema?.properties ?? {}).filter(name => !(name in parsed));
    if (!provider || !schema || !unfilled.length) return undefined;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const request = toolScreenRequest(provider, {}, 'run', { input: { words: typed, schema: { ...schema, properties: Object.fromEntries(unfilled.map(name => [name, schema.properties?.[name]])) } }, request_key: `instant:${crypto.randomUUID()}` });
      readJson<{ result?: { values?: Record<string, unknown> } }>(request.path, { ...request.init, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(settings.fill.timeout_ms)]) }, false, { applyFocus: false })
        .then(answer => {
          if (id !== sequence.current || !answer.result?.values) return;
          setProvided({ key, words: typed, values: Object.fromEntries(Object.entries(answer.result.values).filter(([name]) => unfilled.includes(name))) });
        }, () => { /* The parsed values stand alone (invariant 1); it is never tried again. */ });
    }, settings.debounce_ms);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [described, parsed, typed, key]);
  const added = provided && provided.key === key && provided.words === typed ? provided.values : NONE;
  return React.useMemo(() => ({ ...kept, ...added, ...parsed }), [kept, added, parsed]);
}

// What the screen is opened with: its row's own input, the picked entry's (a kept screen's or a made interface's),
// and the filled values for its boxes.
const inputOf = (row: OfferedScreen | undefined, entry: Entry, filled: Record<string, unknown>) => {
  const { [FILLED_INPUTS]: _kept, ...own } = entry.input;
  return { ...(row?.surface_input ?? {}), ...own, ...(Object.keys(filled).length ? { [FILLED_INPUTS]: filled } : {}) };
};

type Mounted = { key: string; host: HTMLElement; unmount: Unmount; stop: () => void };

/** The picked screen itself, mounted as a pane mounts it. A new screen is drawn out of sight and replaces the shown
 *  one only once it has drawn (or after `swap_after_ms`), and new values reach the same screen as an update, never a
 *  new mount (invariant 2). */
function PickedScreen({ entry, row, filled }: { entry: Entry; row: OfferedScreen | undefined; filled: Record<string, unknown> }) {
  const place = React.useRef<HTMLDivElement | null>(null);
  const visible = React.useRef<Mounted | null>(null);
  const waiting = React.useRef<Mounted | null>(null);
  const input = React.useMemo(() => inputOf(row, entry, filled), [row, entry, filled]);
  const entryName = row?.package_entry?.entry_name;
  React.useLayoutEffect(() => {
    const where = place.current;
    const mount = entryName ? screens[entryName] : undefined;
    if (!where || !mount) return;
    const letGo = (one: Mounted | null) => { if (!one) return; one.stop(); one.unmount(); one.host.remove(); };
    if (waiting.current?.key === entry.key) { waiting.current.unmount.update?.({ surfaceInput: input }); return; }
    if (visible.current?.key === entry.key) {
      // The challenger lost before it drew: the shown screen stays and takes the new values.
      letGo(waiting.current);
      waiting.current = null;
      visible.current.unmount.update?.({ surfaceInput: input });
      return;
    }
    letGo(waiting.current);
    const host = document.createElement('div');
    host.className = 'instant-screen-body';
    host.dataset.trillionScreen = entryName!;
    host.hidden = Boolean(visible.current);
    where.append(host);
    const started = performance.now();
    let watch: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { watch?.disconnect(); clearTimeout(timer); };
    const one: Mounted = { key: entry.key, host, unmount: mount(host, { surfaceInput: input }), stop };
    const show = () => {
      if (waiting.current !== one) return;
      stop();
      letGo(visible.current);
      host.hidden = false;
      visible.current = one;
      waiting.current = null;
      afterPaint(() => mark('instant:screen', { screen: one.key, ms: performance.now() - started }));
    };
    const drawn = () => host.childElementCount > 0 && !host.querySelector('[data-screen-state="loading"]');
    waiting.current = one;
    if (!visible.current) { show(); return; }
    watch = new MutationObserver(() => { if (drawn()) show(); });
    watch.observe(host, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(show, settings.swap_after_ms);
    if (drawn()) show();
  }, [entry, entryName, input]);
  React.useEffect(() => () => {
    for (const one of [waiting.current, visible.current]) { if (!one) continue; one.stop(); one.unmount(); one.host.remove(); }
    waiting.current = null;
    visible.current = null;
  }, []);
  return <Container ref={place} width="full" className="instant-screen-place" />;
}

/** The answer under a message box to the words being written: the screen they pick, ready to use (invariant 1). */
export function InstantScreen({ words: typed }: { words: string }) {
  const rows = useOfferedScreens();
  const made = useMade();
  const preference = useWorkspacePreference<{ asks?: unknown[] }>(settings.asks.preference);
  const asks = React.useMemo(() => keptAsks(preference), [preference]);
  const { memory, ranked, choose: chooseOne } = usePick(typed, rows, made, asks);
  const pick = memory.shown;
  const row = pick ? rows.find(one => one.id === pick.entry.screen) : undefined;
  const filled = useFilled(pick, row, typed);
  // Marked once the answer drawn is the one decided for these words (a measuring page reads it).
  React.useLayoutEffect(() => {
    if (ranked.text === typed) afterPaint(() => mark('instant:painted', { words: typed, screen: pick?.entry.key ?? null }));
  }, [typed, pick, ranked.text]);
  if (!pick) return null;
  const { entry } = pick;
  const failed = (error: unknown) => notify(say(words.could_not, { reason: reasonOf(error) }), { kind: 'error' });
  // Keeping (and opening, which keeps too, so the same words pick it at once next time) writes the person's kept
  // screens through the shared preference owner, against its current value.
  const keep = async (quietly: boolean) => {
    try {
      await updateWorkspacePreferenceDurably(settings.asks.preference, current => keepAsk(current, { words: typed, screen: entry.screen, input: { ...entry.input, ...(Object.keys(filled).length ? { [FILLED_INPUTS]: filled } : {}) }, label: entry.label, icon: entry.icon ?? '' }, crypto.randomUUID()));
      if (!quietly) notify(words.kept, { kind: 'done' });
    } catch (error) { failed(error); }
  };
  const open = () => {
    openScreenOn(entry.screen, inputOf(row, entry, filled), entry.label);
    void keep(true);
  };
  const rename = async (label: string) => {
    try {
      await updateWorkspacePreferenceDurably(settings.asks.preference, current => renameAsk(current, entry.source.ask_id!, label));
      notify(words.renamed, { kind: 'done' });
    } catch (error) { failed(error); }
  };
  const remove = async () => {
    try {
      if (entry.kind === 'kept') {
        await updateWorkspacePreferenceDurably(settings.asks.preference, current => removeAsk(current, entry.source.ask_id!));
        notify(words.removed, { kind: 'done' });
      } else if (entry.kind === 'made') {
        await postJson('/work/api/workflows/remove-workflow', { workflow_id: entry.source.workflow_id });
        notify(words.removed_made, { kind: 'done' });
      } else {
        await postJson(`/work/api/workshop/delete-tool/${encodeURIComponent(entry.source.tool_id!)}`, {});
        notify(words.removed_made, { kind: 'done' });
      }
    } catch (error) { failed(error); }
  };
  const made_by_ai = entry.kind === 'made' || (entry.kind === 'screen' && entry.source.made === true);
  const menu: ActionMenuItem[] = [
    ...(entry.kind === 'kept' ? [
      { id: 'rename', label: words.rename, icon: 'Pencil', panel: (close: () => void) => <RenamePanel value={entry.label} onCommit={label => { close(); void rename(label); }} onCancel={close} /> },
      { id: 'remove', label: words.remove, icon: 'Trash2', tone: 'destructive', confirm: words.remove },
    ] : []),
    ...(made_by_ai ? [{ id: 'delete', label: words.remove_made, icon: 'Trash2', tone: 'destructive', confirm: words.remove_made }] : []),
  ];
  // The other screens the words could mean, each name once (a kept screen and the screen it keeps share a name).
  const others = ranked.picks.filter(one => one.entry.key !== entry.key && one.score >= settings.decide.show_at)
    .filter((one, index, all) => one.entry.label !== entry.label && all.findIndex(other => other.entry.label === one.entry.label) === index)
    .slice(0, settings.alternatives);
  const matchedWords = pick.matched.map(([at, end]) => typed.slice(at, end)).join(' ');
  return (
    <Card className="instant-screen" aria-label={words.label} data-instant-screen={entry.key}>
      <Container layout="vertical" gap="sm" width="full" padding="sm">
        <Container layout="horizontal" gap="sm" alignItems="center" width="full">
          <NamedIcon name={entry.icon ?? 'LayoutPanelLeft'} size="sm" aria-hidden="true" />
          <Container layout="vertical" gap="none" flex={1}>
            <Text variant="label">{entry.label}</Text>
            <Text variant="caption" color="muted">{pick.score === 1 && (entry.kind !== 'screen' || entry.source.made) ? words.why_asked : say(words.why_words, { words: matchedWords })}</Text>
          </Container>
          {entry.kind === 'kept' ? null : <Button type="button" variant="ghost" size="sm" onClick={() => keep(false)}>{words.keep}</Button>}
          <Button type="button" variant="primary" size="sm" onClick={open}>{words.open}</Button>
          {menu.length ? <ActionMenu label={words.more} items={menu} onAction={id => { if (id === 'remove' || id === 'delete') void remove(); }} /> : null}
        </Container>
        {others.length ? (
          <Container layout="horizontal" gap="xs" alignItems="center" wrap width="full">
            <Text variant="caption" color="muted">{words.also}</Text>
            {others.map(other => (
              <Button key={other.entry.key} type="button" variant="outline" size="sm" onClick={() => chooseOne(other)}>
                <NamedIcon name={other.entry.icon ?? 'LayoutPanelLeft'} size="xs" aria-hidden="true" />
                {other.entry.label}
              </Button>
            ))}
          </Container>
        ) : null}
        <PickedScreen entry={entry} row={row} filled={filled} />
      </Container>
    </Card>
  );
}
