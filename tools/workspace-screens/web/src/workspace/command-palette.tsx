// src/workspace/command-palette.tsx
//
// PURPOSE
//   Find anything: the palette ported from Alex's command-palette package (parts/command-palette), as an ordinary
//   screen. Its screen row (tool:screen-command-palette in records/workshop-screen-tool-records.json) floats it in the middle of the screen in its own layer,
//   over a backdrop whose look is DATA on that layer; its keys (the `find-anything` row of keymap.json) open and close it from
//   anywhere. This file answers the targets the ported palette asks, from what this person has:
//     - `slot::find-current-items` (in: published-record): the screens before anything is typed, and the result
//       sources the palette searches with what is typed (screens, action mentions, and indexed files and records);
//     - `slot::workflow` (trillion.palette.*): that search, and reading one result back by its address;
//     - `trillion.palette.open`: running the chosen result (opening its screen, or one of the palette's own actions).
//   Every result is drawn with the same hover card as a sidebar row (the screen it opens, small, and where else it
//   can open: the shared open choices).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a screen, a kind of thing or an action: screens come from the sidebar's own list, things
//      from the `@` reader (src/mention-sources.json), actions and readers from command-palette.json.
//   2. A result opens the way the sidebar opens a screen (the placeable-surface event), so where it lands is the
//      arrangement's to decide, or the open choice's.
//   3. The palette package is unchanged but for its records seam; what it asks for is answered here.
//   4. Every field the palette's result checks ask for is a true fact of the result: its address, a BLAKE3 identity
//      of what was read, the reader that read it and how it was ranked (by the words typed; no model ranks).
//   5. Words typed ask only what searches by words: the one indexed search and only the mention kinds named by DATA;
//      all other mentions are read once as the palette opens. Each reader's answer for one query is asked once.

import React from 'react';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CommandPaletteGate } from '../../parts/command-palette/show/CommandPaletteGate';
import type { CommandPaletteFrameProps } from '../../parts/command-palette/show/CommandPalette';
import type { PaletteSearchResult } from '../../parts/command-palette/show/palette-types';
import { Container } from '../../parts/ui/show/container';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { SurfacePreviewCard, type SurfacePreview } from '../../parts/ui/show/surface-preview/SurfacePreviewCard';
import {
  PLACEABLE_SURFACE_MIME,
  closeOwnScreen,
  readPlaceableSurfaceRecordFromUnknown,
  shownOpenChoices,
  withOpenChoice,
} from '../../parts/ui/show/placeable-surface-intent';
import { controlShown } from '../../parts/ui/show/show-rules/show-of';
import { answerTarget, readInputValue } from './records';
import { readJson } from './api';
import { refusal } from './failure';
import { mentionAddress } from './mentions';
import { fileTab } from './open-screen';
import type { SearchAnswer, SearchResult } from './search-results';
import { screenOfAddress } from './addresses.mjs';
import { sendToAllYourAis } from './send-message';
import surfaces from './screens.mjs';
import settings from './command-palette.json';
import { feltFrom } from './felt-speed';
import { registerVerb } from './keymap-runtime';
import { bonusFor, readKept, recordPick, type FrecencyRules, type Store } from './frecency';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
type Source = { id: string; read: string; group?: string; blank: boolean; limit: number; typed_kinds?: string[]; ask?: Record<string, string> };
type Action = { id: string; run: string; group: string; icon: string; title: string; description: string; done?: string };
const SOURCES: readonly Source[] = settings.sources;
const CALENDAR = settings.calendar;
const FRECENCY: FrecencyRules = settings.frecency;
// Used results rise: one decayed date per address on this device (frecency.ts), and the words that led to each pick.
const deviceStore: Store = {
  read: key => { try { return localStorage.getItem(key); } catch { return null; } },
  write: (key, value) => { try { localStorage.setItem(key, value); } catch { /* a full or blocked store keeps nothing */ } },
};
const ACTIONS: readonly Action[] = settings.actions;
type Row = Record<string, unknown> & { id: string; label?: string; icon?: string; description?: string };
type Opening = { id: string; title?: string; surfaceInput?: Record<string, unknown> };
const stableValue = (value: unknown): unknown => Array.isArray(value) ? value.map(stableValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue((value as Record<string, unknown>)[key])]))
    : value;
