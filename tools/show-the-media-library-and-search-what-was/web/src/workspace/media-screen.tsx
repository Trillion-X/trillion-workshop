// src/workspace/media-screen.tsx
//
// PURPOSE
//   Media: the person's recordings and the files their tools made, over the same namespace as Files. The list is the shared record views (cards, list, board; grouped by date or
//   by folder as a nested tree; filtered; a Made view), with every fact kept about each file as a field (when and where
//   it was captured, its camera, the person's own fields, file-facts.json), which the person can add to and edit in
//   place and which the file's own bytes fill once (file-facts-store.ts). Typing a search turns the list into MOMENTS:
//   each card is the frame at the second the words are said or the picture shows them (the one search, src/search.mjs), with the words; opening one
//   plays the recording from that second, and Edit puts that stretch into a new edit.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every row is a media file the person's files owner keeps (media-library-read.ts, one row per
//      file); every moment is a frame the picture index measured (media-search.ts).
//   2. Pages of 60, newest first; Show more follows a cursor and the header counts every media file. No saved view is
//      a default filter: the first view is All media.
//   3. Pictures are the owner's thumbnails (media-pictures.ts) drawn by the shared MediaPreview; a recording plays from
//      its bytes read by range (media-playback.ts), HoverPreview for the preview (previewFields).
//   4. Fields and views are DATA below; the editor is opened through the arrangement (surface trillion.media-edit)
//      with the clips and their seconds, so the Library never imports the editor. Every clip it sends has a real
//      `out` (a measured length or a moment's end): a recording whose length is unknown is never sent or suggested.
//   6. Delete and Archive (one action per state in src/namespace-set-aside.json, through set-aside.ts) take a recording
//      with every name it has out of view into Recently Deleted or Archived; the library leaves it out until put back.
//   5. Every control is a shared component (record views, notifications, loading and failed states).

import { fileTab as openingFile } from '../../../../workspace-screens/web/src/workspace/open-screen';
import { mountRecordViews, type FieldDescriptor } from '../../../../ui/show/record-views/record-views';
import { Button } from '../../../../ui';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { loadScreen, ScreenState } from '../../../../ui/show/screen-state';
import { notify } from '../../../../ui/show/coss/notifications';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import { mediaPreviewContent } from '../../../../ui/show/media-preview';
import { PLACEABLE_SURFACE_MIME, setPlaceableSurfaceDragData } from '../../../../ui/show/placeable-surface-intent/placeable-surface-intent';
import timelineLevels from '../../../../ui/show/record-views/timeline-zoom-levels.json';
import { recordFilter } from '../../../../workspace-screens/web/src/workspace/record-filter';
import noteList from '../../../../workspace-screens/web/src/workspace/note-list-menu.json' with { type: 'json' };
import { downloadTranscriptPdf } from './note-list';
import { recencyGroup, recencyValues } from './recency-group.mjs';
import { contentTypeOf, familyOf, filePicture, previewFor } from '../../../../workspace-screens/web/src/workspace/file-picture';
import { fileResults } from '../../../../workspace-screens/web/src/workspace/api';
import { readMediaLibrary } from './media-library-read';
import { searchPictures } from './media-search';
import { pictureOf } from './media-pictures';
import { canPlay, playableUrl } from './media-playback';
import { MediaPlayer } from './media-player';
import { mountSharedContent } from '../../../../ui/show/coss/shared-content';
import { releaseNode } from '../../../../ui/show/one-owner-per-node';
import { DockedComposer } from '../../../../workspace-screens/web/src/workspace/global-composer';
import { refusal } from '../../../../workspace-screens/web/src/workspace/failure';
import type { SearchAnswer } from '../../../../workspace-screens/web/src/workspace/search-results';
import { setAsideActions } from '../../../../workspace-screens/web/src/workspace/set-aside';
import { editedFact, factFields, findFactField, personFieldKinds } from '../../../../workspace-screens/web/src/workspace/file-facts.mjs';
import { addPersonField, personFields, readFactsFromFiles, setFacts } from '../../../../workspace-screens/web/src/workspace/file-facts-store';
import { copyPublicLink } from '../../../../workspace-screens/web/src/workspace/sharing-sheet';
import { addSelectedToTrayAction } from '../../../../workspace-screens/web/src/workspace/tray';
import { observedMediaKind, observedMediaType } from '../../../../workspace-screens/web/src/file-type.mjs';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Row = { identity: string; file: string | null; origin: string; name: string; title: string | null; path: string | null; media_kind: string | null; media_type: string | null; stored: boolean; captured_ms: number | null; duration: number | null; facts: Record<string, unknown> | null; edits: number | null; words: number | null };
type Library = { revision: string; total: number; reset?: boolean; next_after?: string | null; origin_labels?: Record<string, string>; rows?: Row[] };
type Moment = { id: string; identity: string; file: string | null; name: string; title: string; media_kind: string | null; media_type: string | null; stored: boolean; duration: number | null; start: number; end: number; timed: boolean; said: string | null; lanes: string[]; score: number };

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
const open = (surface: Record<string, unknown>) => { const request = new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: surface }); window.dispatchEvent(request); return request.defaultPrevented; };

