// src/workspace/file-card.ts
//
// PURPOSE
//   The signed-in page's file cards (parts/ui/show/file-card): for a file a preview shows, everything kept about it
//   and everything this person can do with it, read when the card opens. Installed once by main.tsx
//   (installFileCards), so every hover card and the file's own tab draw the same card.
//
//   A card is read from three places, all the person's own: the results kept beside the file
//   (the files door's read_file_results: its facts, words, speakers, faces, preview), the Workshop tools and screens
//   that take a file of its kind (menu-rows.tsx offeredFor, read once per kind per page, the same read every ⋯
//   menu about a file uses; the card's ⋯ offers every row the page has for the file, `about`), and the file's folder
//   (the files door's list_files, listed once per folder per page) for the files beside it, their pictures through the page's
//   one preview reader (made-previews.ts). Its order, facts, suggestions and words are DATA
//   (file-card.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No action is named here: every button is a tool or screen the Workshop offered for this file, so a person never
//      sees a button for a tool they cannot run. A suggestion shows only when its rule holds (the formula engine's
//      filterRowsByRules, the one rule primitive) and its action is offered.
//   2. Every part the card shows also asks the person's show rules (showOf, subject `file-card`), so any action,
//      section or suggestion can be hidden or held by a rule like everything else.
//   3. A run is the same run a tool's own screen starts (workshop-tool-api.ts, POST /work/api/door/tools:run), under a
//      fresh key per press; when it finishes, every card drawn reads again.
//   4. Who said what is the speakers result as kept (a voice not yet named, or one that could be several people,
//      reads as kept: "Someone (voice-2)", "Unsure (Sam or Alex?)"); nothing is guessed.
//   5. Only a file of this person's namespace has a card; any other preview is left as it is.

import data from './file-card.json';
import { readFileLookup, readListing, fileResults } from './api';
import { offeredScreens, openFile } from './open-screen';
import { carriedOf, doOffered, offeredFor, onOfferedRan, type Offered } from './menu-rows';
import { readWorkspacePreference, writeWorkspacePreference } from './records';
import { filterRowsByRules } from './record-filter';
import { previewStore } from './preview-store';
import { showOf } from '../../parts/ui/show/show-rules/show-of';
import { provideFileCards, type FileCardAction, type FileCardSource, type FileCardSubject, type FileCardTurn, type FileCardView } from '../../parts/ui/show/file-card';
import type { FactField } from '../../parts/ui/show/fact-chips/FactChips';

type Kept = { results: { kind: string; value: any }[] };
type Found = { byte_length?: number; names?: string[] };
type Named = { names: { name: string; identity: string; media_type?: string | null; stored?: boolean }[] };
type Speaker = { start?: number; end?: number; who?: string; me?: boolean; unsure?: string[]; text?: string };