export const canonicalOpeningIdentity = (opening: Opening | undefined, address: string) => opening
  ? JSON.stringify([opening.id, stableValue(opening.surfaceInput ?? null)])
  : address;
/** One result as this file keeps it: what it says, and what choosing it does. */
type Found = {
  address: string; title: string; description: string; group: string; icon: string; score: number; source: string;
  subtitle?: string;
  /** Words that always show under the title (an event's time), unlike `subtitle`, which only tells two of the same name apart. */
  said?: string;
  /** Where it was found, in words (a file's folder, the place a search found it), to tell it from another of the same name. */
  also?: string;
  open?: Opening; run?: Action;
};
type Candidate = { kind: string; value: string; label: string; detail?: string };
type MentionAnswer = { kinds?: Record<string, { label: string; icon: string }>; candidates?: Candidate[] };

const OPEN_TARGET = 'trillion.palette.open';
const SEARCH_DEFINITION = 'trillion.palette.search';
const ITEM_DEFINITION = 'trillion.palette.item';
const RANKED_BY = 'trillion.palette.rank:words-typed';
const hash = (value: unknown) => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(value))));
const fill = (words: string, query: string) => words.replaceAll('{query}', query);

// The screens this person is offered, as the sidebar holds them (open-screen.ts reads the same list).
const offered = (): Row[] => {
  const rows = readInputValue<unknown[]>({ input: 'placeable-surface-list-by-address-label', params: { addressLabel: surfaces.address_label } });
  return (Array.isArray(rows) && rows.length ? rows : surfaces.surfaces) as Row[];
};

/** How well `text` answers what was typed: a start of the words beats a start of a word beats anywhere in it. */
function rank(query: string, ...texts: (string | undefined)[]): number {
  const sought = query.trim().toLocaleLowerCase();
  if (!sought) return 1;
  let best = 0;
  texts.forEach((text, place) => {
    const words = (text ?? '').toLocaleLowerCase();
    const weight = place === 0 ? 1 : 0.5;
    if (words.startsWith(sought)) best = Math.max(best, 3 * weight);
    else if (words.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(sought))) best = Math.max(best, 2 * weight);
    else if (words.includes(sought)) best = Math.max(best, 1 * weight);
  });
  return best;
}

/** The screen a mention opens on, as an open request, when some screen opens its kind. */
function openingOf(kind: string, value: string): Opening | null {
  const address = mentionAddress(kind, value);
  if (!address) return null;
  const url = new URL(address, location.origin);
  const routed = screenOfAddress(offered(), url.pathname, url.search) as { row: Row; input: Record<string, string> | null } | null;
  return routed ? { id: routed.row.id, ...(routed.input ? { surfaceInput: routed.input } : {}) } : null;
}

// Reading the mentions once per opening of the palette; only kinds named by DATA are searched again as words are typed.
const asked = new Map<string, Promise<unknown>>();
const askOnce = <T,>(path: string): Promise<T> => {
  const inFlight = asked.get(path);
  if (inFlight) return inFlight as Promise<T>;
  const request = readJson<T>(path);
  asked.set(path, request);
  void request.catch(() => { if (asked.get(path) === request) asked.delete(path); });
  return request;
};
const mentionsFor = (source: Source, query: string) => Promise.all([
  askOnce<MentionAnswer>('/work/api/mentions'),
  query.length >= 2 && source.typed_kinds?.length
    ? askOnce<MentionAnswer>(`/work/api/mentions?${new URLSearchParams({ q: query, kinds: source.typed_kinds.join(',') })}`)
    : Promise.resolve({} as MentionAnswer),
]);

/** Where a result of the one search opens: a stored file in its own tab at its moment, a record on its screen. */
const searchOpening = (result: SearchResult): Opening | null => (result.identity
  ? fileTab({ id: result.file ?? result.identity, name: result.path || result.name, type: result.media_type, ...(result.timed && result.start > 0 ? { at: result.start } : {}) })
  : result.open);

