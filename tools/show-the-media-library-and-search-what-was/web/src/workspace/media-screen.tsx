// src/workspace/media-screen.tsx
//
// PURPOSE
//   Media: the person's recordings and the files their tools made, over the same namespace as Files. Above the list,
//   one suggestion of what to make next (three clips, why, Edit these / Another / Not now), each clip previewed in the
//   shared hover preview as one carousel. The list is the shared record views (cards, list, board; grouped by date or
//   by folder as a nested tree; filtered; a Made view), with every fact kept about each file as a field (when and where
//   it was captured, its camera, the person's own fields, file-facts.json), which the person can add to and edit in
//   place and which the file's own bytes fill once (file-facts-store.ts). Typing a search turns the list into MOMENTS:
//   each card is the frame at the second the words are said or the picture shows them (the one search, src/search.mjs), with the words; opening one
//   plays the recording from that second, and Edit puts that stretch into a new edit.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every row is a recording the person's library recorded or a file a tool made (GET
//      /work/api/media/library, src/media-library.mjs); every moment was measured (src/media-search.mjs).
//   2. The first signed-in page reads at most 60 recent rows; Show more follows a revision-bound cursor. Search still
//      reaches the whole namespace, and the full library stays available to tools that explicitly ask for all rows.
//   3. Previews are the shared ones: HoverPreview for the suggestion and every row (previewFields), MediaPreview's
//      `video-frame` for a moment's frame, made stills from the one made-preview store (made-previews.ts).
//   4. Fields and views are DATA below; the editor is opened through the arrangement (surface trillion.media-edit)
//      with the clips and their seconds, so the Library never imports the editor. Every clip it sends has a real
//      `out` (a measured length or a moment's end): a recording whose length is unknown is never sent or suggested.
//   6. Delete and Archive (one action per state in src/namespace-set-aside.json, through set-aside.ts) take a recording
//      with every name it has out of view into Recently Deleted or Archived; the library leaves it out until put back.
//   5. Every control is a shared component (record views, NextStepCard, notifications, loading and failed states).

import { fileTab as openingFile } from './open-screen';
import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { Button } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { loadScreen, ScreenState } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import { mountNextStepCard } from '../../parts/ui/show/next-step-card';
import type { NextStepMedia } from '../../parts/ui/show/next-step-card';
import { primeSavedPreview, readOrMakePreview, settledPreview, type MadePreview } from '../../parts/ui/show/media-preview';
import { PLACEABLE_SURFACE_MIME, setPlaceableSurfaceDragData } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import timelineLevels from '../../parts/ui/show/record-views/timeline-zoom-levels.json';
import { recordFilter } from './record-filter';
import noteList from './note-list-menu.json' with { type: 'json' };
import { downloadTranscriptPdf } from './note-list';
import { recencyGroup, recencyValues } from './recency-group.mjs';
import { previewStore } from './made-previews';
import { contentTypeOf, filePicture } from './file-picture';
import { readJson, fileResults } from './api';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { releaseNode } from '../../parts/ui/show/one-owner-per-node';
import { DockedComposer } from './global-composer';
import { refusal } from './failure';
import { askSearch, type SearchAnswer } from './search-results';
import { setAsideActions } from './set-aside';
import { canTranscribe, transcribeRecordings } from './media-transcribe';
import { editedFact, factFields, findFactField, personFieldKinds } from './file-facts.mjs';
import { addPersonField, personFields, readFactsFromFiles, setFacts } from './file-facts-store';
import { copyPublicLink, openShareVia, shareAction } from './sharing-sheet';
import { addSelectedToTrayAction } from './tray';
import { observedMediaKind, observedMediaType } from '../file-type.mjs';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Row = { identity: string; file: string | null; origin: string; name: string; title: string | null; path: string | null; media_kind: string | null; media_type: string | null; stored: boolean; bytes: string | null; captured_ms: number | null; duration: number | null; facts: Record<string, unknown> | null; edits: number | null; words: number | null; preview?: MadePreview };
type Library = { revision: string; reset?: boolean; next_after?: string | null; origin_labels?: Record<string, string>; rows?: Row[] };
type Moment = { id: string; identity: string; file: string | null; name: string; title: string; media_kind: string | null; media_type: string | null; stored: boolean; bytes: string | null; duration: number | null; start: number; end: number; timed: boolean; said: string | null; lanes: string[]; score: number };
type Clip = { identity: string; file: string | null; name: string; title: string; duration: number | null; bytes: string | null; media_type: string | null; media_kind: string | null };
type Pick = { title: string; reason: string; clips: Clip[] };
type NextEdit = { state: string; pick?: Pick; count?: number; destination?: { id: string; label: string; providerSlug?: string } | null; destinations?: { id: string; label: string; providerSlug?: string }[] };

