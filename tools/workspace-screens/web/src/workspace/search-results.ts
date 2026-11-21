// src/workspace/search-results.ts
//
// PURPOSE
//   What a screen needs to show the one search (src/search.mjs, GET /work/api/search): the fields each result is drawn
//   with in the shared record views (its picture at the moment it matched, its name, where it was found, the words
//   found there, the moment, where it comes from), a quick view per place (Said, Seen, Name, Notes and text) that
//   filters to it, opening a result where it lives, and asking again while a place is still working.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Places come from the answer; the files search answers its one place, named by search-words.json.
//   2. Every result drawn came back from the search owner; nothing is matched or guessed here.
//   3. A place still working (a picture model starting) is asked again a few times, then the answer stands as it is.
//   4. Every control is a shared component: record views draw the list, MediaPreview the pictures.

import { fileTab } from './open-screen';
import type { FieldDescriptor } from '../../../../ui/show/record-views/record-views';
import { mediaPreviewContent } from '../../../../ui/show/media-preview';
import { PLACEABLE_SURFACE_MIME } from '../../../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { files } from './api';
import searchWords from './search-words.json';
import { filePicture } from './file-picture';

export type SearchPlace = { place: string; label: string; start?: number; said: string | null; score: number };
export type SearchResult = {
  id: string; source: string; source_label: string; kind_label: string | null; title: string; name: string; detail: string | null;
  identity: string | null; file: string | null; stored: boolean; bytes: string | null; media_kind: string | null; media_type: string | null;
  duration: number | null; path: string | null; url: string | null; open: { id: string; title?: string; surfaceInput?: Record<string, unknown> } | null;
  found_in: string[]; places: SearchPlace[]; moments: { start: number; end: number; timed: boolean; said: string | null; places: string[] }[];
  start: number; end: number; timed: boolean; said: string | null; score: number;
};
type Lane = { lane: string; place: string; source: string; reason?: string };
export type SearchAnswer = {
  question: string; places: { id: string; label: string }[]; sources: { id: string; label: string }[];
  results: SearchResult[]; unavailable: Lane[]; pending: Lane[];
};

const clock = (seconds: number) => { const whole = Math.max(0, Math.round(seconds)); const hours = Math.floor(whole / 3600); const rest = `${Math.floor(whole % 3600 / 60)}:${String(whole % 60).padStart(2, '0')}`; return hours ? `${hours}:${rest.padStart(5, '0')}` : rest; };
const labelOf = (answer: SearchAnswer, place: string) => answer.places.find(item => item.id === place)?.label ?? place;
export const FOUND_IN = 'found_in';

/** The fields a result is drawn with. */
export function searchFields(answer: SearchAnswer): FieldDescriptor[] {
  return [
    { id: 'preview', label: 'Preview', icon: 'Image', kind: 'thumbnail', width: 96, read: () => '',
      // A stored file shows its kind's picture (file-previews.json; a video, its frame at the found second); anything else
      // (GitHub, Trillion) the mark of where it was found.
      render: (result: SearchResult) => (result.identity
        ? filePicture({ name: result.name, kind: result.media_kind, mediaType: result.media_type, identity: result.file, bytes: result.bytes, title: result.title, at: result.start })
        : mediaPreviewContent({ renderer: 'type-icon', title: result.title, icon: result.source === 'trillion' ? 'Sparkles' : 'Globe', typeLabel: result.kind_label ?? result.source_label })) },
    { id: 'title', label: 'Name', icon: 'FileText', ruleKind: 'text', filterable: true, sortable: true, width: 280, read: (result: SearchResult) => result.title },
    { id: FOUND_IN, label: 'Found in', icon: 'Search', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180,
      read: (result: SearchResult) => result.found_in.map(place => labelOf(answer, place)),
      values: Object.fromEntries(answer.places.map(place => [place.label, { tone: 'neutral' }])) },
    { id: 'said', label: 'What was found', icon: 'Quote', kind: 'excerpt', width: 420, read: (result: SearchResult) => result.said ?? '' },
    { id: 'at', label: 'At', icon: 'Clock', sortable: true, width: 80, read: (result: SearchResult) => (result.timed ? clock(result.start) : ''), sortValue: (result: SearchResult) => result.start },
    { id: 'source', label: 'From', icon: 'Layers', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 110, read: (result: SearchResult) => result.source_label },
    { id: 'kind', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 150, hiddenByDefault: true, read: (result: SearchResult) => result.kind_label ?? result.media_kind ?? '' },
  ];
}

/** One quick view per place: the results found there. */
export const placeViews = (answer: SearchAnswer) => answer.places.map(place => ({
  id: `found-in-${place.id}`, label: place.label, search: '',
  rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: FOUND_IN, operator: 'is_any_of', params: { values: [place.label] } }] },
}));

/** Where a result opens: a file in its own tab at its moment, a record on its screen, a service item on its site. */
export function openResult(result: SearchResult) {
  const surface = result.identity
    ? fileTab({ id: result.file ?? result.identity, name: result.path || result.name, type: result.media_type, ...(result.timed && result.start > 0 ? { at: result.start } : {}) })
    : result.open;
  if (surface) { window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: surface })); return; }
  if (result.url) window.open(result.url, '_blank', 'noopener');
}

const FILE_SEARCH_LIMIT = 60;

/**
 * Asks the files search (tool:your-files `search`: the words of the person's file names, one question) and hands its answer
 * to `onAnswer` in the shape a screen draws. The files search has no places or sources of its own, so the one place it
 * answers is named by search-words.json. Answers a stop function (a stop before the answer lands drops it).
 */
export function askSearch(question: string, onAnswer: (answer: SearchAnswer) => void, onFailure: (error: unknown) => void) {
  let stopped = false;
  files.read('search', { question, limit: FILE_SEARCH_LIMIT }).then(found => {
    if (stopped) return;
    const answer = found as { question: string; results: SearchResult[]; unavailable?: Lane[]; pending?: Lane[] };
    onAnswer({ question: answer.question, places: [{ id: 'name', label: searchWords.file_names }], sources: [], results: answer.results, unavailable: answer.unavailable ?? [], pending: answer.pending ?? [] });
  }, error => { if (!stopped) onFailure(error); });
  return () => { stopped = true; };
}