type CalendarEvent = { id: string; source: string; source_id: string; title: string; about: string | null; location?: string | null; starts_at: string; all_day: boolean };
type CalendarAnswer = { items?: CalendarEvent[]; sources?: { id: string; selection?: { connected_at?: unknown } }[] };
const startOfDay = (when: Date) => new Date(when.getFullYear(), when.getMonth(), when.getDate());
const DAY = 86_400_000;
/** The `calendar.buckets` row the event's day falls in, counted in days from today, or none when it falls in no bucket or outside the days looked ahead. */
const bucketOf = (days: number) => (days < 0 || days >= CALENDAR.look_ahead_days ? undefined
  : CALENDAR.buckets.find(row => ('day' in row ? row.day === days : days >= row.from_day)));

/** Each reader a `sources` row can name: what it finds for the words typed. */
// `still` collects the sources whose answer names places still being searched (the one search's `pending`).
const READERS: Record<string, (source: Source, query: string, still: Set<string>) => Promise<Found[]>> = {
  screens: async (source, query) => offered()
    .filter(row => row.listed !== false && typeof row.label === 'string' && row.id !== settings.surface_id)
    .map(row => ({
      address: `screen:${row.id}`, title: row.label as string, description: row.description ?? '', group: source.group ?? 'Screens',
      icon: row.icon ?? 'Square', score: rank(query, row.label, row.description), source: source.id, open: { id: row.id },
    })),
  mentions: async (source, query) => {
    const [all, found] = await mentionsFor(source, query);
    const kinds = { ...all.kinds, ...found.kinds };
    const seen = new Set<string>();
    return [...(found.candidates ?? []), ...(all.candidates ?? [])].flatMap(one => {
      const address = `${one.kind}:${one.value}`;
      if (seen.has(address)) return [];
      seen.add(address);
      const open = openingOf(one.kind, one.value);
      const searched = (found.candidates ?? []).includes(one);
      return [{
        address, title: one.label, description: one.detail ?? kinds[one.kind]?.label ?? '', group: source.group ?? kinds[one.kind]?.label ?? one.kind,
        icon: kinds[one.kind]?.icon ?? 'Circle', score: searched ? Math.max(2, rank(query, one.label, one.detail)) : rank(query, one.label, one.detail),
        source: source.id, ...(open ? { open } : {}),
      }];
    });
  },
  // The person's coming events, each under the heading of the day it falls on, with its time as its words.
  calendar: async (source, query) => {
    const today = startOfDay(new Date());
    const path = `/work/api/calendar?${new URLSearchParams({ from: today.toISOString(), to: new Date(today.getTime() + CALENDAR.look_ahead_days * DAY).toISOString() })}`;
    const answer = await askOnce<CalendarAnswer>(path);
    return (answer.items ?? []).flatMap(event => {
      const starts = new Date(event.starts_at);
      const bucket = bucketOf(Math.round((startOfDay(starts).getTime() - today.getTime()) / DAY));
      if (!bucket) return [];
      const title = event.title || CALENDAR.words.untitled;
      const time = event.all_day ? CALENDAR.words.all_day : starts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const generation = answer.sources?.find(row => row.id === event.source)?.selection?.connected_at;
      return [{
        address: `calendar-event:${event.source}:${event.id}:${event.starts_at}`, title, description: '', said: event.location ? `${time} · ${event.location}` : time,
        group: bucket.label, icon: CALENDAR.icon, score: rank(query, title, event.location ?? event.about ?? ''), source: source.id,
        open: { id: CALENDAR.open_screen, surfaceInput: { calendar_event: { id: event.id, source: event.source, source_id: event.source_id, starts_at: event.starts_at, source_generation: generation } } },
      }];
    });
  },
  // The one search (src/search.mjs), asked as the source row's DATA says; it uses indexed word matches only.
  search: async (source, query, still) => {
    if (query.trim().length < 2) return [];
    const path = `/work/api/search?${new URLSearchParams({ ...source.ask, q: query.trim() })}`;
    const answer = await askOnce<Partial<SearchAnswer>>(path);
    // An answer still being read is not kept as this query's answer: asked again, the search is read again.
    if (answer.pending?.length) { still.add(source.id); if (asked.get(path)) asked.delete(path); }
    return (answer.results ?? []).flatMap(result => {
      const open = searchOpening(result);
      if (!open) return [];
      const address = result.id.startsWith('record:') ? result.id : `found:${result.id}`;
      return [{ address, title: result.title || result.name, description: result.said ?? result.detail ?? '',
        group: result.kind_label ?? source.group ?? result.source_label, icon: result.identity ? 'FileText' : 'Sparkles',
        score: Math.max(1, rank(query, result.title, result.said ?? '')) + result.score / 10, source: source.id, open,
        ...(result.path ? { also: result.path } : result.found_in?.[0] ? { also: answer.places.find(place => place.id === result.found_in[0])?.label ?? '' } : {}) }];
    });
  },
};