export function mountMediaScreen(element: HTMLElement, _props: { surfaceInput?: Record<string, unknown> }): () => void {
  let disposed = false;
  let library: Library | null = null;
  let found: SearchAnswer | null = null;
  let searchFailed = false;
  let question = '';
  let chosenView: string | undefined;
  let selectedMediaView = 'all-media';
  let shownMediaView = 'all-media';
  // Pictures and playable addresses by file, and which ones were asked for once.
  const pictures = new Map<string, string | null>();
  const pictureAsked = new Set<string>();
  const playing = new Map<string, string>();
  const playAsked = new Set<string>();
  let loadingMore = false;
  let stopAsking = () => {};
  let views: ReturnType<typeof mountRecordViews> | null = null;
  const list = document.createElement('div');
  // The player, in place above the list (showPlayer): one recording at a second.
  const player = document.createElement('section');
  player.className = 'media-player';
  player.hidden = true;
  let unmountPlayer: (() => void) | null = null;
  let pendingPlay: { item: Row | Moment; at: number } | null = null;
  list.className = 'trillion-media';
  // The Ask bar docked under the list (DockedComposer in global-composer.tsx).
  const askBar = document.createElement('div');
  askBar.className = 'trillion-media-ask sticky bottom-0 z-10';
  element.replaceChildren(player, list, askBar);
  mountSharedContent(askBar, <DockedComposer />);

  const readMore = async () => {
    if (loadingMore || !library?.next_after) return;
    const before = library;
    const view = selectedMediaView;
    loadingMore = true;
    void drawList();
    try {
      const page: Library = await readMediaLibrary(view, before.next_after);
      if (disposed || view !== selectedMediaView || library !== before) return;
      if (page.reset) {
        stopReading();
        library = page;
      } else {
        const seen = new Set(before.rows?.map(row => row.identity) ?? []);
        const added = (page.rows ?? []).filter(row => !seen.has(row.identity));
        library = { ...page, rows: [...(before.rows ?? []), ...added] };
      }
    } catch (error) {
      notify('More media could not load', { kind: 'error', detail: errorWords(error) });
    } finally {
      loadingMore = false;
      if (!disposed && view === selectedMediaView) void drawList();
    }
  };

  // ----- the rows and the moments -----
  // A file's picture: the owner's thumbnail once it is in hand (requestPicture), else the picture its kind shows
  // (file-previews.json). A moment shows the frame at its second once the recording's bytes are in hand.
  const requestPicture = (identity: string) => {
    if (pictureAsked.has(identity)) return;
    pictureAsked.add(identity);
    void pictureOf(identity).then(picture => { pictures.set(identity, picture); if (!disposed) void drawList(); });
  };
  const pictureFor = (item: Row | Moment) => {
    const tile = previewFor(item.media_kind ?? familyOf(item.name, item.media_type));
    const url = playing.get(item.identity);
    if ('start' in item && url) return filePicture({ name: item.name, kind: item.media_kind, mediaType: item.media_type, identity: item.file, bytes: url, title: item.title ?? item.name, at: item.start });
    const picture = pictures.get(item.identity);
    if (picture) return mediaPreviewContent({ renderer: 'image', source: picture, title: item.title ?? item.name, icon: tile.icon, typeLabel: item.stored ? tile.type_label : 'Original elsewhere' });
    return filePicture({ name: item.name, kind: item.media_kind, mediaType: item.media_type, title: item.title ?? item.name, ...(item.stored ? {} : { typeLabel: 'Original elsewhere' }) });
  };
  // A recording's bytes are read by range the first time it is asked for; the list redraws when they are in hand.
  // The player, in place: one recording, from its own bytes, at the second asked for; Close takes it away.
  const hidePlayer = () => { unmountPlayer?.(); unmountPlayer = null; player.hidden = true; pendingPlay = null; };
  const showPlayer = (url: string, item: Row | Moment, at: number) => {
    unmountPlayer?.();
    player.hidden = false;
    unmountPlayer = mountReactSurface(player, <><MediaPlayer url={url} mediaType={typeOf(item)} label={item.title ?? item.name} at={at}/><Button size="sm" variant="ghost" onClick={hidePlayer}>Close</Button></>);
  };
  const playInPlace = (item: Row | Moment, at: number) => {
    if (!canPlay(item.identity)) return;
    const url = playing.get(item.identity);
    if (url) { showPlayer(url, item, at); return; }
    pendingPlay = { item, at };
    requestPlayable(item);
  };
  const requestPlayable = (item: Row | Moment) => {
    if (playAsked.has(item.identity)) return;
    playAsked.add(item.identity);
    playableUrl(item.identity, typeOf(item)).then(url => {
      if (disposed) return;
      playing.set(item.identity, url);
      if (pendingPlay?.item.identity === item.identity) { showPlayer(url, pendingPlay.item, pendingPlay.at); pendingPlay = null; }
      const row = library?.rows?.find(found => found.identity === item.identity);
      if (row) readFromFiles([row]);
      void drawList();
    }, error => notify('The recording could not play', { kind: 'error', detail: errorWords(error) }));
  };
  const originLabel = (row: Row) => library?.origin_labels?.[row.origin] ?? row.origin;
  const fields = (rows: Row[]): FieldDescriptor[] => [
    { id: 'preview', label: 'Preview', icon: 'Image', kind: 'thumbnail', width: 72, read: () => '', render: (row: Row) => pictureFor(row) },
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
      render: (moment: Moment) => pictureFor(moment) },
    { id: 'said', label: 'Said there', icon: 'Quote', kind: 'excerpt', width: 420, read: (moment: Moment) => moment.said ?? '' },
    { id: 'title', label: 'Recording', icon: 'FileVideo', sortable: true, width: 220, read: (moment: Moment) => moment.title },
    { id: 'at', label: 'At', icon: 'Clock', sortable: true, width: 80, read: (moment: Moment) => (moment.timed ? clock(moment.start) : ''), sortValue: (moment: Moment) => moment.start },
    { id: 'why', label: 'Found by', icon: 'Search', kind: 'tag', groupable: true, width: 160, read: (moment: Moment) => moment.lanes.map(place => found?.places.find(item => item.id === place)?.label ?? place) },
  ];

  const recordPreview = (item: Row | Moment) => {
    if (!canPlay(item.identity)) return null;
    const url = playing.get(item.identity);
    if (!url) { requestPlayable(item); return null; }
    return { url, type: typeOf(item), label: item.title ?? item.name };
  };
  const drawList = () => {
    if (!library?.rows) return;
    // A photo library opens on recent pictures, even when its catalog also has undated entries.
    // Keep the server's order within one date; the shared timeline preserves the order it receives.
    const total = library.total;
    const rows = [...library.rows].sort((left, right) => (right.captured_ms ?? -1) - (left.captured_ms ?? -1));
    const searching = Boolean(question.trim());
    const answer = found?.question === question ? found : null;
    // Each recording the one search found, one row per moment it matched at (src/search.mjs).
    const moments: Moment[] = searching && answer ? answer.results.filter(result => result.identity).flatMap(result => result.moments.map(moment => ({
      id: `${result.identity}@${moment.start}`, identity: result.identity!, file: result.file, name: result.name, title: result.title, media_kind: result.media_kind, media_type: result.media_type,
      stored: result.stored, duration: result.duration, start: moment.start, end: moment.end, timed: moment.timed, said: moment.said ?? result.said, lanes: moment.places, score: result.score,
    }))) : [];
    const byId = new Map<string, Row | Moment>([...rows.map(row => [row.identity, row] as const), ...moments.map(moment => [moment.id, moment] as const)]);
    for (const item of [...rows, ...moments]) requestPicture(item.identity);
    const shareRecord = (item: Row | Moment) => item.file ? `file:${item.file}` : null;
    const addToTray = addSelectedToTrayAction(list, (id: string) => byId.get(id), shareRecord, (item: Row | Moment) => item.title ?? item.name);
    const openItem = (id: string) => { const item = byId.get(id); if (!item) return; playInPlace(item, 'start' in item ? item.start : 0); };
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
          host.textContent = `Showing ${rows.length.toLocaleString()} of ${total.toLocaleString()} media`;
          if (!library?.next_after) return () => host.classList.remove('trillion-media-availability');
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
      onDragOut: (ids: string[], event: { dataTransfer: DataTransfer }) => { const item = byId.get(ids[0]); if (item) setPlaceableSurfaceDragData(event.dataTransfer, fileTab(item, 'start' in item ? item.start : 0), item.title ?? item.name); },
      previewFields: [{ id: 'content', label: 'Content', kind: 'media', read: recordPreview }],
      rowActions: [
        { id: 'play', label: 'Play', icon: 'Play', lead: true, appliesTo: (item: Row | Moment) => canPlay(item.identity), run: (ids: string[]) => ids.forEach(openItem) },
        { id: 'copy-transcripts', label: 'Copy transcript', icon: 'Copy', appliesTo: (item: Row | Moment) => 'words' in item && Number(item.words) > 0, run: (ids: string[]) => void copyTranscripts(ids) },
        { id: 'copy-public-link', label: noteList.public_link.label, icon: 'Link', appliesTo: (item: Row | Moment) => !('start' in item) && Boolean(item.file), run: (ids: string[]) => ids.forEach(id => { const item = byId.get(id); if (item?.file) void copyPublicLink(`file:${item.file}`, noteList.public_link); }) },
        { id: 'download-pdf', label: noteList.pdf.label, icon: 'FileDown', appliesTo: (item: Row | Moment) => 'words' in item && Number(item.words) > 0, run: (ids: string[]) => ids.forEach(id => { const item = byId.get(id); if (item) void downloadTranscriptPdf(item.identity, item.title ?? item.name); }) },
        { id: 'show-files', label: 'Show in Files', icon: 'FolderSearch', appliesTo: (item: Row | Moment) => 'path' in item && Boolean(item.path), run: showFiles },
        ...takeAway,
      ],
      bulkActions: [
        addToTray,
        { id: 'play', label: 'Open selected', icon: 'Play', appliesTo: (item: Row | Moment) => canPlay(item.identity), run: (ids: string[]) => ids.forEach(openItem) },
        { id: 'copy-transcripts', label: 'Copy transcripts', icon: 'Copy', appliesTo: (item: Row | Moment) => 'words' in item && Number(item.words) > 0, run: (ids: string[]) => void copyTranscripts(ids) },
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
  // Each recording's bytes, once it is in hand, read for when and where it was captured; the list redraws as they arrive.
  const readingStops = new Set<() => void>();
  const stopReading = () => { for (const stop of readingStops) stop(); readingStops.clear(); };
  let redrawSoon: ReturnType<typeof setTimeout> | null = null;
  const readFromFiles = (rows: Row[]) => {
    readingStops.add(readFactsFromFiles(rows.filter(row => row.file).map(row => ({ identity: row.file!, bytes: playing.get(row.identity) ?? null, contentType: typeOf(row), facts: row.facts })), (identity, facts) => {
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
    let stopped = false;
    stopAsking = () => { stopped = true; };
    searchPictures(asked).then(answer => {
      if (disposed || stopped || asked !== question) return;
      found = answer;
      void drawList();
    }, () => { if (disposed || stopped || asked !== question) return; searchFailed = true; void drawList(); });
  };

  // The server answers the first recent page in the opening document; Show more reads only another page on demand.
  const screen = loadScreen(list, {
    loading: { label: 'Loading your media', layout: 'gallery' },
    read: () => readMediaLibrary(selectedMediaView),
    failed: refusal('Your media could not load'),
    clear: () => { stopReading(); views?.destroy(); views = null; },
    // Kept only while a mounted view shows it: a refused read clears the views, so a same-revision answer draws again.
    draw: answer => { if (views && library?.revision === answer.revision && shownMediaView === selectedMediaView) return; stopReading(); library = answer; shownMediaView = selectedMediaView; void drawList(); },
  });
  const load = () => screen.reload();
  // Coming back asks for the small first page and redraws only when its revision changed.
  const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    disposed = true;
    stopAsking();
    stopReading();
    hidePlayer();
    if (redrawSoon) clearTimeout(redrawSoon);
    document.removeEventListener('visibilitychange', onVisible);
    releaseNode(askBar);
    screen.dispose();
    element.replaceChildren();
  };
}