const clock = (seconds: number) => { const whole = Math.max(0, Math.round(seconds)); const hours = Math.floor(whole / 3600); const rest = `${Math.floor(whole % 3600 / 60)}:${String(whole % 60).padStart(2, '0')}`; return hours ? `${hours}:${rest.padStart(5, '0')}` : rest; };
const typeOf = (row: { name: string; media_type: string | null; media_kind: string | null }) => contentTypeOf(row.name, row.media_type) || (row.media_kind ? `${row.media_kind}/*` : '');
const folderOf = (row: Row) => { const path = row.path ?? ''; const cut = path.lastIndexOf('/'); return cut > 0 ? path.slice(0, cut) : ''; };
const availabilityRule = (value: string) => ({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'stored', operator: 'is_any_of', params: { values: [value] } }] });
const allMediaRule = { kind: 'group', combinator: 'and', negate: false, rules: [] };

// Every folder a row sits in, and each of its parents, as a tree the record views group by (`parent`).
function folderTree(rows: Row[]) {
  const values: Record<string, { label: string; parent?: string }> = {};
  for (const row of rows) {
    const folder = folderOf(row);
    if (!folder) continue;
    const parts = folder.split('/');
    parts.forEach((part, index) => {
      const id = parts.slice(0, index + 1).join('/');
      values[id] ??= { label: part, ...(index ? { parent: parts.slice(0, index).join('/') } : {}) };
    });
  }
  return values;
}

// The request that opens a recording in its own tab at a second (file-screen.tsx), by click, drag or preview.
const fileTab = (item: { file: string | null; identity: string; name: string; path?: string | null; media_type: string | null; media_kind: string | null }, at = 0) =>
  openingFile({ id: item.file ?? item.identity, name: item.path || item.name, type: typeOf(item), at });
// The editor, opened through the arrangement with the clips and the stretch of each it uses.
const editTab = (title: string, clips: { identity: string; file: string | null; name: string; in: number; out: number; duration: number | null; bytes: string | null; media_type: string | null }[]) =>
  ({ id: 'trillion.media-edit', title, surfaceInput: { editId: crypto.randomUUID(), title, clips } });
const open = (surface: Record<string, unknown>) => { const request = new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: surface }); window.dispatchEvent(request); return request.defaultPrevented; };