/** What each action's `run` does with the words typed. */
const RUNS: Record<string, (action: Action, query: string) => Promise<void>> = {
  'message-box': async (_action, query) => {
    const host = window as unknown as { trillionComposer?: { open: (draft: { text?: string }) => Promise<void> } };
    await host.trillionComposer?.open({ text: query });
  },
  'send-to-all-ais': async (action, query) => {
    try {
      await sendToAllYourAis({ text: query, files: [], links: [], mentions: [] });
      notify(action.done ?? action.title, { kind: 'done' });
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
  },
};

// What the last search found, by address: the palette reads each result back by its address before drawing it.
const kept = new Map<string, Found>();

async function search(query: string, limitOf: (source: Source) => number, still = new Set<string>()): Promise<Found[]> {
  const blank = !query.trim();
  // Each place results come from and each action is a control the person's show rules decide (parts/command-palette
  // part.json): `palette.source.<id>` and `palette.action.<id>`, so one rule on `palette` holds for every row.
  const sources = SOURCES.filter(source => (!blank || source.blank) && controlShown(`palette.source.${source.id}`));
  const read = (await Promise.all(sources.map(async source => {
    try {
      const rows = await (READERS[source.read]?.(source, query, still) ?? Promise.resolve([]));
      return rows.filter(row => row.score > 0).sort((left, right) => right.score - left.score).slice(0, limitOf(source));
    } catch (error) {
      notify(`Find anything could not search ${source.group ?? 'one of your sources'}. ${errorWords(error)} Try these words again.`, { kind: 'error' });
      return [];
    }
  }))).flat();
  const used = readKept(deviceStore, FRECENCY, Date.now());
  for (const row of read) row.score += bonusFor(used, FRECENCY, row.address, query, Date.now());
  const unique = new Map<string, Found>();
  for (const row of read) if (!unique.has(row.address) || row.score > (unique.get(row.address)?.score ?? 0)) unique.set(row.address, row);
  // One thing two readers find under different addresses is one row; two things with the same title stay separate.
  const identityOf = (row: Found) => canonicalOpeningIdentity(row.open, row.address);
  const found = [...unique.values()].sort((left, right) => right.score - left.score)
    .filter((row, index, rows) => rows.findIndex(other => identityOf(other) === identityOf(row)) === index);
  const sameName = new Map<string, number>();
  for (const row of found) {
    const key = `${row.group}\u0000${row.title.trim().toLocaleLowerCase()}`;
    sameName.set(key, (sameName.get(key) ?? 0) + 1);
  }
  for (const row of found) {
    const key = `${row.group}\u0000${row.title.trim().toLocaleLowerCase()}`;
    // Two of the same name are told apart in the person's words (what they say, then where they were found); never by an address.
    if (sameName.get(key)! > 1 && !row.said) {
      const told = [row.description, row.also].filter(Boolean);
      row.subtitle = told.length ? told.join(' · ') : undefined;
    }
  }
  const actions: Found[] = blank ? [] : ACTIONS.filter(action => controlShown(`palette.action.${action.id}`)).map(action => ({
    address: `action:${action.id}`, title: fill(action.title, query.trim()), description: fill(action.description, query.trim()),
    group: action.group, icon: action.icon, score: 0.5, source: 'actions', run: action,
  }));
  for (const row of [...found, ...actions]) kept.set(row.address, row);
  return [...found, ...actions];
}

/** One result as the palette's result checks read it (parts/command-palette/do-work/ask-palette-sources-by-text.ts). */
const asOwnerRow = (row: Found, query: string) => ({
  canonical_address: row.address,
  canonical_revision: hash([row.title, row.description, row.open ?? row.run?.id ?? null]),
  payload_hash: hash(row),
  owner_target: OPEN_TARGET,
  schema_ref: `trillion.palette.source:${row.source}`,
  schema_digest: hash(SOURCES.find(source => source.id === row.source) ?? ACTIONS),
  authority_provenance_ref: ({ mentions: '/work/api/mentions', calendar: '/work/api/calendar', search: '/work/api/search', actions: 'command-palette.json' } as Record<string, string>)[row.source] ?? 'placeable-surface-list',
  rank_provenance_ref: RANKED_BY,
  descriptor_revision: hash(SOURCES),
  model_provenance_ref: 'none:ranked-by-words-typed',
  score: row.score,
  title: row.title,
  // The shared palette displays this as a subtitle, which also distinguishes same-title records.
  description: row.said ?? row.subtitle ?? '',
  group: row.group,
  icon: row.icon,
  query,
});

// The palette's source descriptor (DATA it reads back as a record): one source, this file's search.
const DESCRIPTOR = {
  kind: 'palette-source-descriptor',
  id: 'trillion.palette.everything',
  dispatch: { target: 'slot::workflow', definition_id: SEARCH_DEFINITION, query_field: 'query', limit_field: 'limit' },
  result_mapping: {
    canonical_address_field: 'canonical_address', canonical_revision_field: 'canonical_revision', payload_hash_field: 'payload_hash',
    owner_target_field: 'owner_target', schema_ref_field: 'schema_ref', schema_digest_field: 'schema_digest',
    authority_provenance_ref_field: 'authority_provenance_ref', score_field: 'score', rank_provenance_ref_field: 'rank_provenance_ref',
    title_field: 'title', description_field: 'description', group_field: 'group', icon_field: 'icon', items_path: ['output'],
    still_looking_path: ['output', 'still_looking'],
  },
  min_query_length: 1,
  result_policy_ref: 'semantic-result-policy:trillion.palette',
  authority_ref: 'trillion.person-store',
  correlation_ref: 'trillion.palette',
  hydration: { definition_id: ITEM_DEFINITION, target: 'slot::workflow', address_field: 'canonical_address', revision_field: 'canonical_revision', payload_hash_field: 'payload_hash' },
};
const POLICY = { kind: 'semantic-result-policy', id: 'trillion.palette', max_result_count: settings.most_results, max_schema_bytes_per_result: 4096, total_prompt_budget_bytes: 65536 };

type FindRequest = { operation?: string; in?: string; limit?: number; where?: { all?: { field: string; in?: unknown[] }[] } };
const asksForDescriptors = (request: FindRequest) => request.where?.all?.some(test => test.field === 'kind' && test.in?.includes(DESCRIPTOR.kind)) ?? false;

answerTarget('slot::find-current-items', async request => {
  const find = (request ?? {}) as FindRequest;
  if (asksForDescriptors(find)) return { items: [DESCRIPTOR, POLICY] };
  // Before anything is typed: the screens, in the sidebar's order.
  const rows = await search('', source => Math.min(source.limit, find.limit ?? source.limit));
  return {
    // Highest first: the palette orders by score, so the sidebar's own order is kept as a falling score.
    items: rows.map((row, index) => ({ id: row.address, address: row.address, target: OPEN_TARGET, title: row.title, description: row.said ?? '', group: row.group, icon: row.icon, score: rows.length - index })),
  };
}, { handles: request => (request as FindRequest | null)?.in === 'published-record' && (request as FindRequest).operation === 'find-current-items' });

type Execute = { operation?: string; definition_id?: string; input?: Record<string, unknown> };
answerTarget('slot::workflow', async request => {
  const { definition_id, input = {} } = (request ?? {}) as Execute;
  if (definition_id === SEARCH_DEFINITION) {
    const query = String(input.query ?? '');
    const still = new Set<string>();
    const rows = await search(query, source => source.limit, still);
    // Sources still searching some places: the palette says it is still looking and asks again (DESCRIPTOR still_looking_path).
    return { output: { items: rows.map(row => ({ address: row.address, score: row.score })), still_looking: [...still] } };
  }
  // Reading one result back by its address, for drawing it.
  const address = String(input.canonical_address ?? '');
  const row = kept.get(address);
  return { output: row ? { item: asOwnerRow(row, '') } : {} };
}, { handles: request => [SEARCH_DEFINITION, ITEM_DEFINITION].includes(String((request as Execute | null)?.definition_id ?? '')) });

/** Opens a result: its screen the way the sidebar opens one (laid over with an open choice), or its action. */
function runResult(row: Found, query: string, extra: Readonly<Record<string, unknown>> = {}) {
  if (row.run) { void RUNS[row.run.run]?.(row.run, query); return; }
  if (row.open) window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { ...row.open, ...extra } }));
}