const SUBJECT = 'file-card';
const BYTES = /\/work\/api\/namespace\/bytes\/([^?#/]+)/;
const IDENTITY = /^(1f|12):[0-9a-f]{64}$/;
const UNKNOWN = new RegExp(data.unknown_voice);
const ORDER = 'file-card-action-order';

/** The namespace identity a preview shows, from its address or its id; null for anything else. */
export function identityOf(subject: FileCardSubject): string | null {
  const found = subject.url ? BYTES.exec(subject.url) : null;
  const named = found ? decodeURIComponent(found[1]) : subject.id;
  return IDENTITY.test(named) ? named : null;
}

const kindOf = (type: string) => type.split('/')[0] || 'file';
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/';
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const shown = (thing: Record<string, unknown>) => !showOf(SUBJECT, thing).hidden;


/** What was said, turn by turn: the speakers result when one is kept (each turn with who said it), else the words. */
export function turnsOf(speakers: Speaker[] | undefined, segments: { start?: number; text?: string }[] | undefined): FileCardTurn[] {
  if (speakers?.length) return speakers.filter(turn => turn.text?.trim()).map((turn, index) => ({
    id: `turn-${index}`, text: turn.text!.trim(), who: turn.who, ...(turn.unsure?.length ? { unsure: true } : {}),
    ...(turn.me ? { me: true } : {}), ...(Number.isFinite(turn.start) ? { start: turn.start } : {}),
  }));
  return (segments ?? []).filter(segment => segment.text?.trim()).map((segment, index) => ({
    id: `said-${index}`, text: segment.text!.trim(), ...(Number.isFinite(segment.start) ? { start: segment.start } : {}),
  }));
}

/** The people a file holds: every speaker and every face named in its kept results, each once. */
export function peopleOf(speakers: Speaker[] | undefined, faces: { who?: { name?: string } | null; unsure?: { name?: string }[] }[] | undefined) {
  const seen = new Map<string, { id: string; name: string; unsure?: boolean }>();
  for (const turn of speakers ?? []) if (turn.who && !seen.has(turn.who)) seen.set(turn.who, { id: turn.who, name: turn.who, ...(turn.unsure?.length ? { unsure: true } : {}) });
  for (const face of faces ?? []) {
    const name = face.who?.name ?? (face.unsure?.length ? face.unsure.map(person => person.name).join(' or ') : null);
    if (name && !seen.has(name)) seen.set(name, { id: name, name, ...(face.who ? {} : { unsure: true }) });
  }
  return [...seen.values()];
}

/** The card's fact row: the values its chips show and its rules read. */
export function factsOf(type: string, kept: Record<string, any>, found: Found | null, people: { name: string }[], path: string | null) {
  const facts = kept.facts ?? {};
  const transcript = kept.transcript;
  const segments: { end?: number }[] = transcript?.segments ?? [];
  const words = typeof transcript?.text === 'string' ? transcript.text.split(/\s+/).filter(Boolean).length : undefined;
  const captured = Date.parse(facts.captured_at ?? '');
  return {
    kind: kindOf(type),
    duration: Number.isFinite(facts.duration) ? facts.duration : segments.at(-1)?.end,
    captured_at: Number.isFinite(captured) ? captured : undefined,
    place: facts.place, camera: facts.camera, resolution: facts.resolution,
    words, language: transcript?.language,
    people: people.length || undefined,
    unnamed: people.filter(person => UNKNOWN.test(person.name)).length,
    bytes: found?.byte_length,
    folder: path ? folderOf(path) : undefined,
  } as Record<string, unknown>;
}

/** The suggestions whose rule holds for this file and whose action the card offers. */
async function suggestionsOf(row: Record<string, unknown>, offered: Offered[]) {
  const held = await Promise.all(data.suggestions.map(async suggestion => {
    if (!offered.some(action => action.id === suggestion.action)) return null;
    if (!shown({ part: 'suggestion', id: suggestion.id })) return null;
    const { matches } = await filterRowsByRules({ tree: suggestion.when, fields: data.fact_kinds, rows: [row] }).catch(() => ({ matches: [] as number[] }));
    return matches.length ? { id: suggestion.id, label: suggestion.label, icon: suggestion.icon, action: suggestion.action } : null;
  }));
  return held.filter((item): item is NonNullable<typeof item> => item !== null);
}

// The actions in the person's own order, then the lead order, then as the Workshop listed them.
function ordered(offered: Offered[]): Offered[] {
  const mine = readWorkspacePreference<string[]>(ORDER) ?? [];
  const rank = (id: string) => {
    const own = mine.indexOf(id);
    if (own >= 0) return own;
    const lead = data.lead.indexOf(id);
    return lead >= 0 ? mine.length + lead : mine.length + data.lead.length;
  };
  return offered.map((action, index) => ({ action, index })).sort((a, b) => rank(a.action.id) - rank(b.action.id) || a.index - b.index).map(({ action }) => action);
}

/** The file card source this page installs. */
export function fileCards(): FileCardSource {
  const listeners = new Set<() => void>();
  const pathOf = new Map<string, string>();
  // Each folder is listed once per page, however many of its files are hovered.
  const folders = new Map<string, Promise<Named>>();
  const offeredNow = new Map<string, Offered[]>();

  // The files in the same folder, nearest by name first, with their small pictures.
  async function relatedOf(identity: string, path: string | null, type: string) {
    if (!path || !data.related || !shown({ part: 'related' })) return [];
    const folder = folderOf(path);
    if (!folders.has(folder)) folders.set(folder, readListing<Named>(folder, { limit: 200 }).catch(() => { folders.delete(folder); return { names: [] }; }));
    const listed = await folders.get(folder)!;
    const siblings = listed.names.filter(entry => entry.identity !== identity && entry.stored !== false);
    const same = siblings.filter(entry => kindOf(entry.media_type ?? '') === kindOf(type));
    const near = (same.length ? same : siblings).sort((a, b) => a.name.localeCompare(b.name));
    const at = near.findIndex(entry => entry.name.localeCompare(path) > 0);
    const around = at < 0 ? near.slice(-data.related) : near.slice(Math.max(0, at - Math.floor(data.related / 2))).slice(0, data.related);
    // Their small pictures through the page's one preview reader, which asks for every picture wanted at once.
    const posters = await Promise.all(around.map(entry => previewStore.read(entry.identity).then(made => (made as { poster?: string } | null)?.poster, () => undefined)));
    for (const entry of around) pathOf.set(entry.identity, entry.name);
    return around.map((entry, index) => ({ id: entry.identity, title: baseName(entry.name), detail: entry.name, ...(posters[index] ? { poster: posters[index] } : {}) }));
  }

  async function read(subject: FileCardSubject): Promise<FileCardView | null> {
    const identity = identityOf(subject);
    if (!identity) return null;
    const type = subject.type ?? '';
    const [keptAnswer, found, offered] = await Promise.all([
      fileResults.read<Kept>(identity).catch(() => ({ results: [] })),
      readFileLookup<Found>(identity).catch(() => null),
      offeredFor(carriedOf({ kind: 'file', id: identity }), { type, name: subject.title }).catch(() => [] as Offered[]),
    ]);
    const kept: Record<string, any> = {};
    for (const result of keptAnswer.results) kept[result.kind] ??= result.value;
    const path = found?.names?.[0] ?? pathOf.get(identity) ?? null;
    if (path) pathOf.set(identity, path);
    const speakers: Speaker[] | undefined = kept.speakers?.speakers;
    const people = peopleOf(speakers, kept.faces?.faces ?? kept.speakers?.faces);
    const row = factsOf(type, kept, found, people, path);
    // A screen opens only when it is one this person is offered (a screen their plan holds back is never a button).
    const screens = new Set(offeredScreens().map(screen => screen.id));
    const actions = ordered(offered).filter(action => (action.kind !== 'open' || screens.has(action.surface!)) && shown({ part: 'action', id: action.id }));
    offeredNow.set(identity, actions);
    const [suggestions, related] = await Promise.all([suggestionsOf(row, actions), relatedOf(identity, path, type)]);
    return {
      facts: { fields: data.facts as FactField[], values: row, label: data.said.facts },
      actions: actions.map(({ id, label, icon, about }) => ({ id, label, icon, ...(about ? { about } : {}) })),
      lead: data.lead_count,
      // The ⋯ menu offers every row the page has for this file (menu-rows.tsx): its tools in their folders, the
      // person's saved actions, a message box to their AI, formats.
      about: { kind: 'file', id: identity, title: subject.title, media_type: type, name: path ? baseName(path) : subject.title, ...(path ? { path } : {}), ...(subject.url ? { url: subject.url } : {}), share: { kind: ['image', 'video', 'audio'].includes(kindOf(type)) ? kindOf(type) : 'file', name: path ? baseName(path) : subject.title, file: identity } },
      people: shown({ part: 'people' }) ? people : [],
      words: shown({ part: 'words' }) ? turnsOf(speakers, kept.transcript?.segments) : [],
      related,
      suggestions,
      said: data.said,
    };
  }

  const announce = () => { for (const listener of listeners) listener(); };
  // A tool run from a card or from any ⋯ menu can change what is known about a file, so every card reads again.
  onOfferedRan(announce);

  return {
    read,
    async act(subject, actionId) {
      const identity = identityOf(subject);
      const action = identity ? offeredNow.get(identity)?.find(item => item.id === actionId) : undefined;
      if (!identity || !action) throw new Error('This can no longer be done here.');
      return doOffered(action, carriedOf({ kind: 'file', id: identity }), { identity, name: subject.title, type: subject.type ?? '', path: pathOf.get(identity) ?? null, bytes: (subject.url ?? '').split('#')[0] });
    },
    open(subject, { related, at }) {
      const identity = related ?? identityOf(subject);
      if (!identity) return;
      openFile({ id: identity, name: related ? pathOf.get(related) ?? null : subject.title, ...(related ? {} : { type: subject.type }), ...(at ? { at } : {}) });
    },
    reorder(_subject, ids) { void writeWorkspacePreference(ORDER, ids); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Installs the page's file cards; the hover cards and the file tab draw them from then on. */
export function installFileCards(): void {
  provideFileCards(fileCards());
}