export function mountMediaScreen(element: HTMLElement, _props: { surfaceInput?: Record<string, unknown> }): () => void {
  let disposed = false;
  let library: Library | null = null;
  let found: SearchAnswer | null = null;
  let searchFailed = false;
  let question = '';
  let chosenView: string | undefined;
  let selectedMediaView = 'ready';
  let shownMediaView = 'ready';
  let loadingMore = false;
  let stopAsking = () => {};
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let releaseNext: (() => void) | null = null;
  const next = document.createElement('section');
  next.className = 'trillion-media-next';
  next.hidden = true;
  const list = document.createElement('div');
  list.className = 'trillion-media';
  // The Ask bar docked under the list (DockedComposer in global-composer.tsx).
  const askBar = document.createElement('div');
  askBar.className = 'trillion-media-ask sticky bottom-0 z-10';
  element.replaceChildren(next, list, askBar);
  mountSharedContent(askBar, <DockedComposer />);

  const pageAddress = (after?: string | null, revision?: string) => {
    const query = new URLSearchParams({ limit: '60' });
    if (selectedMediaView === 'ready') query.set('stored', 'true');
    if (selectedMediaView === 'elsewhere') query.set('stored', 'false');
    if (selectedMediaView === 'made') query.set('origin', 'made');
    if (selectedMediaView === 'unused') query.set('unused', 'true');
    if (after) query.set('after', after);
    if (revision) query.set('revision', revision);
    return `/work/api/media/library?${query}`;
  };

  const primePagePosters = (rows: Row[]) => {
    for (const row of rows) if (row.file && row.preview) primeSavedPreview(row.file, typeOf(row), row.preview);
  };

  const readMore = async () => {
    if (loadingMore || !library?.next_after) return;
    const before = library;
    const view = selectedMediaView;
    loadingMore = true;
    void drawList();
    try {
      const page = await readJson<Library>(pageAddress(before.next_after, before.revision));
      if (disposed || view !== selectedMediaView || library !== before) return;
      if (page.reset) {
        stopReading();
        library = page;
        primePagePosters(page.rows ?? []);
        readFromFiles(page.rows ?? []);
      } else {
        const seen = new Set(before.rows?.map(row => row.identity) ?? []);
        const added = (page.rows ?? []).filter(row => !seen.has(row.identity));
        library = { ...page, rows: [...(before.rows ?? []), ...added] };
        primePagePosters(added);
        readFromFiles(added);
      }
    } catch (error) {
      notify('More media could not load', { kind: 'error', detail: errorWords(error) });
    } finally {
      loadingMore = false;
      if (!disposed && view === selectedMediaView) void drawList();
    }
  };

  // ----- the suggestion -----
  let nextEdit: NextEdit | null = null;
  const posters = new Map<string, string>();
  const drawNext = () => {
    const pick = nextEdit?.state === 'ready' ? nextEdit.pick : undefined;
    next.hidden = !pick;
    if (!pick) { releaseNext?.(); releaseNext = null; return; }
    const media: NextStepMedia[] = pick.clips.map(clip => ({
      id: clip.identity, alt: clip.title, src: posters.get(clip.identity) ?? '',
      preview: clip.bytes ? { id: clip.identity, title: clip.title, url: clip.bytes, type: typeOf(clip), poster: posters.get(clip.identity) } : undefined,
    }));
    releaseNext = mountNextStepCard(next, {
      title: pick.title, reason: pick.reason, media,
      actions: [{ id: 'edit', label: 'Edit these', primary: true }, ...((nextEdit?.count ?? 0) > 1 ? [{ id: 'another', label: 'Another' }] : []), { id: 'not-now', label: 'Not now' }],
      destination: nextEdit?.destination ?? null, destinations: nextEdit?.destinations ?? [],
      onAction: id => {
        if (id !== 'edit') { void act({ action: id }); return; }
        const clips = pick.clips.map(clip => ({ identity: clip.identity, file: clip.file, name: clip.name, in: 0, out: clip.duration!, duration: clip.duration, bytes: clip.bytes, media_type: clip.media_type }));
        if (open(editTab(pick.title, clips))) {
          void act({ action: 'started', identities: pick.clips.map(clip => clip.identity) });
        } else notify('The editor could not open', { kind: 'error' });
      },
      onDestination: id => void act({ action: 'destination', id }),
      onMedia: id => { const clip = pick.clips.find(item => item.identity === id); if (clip) open(fileTab(clip)); },
    });
    // Each clip's still, read from where it is kept or made once from the clip itself, then drawn in place.
    for (const clip of pick.clips) {
      if (posters.has(clip.identity) || !clip.bytes || !clip.file) continue;
      posters.set(clip.identity, '');
      void readOrMakePreview(clip.file, clip.bytes, typeOf(clip), previewStore).then(made => { if (made?.poster && !disposed) { posters.set(clip.identity, made.poster); drawNext(); } });
    }
  };
  const showNext = (reply: NextEdit) => { nextEdit = reply; if (!disposed) drawNext(); };
  const readNext = () => readJson<NextEdit>('/work/api/media/next-edit').then(showNext, () => showNext({ state: 'failed' }));
  const act = (input: Record<string, unknown>) => readJson<NextEdit>('/work/api/media/next-edit', { method: 'POST', body: JSON.stringify(input) })
    .then(showNext, error => notify('The suggestion could not change', { kind: 'error', detail: errorWords(error) }));

  // ----- the rows and the moments -----
  const originLabel = (row: Row) => library?.origin_labels?.[row.origin] ?? row.origin;
  const fields = (rows: Row[]): FieldDescriptor[] => [
    { id: 'preview', label: 'Preview', icon: 'Image', kind: 'thumbnail', width: 72, read: () => '',
      // The picture each kind shows is the Files screen's DATA (file-previews.json), so a new kind is one row there.
      render: (row: Row) => filePicture({ name: row.name, kind: row.media_kind, mediaType: row.media_type, identity: row.file, bytes: row.file ? row.bytes : null, title: row.title ?? row.name, ...(row.stored ? {} : { typeLabel: 'Original elsewhere' }) }) },
    { id: 'title', label: 'Title', icon: 'Type', ruleKind: 'text', filterable: true, sortable: true, width: 280, read: (row: Row) => row.title ?? row.name },
    { id: 'stored', label: 'Original', icon: 'CloudCheck', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 150, read: (row: Row) => (row.stored ? 'Ready here' : 'Original elsewhere'), values: { 'Ready here': { tone: 'success' }, 'Original elsewhere': { tone: 'warning' } } },
    // Today / Last week / Previous 30 days / Past: the groups are DATA (note-list-menu.json), counted from now.
    { id: 'recency', label: noteList.recency.field_label, icon: 'CalendarClock', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 140, hiddenByDefault: true, read: (row: Row) => recencyGroup(row.captured_ms, Date.now()), values: recencyValues() },
    { id: 'name', label: 'File name', icon: 'FileText', ruleKind: 'text', filterable: true, sortable: true, width: 200, hiddenByDefault: true },
    { id: 'origin', label: 'Made by', icon: 'Sparkles', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 120, read: originLabel },
    { id: 'folder', label: 'Folder', icon: 'Folder', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 220, read: folderOf, values: folderTree(rows) },
    // Length, when and where it was captured, its camera, and the person's own fields: the facts kept about the file.
    ...(factFields(rows, personFields()) as FieldDescriptor[]),
    { id: 'words', label: 'Words said', icon: 'MessageSquareText', ruleKind: 'number', filterable: true, sortable: true, width: 110, read: (row: Row) => (row.words === null ? '' : String(row.words)), factValue: (row: Row) => row.words, sortValue: (row: Row) => row.words ?? -1 },
    { id: 'used', label: 'Used', icon: 'Scissors', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 110, read: (row: Row) => ((row.edits ?? 0) > 0 ? 'In an edit' : 'Not used yet'), values: { 'In an edit': { tone: 'success' }, 'Not used yet': { tone: 'neutral' } } },
  ];
  // A moment: the frame at its second, what is said there, which recording, and when.
  const MOMENT_FIELDS: FieldDescriptor[] = [
    { id: 'frame', label: 'Moment', icon: 'Image', kind: 'thumbnail', width: 120, read: () => '',
      render: (moment: Moment) => filePicture({ name: moment.name, kind: moment.media_kind, mediaType: moment.media_type, identity: moment.file, bytes: moment.bytes, title: moment.title, at: moment.start, ...(moment.stored ? {} : { typeLabel: 'Original elsewhere' }) }) },
    { id: 'said', label: 'Said there', icon: 'Quote', kind: 'excerpt', width: 420, read: (moment: Moment) => moment.said ?? '' },
    { id: 'title', label: 'Recording', icon: 'FileVideo', sortable: true, width: 220, read: (moment: Moment) => moment.title },
    { id: 'at', label: 'At', icon: 'Clock', sortable: true, width: 80, read: (moment: Moment) => (moment.timed ? clock(moment.start) : ''), sortValue: (moment: Moment) => moment.start },
    { id: 'why', label: 'Found by', icon: 'Search', kind: 'tag', groupable: true, width: 160, read: (moment: Moment) => moment.lanes.map(place => found?.places.find(item => item.id === place)?.label ?? place) },
  ];

  const recordPreview = (item: Row | Moment) => (item.bytes ? { url: item.bytes, type: typeOf(item), label: item.title ?? item.name, ...('file' in item && item.file ? (made => (made ? { poster: made.poster, frames: made.frames, peaks: made.peaks } : {}))(settledPreview(item.file)) : {}) } : null);
  const drawList = () => {
    if (!library?.rows) return;
    // A photo library opens on recent pictures, even when its catalog also has undated entries.
    // Keep the server's order within one date; the shared timeline preserves the order it receives.
    const rows = [...library.rows].sort((left, right) => (right.captured_ms ?? -1) - (left.captured_ms ?? -1));
    const ready = rows.filter(row => row.stored).length;
    const indexed = rows.length - ready;
    const searching = Boolean(question.trim());
    const answer = found?.question === question ? found : null;
    // Each recording the one search found, one row per moment it matched at (src/search.mjs).
    const moments: Moment[] = searching && answer ? answer.results.filter(result => result.identity).flatMap(result => result.moments.map(moment => ({
      id: `${result.identity}@${moment.start}`, identity: result.identity!, file: result.file, name: result.name, title: result.title, media_kind: result.media_kind, media_type: result.media_type,
      stored: result.stored, bytes: result.bytes, duration: result.duration, start: moment.start, end: moment.end, timed: moment.timed, said: moment.said ?? result.said, lanes: moment.places, score: result.score,
    }))) : [];
    const byId = new Map<string, Row | Moment>([...rows.map(row => [row.identity, row] as const), ...moments.map(moment => [moment.id, moment] as const)]);
    const shareRecord = (item: Row | Moment) => item.file ? `file:${item.file}` : null;
    const share = shareAction((id: string) => byId.get(id), shareRecord, (item: Row | Moment) => item.title ?? item.name);
    const addToTray = addSelectedToTrayAction(list, (id: string) => byId.get(id), shareRecord, (item: Row | Moment) => item.title ?? item.name);
    const openItem = (id: string) => { const item = byId.get(id); if (!item) return; open(fileTab(item, 'start' in item ? item.start : 0)); };
    const editItems = (ids: string[]) => {
      // Only what can play and whose end is known goes into an edit: every clip's `out` is a real second.
      const items = ids.map(id => byId.get(id)).filter((item): item is Row | Moment => Boolean(item?.bytes) && ('start' in item || Number(item?.duration) > 0));
      if (!items.length) return;
      const clips = items.map(item => ('start' in item
        ? { identity: item.identity, file: item.file, name: item.name, in: item.start, out: item.end, duration: item.duration, bytes: item.bytes, media_type: item.media_type }
        : { identity: item.identity, file: item.file, name: item.name, in: 0, out: item.duration!, duration: item.duration, bytes: item.bytes, media_type: item.media_type }));
      open(editTab(items.length === 1 ? (items[0].title ?? items[0].name) : `${items.length} clips`, clips));
    };
    const editable = (item: Row | Moment) => Boolean(item.bytes) && ('start' in item || Number(item.duration) > 0);
    const copyTranscripts = async (ids: string[]) => {
      try {
        const items = ids.map(id => byId.get(id)).filter((item): item is Row | Moment => Boolean(item));
        const transcripts = await Promise.all(items.map(async item => {
          const result = await fileResults.read<{ results: { value: { text?: string } }[] }>(item.identity, 'transcript');
          return { title: item.title ?? item.name, text: result.results[0]?.value?.text?.trim() ?? '' };
        }));
        if (transcripts.some(item => !item.text)) throw new Error('Some selected recordings have no transcript yet.');
        if (!(await copyTextToClipboard(transcripts.map(item => transcripts.length === 1 ? item.text : `${item.title}\n\n${item.text}`).join('\n\n---\n\n')))) throw new Error('This browser did not let Trillion copy them.');
        notify(transcripts.length === 1 ? 'Transcript copied' : 'Transcripts copied');
      } catch (error) { notify('Transcripts could not copy', { kind: 'error', detail: errorWords(error) }); }
    };
    // A recording with no words yet: the account's transcription tool works them out, the card shows them, the rows count them.
    const untranscribed = (item: Row | Moment) => 'words' in item && !(Number(item.words) > 0) && canTranscribe(item);
    const transcribe = (ids: string[]) => void transcribeRecordings(ids.map(id => byId.get(id)).filter((item): item is Row => Boolean(item && 'words' in item && item.file))
      .map(item => ({ file: item.file!, title: item.title ?? item.name })), () => { if (!disposed) void load(); });
    const showFiles = (ids: string[]) => {
      const folders = new Set(ids.map(id => byId.get(id)).filter((item): item is Row => Boolean(item && 'path' in item)).map(folderOf));
      for (const collection of folders) open({ id: 'trillion.files', surfaceInput: { collection: collection || '/' } });
    };
    // Delete and Archive a recording with every name it has (never a moment, which is a stretch of one).
    const takeAway = setAsideActions((item: Row | Moment) => ('start' in item ? null : { identity: item.identity, label: item.title ?? item.name }), (id: string) => byId.get(id), () => { void load(); });
    const options = {
      label: searching ? `Moments for “${question}”` : 'Media',
      fields: searching ? MOMENT_FIELDS : fields(rows),
      records: searching ? moments : rows,
      identify: (item: Row | Moment) => ('start' in item ? item.id : item.identity),
      shareRecord,
      // A recording's ⋯ offers every row the page has for it (menu-rows.tsx): its tools, the person's saved actions, formats.
      aboutRecord: (item: Row | Moment) => ({ kind: 'file', id: item.identity, title: item.title ?? item.name, name: item.name, media_type: typeOf(item), ...('path' in item && item.path ? { path: item.path } : {}),
        share: item.file ? { kind: 'file', file: item.file, name: item.name } : { kind: 'text', text: item.title ?? item.name } }),
      preferenceKey: searching ? 'trillion-media-moments' : 'trillion-media',
      ...(!searching ? { initialRules: (selectedMediaView === 'ready' ? availabilityRule('Ready here')
        : selectedMediaView === 'elsewhere' ? availabilityRule('Original elsewhere')
          : selectedMediaView === 'made' ? { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'origin', operator: 'is_any_of', params: { values: [library.origin_labels?.made ?? 'made'] } }] }
            : selectedMediaView === 'unused' ? { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'used', operator: 'is_any_of', params: { values: ['Not used yet'] } }] }
              : allMediaRule) as never,
        focusPath: ['app', 'trillion-media-availability'],
        toolbarStart: (host: HTMLElement) => {
          host.classList.add('trillion-media-availability');
          host.textContent = `Showing ${rows.length.toLocaleString()} media · ${ready.toLocaleString()} originals here · ${indexed.toLocaleString()} indexed without originals`;
          if (!library.next_after) return () => host.classList.remove('trillion-media-availability');
          const buttonHost = document.createElement('span');
          host.append(buttonHost);
          const unmount = mountReactSurface(buttonHost, <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => readMore()}>{loadingMore ? 'Loading more' : 'Show more'}</Button>);
          return () => { unmount(); host.classList.remove('trillion-media-availability'); };
        },
        ...(chosenView ? { view: chosenView, onViewChange: (view: string) => { chosenView = view; } } : {}),
      } : {}),
      // Recordings read as a photo library first (Google Photos, Frame.io); moments as a grid of frames with their words.
      views: [{ id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }, { id: 'table', label: 'List', icon: 'List' }, { id: 'board', label: 'Board', icon: 'Columns3' }],
      timeline: searching ? undefined : { fieldId: 'captured_at', levels: timelineLevels as never },
      // A field of the person's own, and a fact changed in place: kept beside the file for every AI to read.
      customFieldKinds: searching ? undefined : personFieldKinds(),
      onAddField: searching ? undefined : (field: { id: string; label: string; kind?: string }) => { void addPersonField(field).then(drawList, error => notify('The field could not be added', { kind: 'error', detail: errorWords(error) })); },
      onEditFieldValue: searching ? undefined : (id: string, fieldId: string, typed: string) => void editFact(id, fieldId, typed),
      ...recordFilter,
      // The search box asks the one search for moments; the rows are narrowed by the answer, never by matching here.
      search: { value: question, placeholder: 'Search meetings, or what is said, seen or named', onCommit: (value: string) => { if (value !== question) { question = value; ask(); } } },
      // What the person's AIs and tools made comes first, so a finished video has one obvious place.
      savedViews: [
        { id: 'made', label: 'Made for you', search: '', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'origin', operator: 'is_any_of', params: { values: [library.origin_labels?.made ?? 'made'] } }] } },
        { id: 'ready', label: 'Ready here', search: '', rules: availabilityRule('Ready here') },
        { id: 'elsewhere', label: 'Originals elsewhere', search: '', rules: availabilityRule('Original elsewhere') },
        { id: 'all-media', label: 'All media', search: '', rules: allMediaRule },
        { id: 'unused', label: 'Not used yet', search: '', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'used', operator: 'is_any_of', params: { values: ['Not used yet'] } }] } },
      ],
      onApplySavedView: (saved: { id: string; search: string }) => {
        const changed = selectedMediaView !== saved.id;
        selectedMediaView = saved.id;
        question = saved.search;
        found = null;
        chosenView = saved.id === 'elsewhere' ? 'table' : 'gallery';
        if (changed || shownMediaView !== selectedMediaView) void screen.reload();
        else void drawList();
      },
      onOpen: openItem,
      onDragOut: (ids: string[], event: { dataTransfer: DataTransfer }) => { const item = byId.get(ids[0]); if (item?.bytes) setPlaceableSurfaceDragData(event.dataTransfer, fileTab(item, 'start' in item ? item.start : 0), item.title ?? item.name); },
      previewFields: [{ id: 'content', label: 'Content', kind: 'media', read: recordPreview }],
      rowActions: [
        { id: 'play', label: 'Play', icon: 'Play', lead: true, appliesTo: (item: Row | Moment) => Boolean(item.bytes), run: (ids: string[]) => ids.forEach(openItem) },
        { id: 'edit', label: 'Put in a new edit', icon: 'Scissors', appliesTo: editable, run: editItems },
        { id: 'copy-transcripts', label: 'Copy transcript', icon: 'Copy', appliesTo: (item: Row | Moment) => 'words' in item && Number(item.words) > 0, run: (ids: string[]) => void copyTranscripts(ids) },
        { id: 'copy-public-link', label: noteList.public_link.label, icon: 'Link', appliesTo: (item: Row | Moment) => !('start' in item) && Boolean(item.file), run: (ids: string[]) => ids.forEach(id => { const item = byId.get(id); if (item?.file) void copyPublicLink(`file:${item.file}`, noteList.public_link); }) },
        { id: 'send-webhook', label: noteList.webhook.label, icon: 'Webhook', appliesTo: (item: Row | Moment) => !('start' in item) && Boolean(item.file), run: (ids: string[]) => { const item = byId.get(ids[0]); if (item?.file) openShareVia(`file:${item.file}`, item.title ?? item.name, { first: noteList.webhook.destination }); } },
        { id: 'download-pdf', label: noteList.pdf.label, icon: 'FileDown', appliesTo: (item: Row | Moment) => 'words' in item && Number(item.words) > 0, run: (ids: string[]) => ids.forEach(id => { const item = byId.get(id); if (item) void downloadTranscriptPdf(item.identity, item.title ?? item.name); }) },
        { id: 'transcribe', label: 'Transcribe', icon: 'AudioLines', appliesTo: untranscribed, run: transcribe },
        { id: 'show-files', label: 'Show in Files', icon: 'FolderSearch', appliesTo: (item: Row | Moment) => 'path' in item && Boolean(item.path), run: showFiles },
        ...takeAway,
      ],
      bulkActions: [
        share,
        addToTray,
        { id: 'edit', label: 'Edit these', icon: 'Scissors', appliesTo: editable, run: editItems },
        { id: 'edit-each', label: 'One edit per recording', icon: 'CopyPlus', appliesTo: editable, run: (ids: string[]) => ids.forEach(id => editItems([id])) },
        { id: 'play', label: 'Open selected', icon: 'Play', appliesTo: (item: Row | Moment) => Boolean(item.bytes), run: (ids: string[]) => ids.forEach(openItem) },
        { id: 'copy-transcripts', label: 'Copy transcripts', icon: 'Copy', appliesTo: (item: Row | Moment) => 'words' in item && Number(item.words) > 0, run: (ids: string[]) => void copyTranscripts(ids) },
        { id: 'transcribe', label: 'Transcribe', icon: 'AudioLines', appliesTo: untranscribed, run: transcribe },
        { id: 'show-files', label: 'Show in Files', icon: 'FolderSearch', appliesTo: (item: Row | Moment) => 'path' in item && Boolean(item.path), run: showFiles },
        ...takeAway,
      ],
      emptyMessage: searching ? (answer?.pending.length ? 'Still looking.' : 'Nothing found.')
        : selectedMediaView === 'ready' ? 'No originals here match this view. Choose Originals elsewhere to see indexed files whose bytes are not in Trillion.'
          : 'No media match this view.',
      emptyContent: searching ? (searchFailed
        ? <ScreenState state={{ status: 'failed', title: 'Search could not finish', description: 'Try again to search your media.', retry: { label: 'Try again', run: () => ask() } }} />
        : !answer
          ? <ScreenState state={{ status: 'loading', label: `Searching for “${question}”`, layout: 'gallery' }} />
          : answer.pending.length
            ? <ScreenState state={{ status: 'loading', label: `Still looking for “${question}”`, layout: 'gallery' }} />
            : answer.unavailable.length
              ? <ScreenState state={{ status: 'unavailable', title: 'Some places could not be searched', description: 'The search may be incomplete. Try again to check those places.', retry: { label: 'Try again', run: () => ask() } }} />
              : <ScreenState state={{ status: 'empty', title: 'Nothing found', description: 'Try another search.', icon: 'SearchX' }} />) : undefined,
      status: searching && answer && answer.results.length && answer.unavailable.length
        ? <ScreenState state={{ status: 'unavailable', inline: true, title: 'Some places could not be searched', description: 'These results may be incomplete.', retry: { label: 'Try again', run: () => ask() } }} />
        : searching && searchFailed && moments.length
          ? <ScreenState state={{ status: 'failed', inline: true, title: 'Search could not finish', description: 'Your results are still here. Try again to finish the search.', retry: { label: 'Try again', run: () => ask() } }} />
          : undefined,
    };
    if (views) views.update(options as never); else views = mountRecordViews(list, options as never);
  };

  // A fact the person changed in the list, kept as that one fact of the file.
  const editFact = async (id: string, fieldId: string, typed: string) => {
    const row = library?.rows?.find(item => item.identity === id);
    const field = findFactField(fieldId, library?.rows ?? [], personFields());
    if (!row || !field) return;
    try {
      row.facts = await setFacts(row.file ?? row.identity, { [fieldId]: editedFact(field, typed) });
      void drawList();
    } catch (error) { notify(`${field.label} could not change`, { kind: 'error', detail: errorWords(error) }); }
  };
  // Each stored recording's own bytes, read once, for when and where it was captured; the list redraws as they arrive.
  const readingStops = new Set<() => void>();
  const stopReading = () => { for (const stop of readingStops) stop(); readingStops.clear(); };
  let redrawSoon: ReturnType<typeof setTimeout> | null = null;
  const readFromFiles = (rows: Row[]) => {
    readingStops.add(readFactsFromFiles(rows.filter(row => row.file).map(row => ({ identity: row.file!, bytes: row.bytes, contentType: typeOf(row), facts: row.facts })), (identity, facts) => {
      for (const row of rows) if (row.file === identity) {
        row.facts = facts;
        if (/^(audio|video)\/webm(?:;|$)/i.test(row.media_type ?? '')) {
          row.media_type = observedMediaType(row.media_type, facts) ?? row.media_type;
          row.media_kind = observedMediaKind(facts) ?? row.media_kind;
        }
      }
      redrawSoon ??= setTimeout(() => { redrawSoon = null; if (!disposed) void drawList(); }, 400);
    }));
  };

  const ask = () => {
    stopAsking();
    found = null;
    searchFailed = false;
    if (!question.trim()) { void drawList(); return; }
    const asked = question;
    stopAsking = askSearch(asked, answer => {
      if (disposed || asked !== question) return;
      found = answer;
      void drawList();
    }, () => { if (disposed || asked !== question) return; searchFailed = true; void drawList(); }, { sources: ['files'] });
  };

  // The server answers the first recent page in the opening document; Show more reads only another page on demand.
  const screen = loadScreen(list, {
    loading: { label: 'Loading your media', layout: 'gallery' },
    read: () => readJson<Library>(pageAddress()),
    failed: refusal('Your media could not load'),
    clear: () => { stopReading(); views?.destroy(); views = null; },
    // Kept only while a mounted view shows it: a refused read clears the views, so a same-revision answer draws again.
    draw: answer => { if (views && library?.revision === answer.revision && shownMediaView === selectedMediaView) return; stopReading(); library = answer; shownMediaView = selectedMediaView; primePagePosters(answer.rows ?? []); void drawList(); readFromFiles(answer.rows ?? []); },
  });
  const load = () => screen.reload();
  void readNext();
  // Coming back asks for the small first page and redraws only when its revision changed.
  const onVisible = () => { if (document.visibilityState === 'visible') { void load(); void readNext(); } };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    disposed = true;
    stopAsking();
    stopReading();
    if (redrawSoon) clearTimeout(redrawSoon);
    document.removeEventListener('visibilitychange', onVisible);
    releaseNext?.();
    releaseNode(askBar);
    screen.dispose();
    element.replaceChildren();
  };
}