type Chosen = { caller_request?: { selected_item?: Record<string, unknown>; query_text?: string } };
answerTarget(OPEN_TARGET, request => {
  const chosen = (request ?? {}) as Chosen;
  const item = chosen.caller_request?.selected_item ?? {};
  const row = kept.get(String(item.canonical_address ?? item.address ?? ''));
  if (row) {
    runResult(row, String(chosen.caller_request?.query_text ?? '').trim());
    if (!row.run) recordPick(deviceStore, FRECENCY, row.address, String(chosen.caller_request?.query_text ?? ''), Date.now());
  }
  // What was chosen has been opened or run: the palette's window goes, as a press outside it would close it.
  const open = document.querySelector('[data-command-palette]');
  if (row && open) closeOwnScreen(open);
  return { opened: Boolean(row) };
});

/** The screen a result opens, mounted small in its hover card, as the sidebar's hover card shows a screen. */
function previewOf(row: Found): SurfacePreview | undefined {
  if (!row.open) return undefined;
  const screen = readPlaceableSurfaceRecordFromUnknown(offered().find(one => one.id === row.open?.id));
  if (!screen?.packageEntry) return undefined;
  return {
    label: row.title, icon: row.icon, packageEntry: screen.packageEntry, materialTarget: screen.materialTarget, target: screen.target ?? null,
    surfaceInput: { ...screen.surfaceInput, ...row.open.surfaceInput },
  };
}

// The palette in the window the arrangement gives it: the window is the frame, and closing the palette closes it.
function PaletteScreen({ element }: { element: HTMLElement }) {
  const close = React.useCallback(() => closeOwnScreen(element), [element]);
  const Frame = React.useCallback(({ open, label, children }: CommandPaletteFrameProps) => (open ? (
    <Container layout="vertical" height="full" overflow="hidden" role="dialog" aria-label={label} data-command-palette="">{children}</Container>
  ) : null), []);
  const wrapResult = React.useCallback((result: PaletteSearchResult, row: React.ReactElement) => {
    const found = kept.get(String((result.item.raw as Record<string, unknown>).canonical_address ?? result.item.id));
    if (!found || found.run) return row;
    const query = result.queryText;
    return (
      <SurfacePreviewCard label={found.title} icon={found.icon} description={found.description} preview={previewOf(found)} side="right" control="cards.hover.palette"
        trigger={row as React.ReactElement<Record<string, unknown>>}
        onOpen={() => { runResult(found, query); close(); }}
        actions={found.open ? shownOpenChoices().map(choice => ({ id: choice.id, label: choice.label, icon: choice.icon, onAction: () => { runResult(found, query, withOpenChoice({}, choice)); close(); } })) : []} />
    );
  }, [close]);
  // Everything `@` offers is read once as the palette opens, so the first words typed search what is already here.
  const loaded = useScreenLoad('command-palette', {
    loading: { label: 'Opening Find anything', layout: 'rows' },
    read: async () => {
      try { return await askOnce<MentionAnswer>('/work/api/mentions'); }
      catch (error) { notify(`Find anything could not load your mentions. ${errorWords(error)} Try these words again.`, { kind: 'error' }); return {}; }
    },
    failed: refusal('Find anything could not open'),
  });
  React.useEffect(() => () => { asked.clear(); }, []);
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <CommandPaletteGate open onOpenChange={next => { if (!next) close(); }} frame={Frame} wrapResult={wrapResult} />;
}

/** The Find anything screen, in the window the arrangement gives it. */
export function mountCommandPaletteScreen(element: HTMLElement): () => void {
  return mountReactSurface(element, <PaletteScreen element={element} />);
}

/** Publishes the palette's verb (its keys are rows of keymap.json): it opens Find anything from anywhere, and closes it when it is open. */
export function publishCommandPalette(): void {
  registerVerb('find-anything', (_row, event) => {
    const open = document.querySelector('[data-command-palette]');
    if (open) { closeOwnScreen(open); return; }
    window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: settings.surface_id } }));
    // How long the person waits from the key to the palette ready to type in (felt-speed.ts).
    feltFrom('find-anything', event?.timeStamp ?? performance.now(), () => document.querySelector('[data-command-palette]') !== null);
  });
}
