// src/workspace/files-screen.tsx
//
// PURPOSE
//   Files: the person's own folders and files in their Trillion space, drawn by the shared record views (table,
//   gallery, board; filter, sort, group) from the Worker's listing of one folder at a time. Its search box is the one
//   search (src/search.mjs through src/workspace/search-results.ts): typing words and pressing Enter shows every file,
//   GitHub item and Trillion record they match, each with where it matched (Name, Said, Seen, Notes and text) and a
//   quick view per place; clearing it shows the folder again. Opening a folder
//   lists it in the same tab; opening a file opens it in its own tab, where a video or sound plays (file-screen.tsx); the
//   path above the list goes back up. Uploading puts chosen or dropped files into the
//   folder on screen, with progress in the shared notifications.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every row is a name the Worker listed for this person. Nothing is invented while loading; an
//      empty space shows the shared file drop area, which is also the upload action.
//   2. Fields are DATA (FIELDS below): a new column is one row there and no drawing code. What each kind of file
//      shows as its picture is DATA too (file-previews.json), drawn by the shared MediaPreview. A video, sound or
//      picture shows small pictures the browser makes once from the file (a still, a strip of frames to scrub, a
//      waveform) and keeps with it as a namespace result of kind `preview`, so every later view reads them.
//   6. Resting the pointer on a file opens the shared hover preview (parts/ui/show/hover-preview), which shows it
//      through the one file preview (parts/ui/show/file-preview): a video plays silently, a sound shows its waveform
//      and player, a picture, a PDF, a text or code file, an Office document; with several selected, a carousel.
//   7. A file row, card or hover preview dragged onto the screen arrangement opens that file in a tab where it lands.
//   5. A list of thousands draws only what is on screen (the record views' windowing); pictures load lazily.
//   3. Filters are decided by the formula engine's record filter, loaded once from its bytes.
//   4. Every control is a shared component (record views, file dropzone, breadcrumb, empty state, notifications).
//   9. Delete and Archive (one action per state in src/namespace-set-aside.json, through set-aside.ts) take a file or
//      folder out of view into Recently Deleted or Archived, never erase it; the view bar's menu opens Recently Deleted.
//   8. Versions of the same file (the Worker's `version` on each name, src/file-versions.mjs) show the latest one; the
//      older ones are hidden by a starting filter the person can clear, and are never removed.
//   9. Ask my AI to tidy these (chosen files, or one file's actions) hands the files to the person's own AI through the
//      one queued-job road (src/workspace/queue-job.ts, job `tidy-files`); its suggestions wait on the Tidy up screen
//      (More > Tidy up, file-tidy-screen.tsx). Trillion runs no model for it.
//   9. Every fact kept about a file (when and where it was captured, its camera, its length, the person's own fields) is
//      a field (file-facts.json), read for the whole folder in one request; the person adds fields and edits facts in
//      place, and a video's or picture's own bytes fill them once (file-facts-store.ts).

import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { mountFileDropzone, mountWorkspaceFileDropzone } from '../../parts/ui/show/kibo/file-dropzone';
import { loadScreen, ScreenState } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { mountBreadcrumb } from '../../parts/ui/show/breadcrumb/mount-breadcrumb';
import { formatBytes } from '../../parts/ui/show/notifications/notification-center';
import { mediaPreviewContent, madeMediaPreviewContent, settledPreview, type MadePreview } from '../../parts/ui/show/media-preview';
import { previewStore } from './made-previews';
import timelineLevels from '../../parts/ui/show/record-views/timeline-zoom-levels.json';
import { baseName, bytesAddress, contentTypeOf, extensionOf, familyOf, previewFor, type FilePreviewRow } from './file-picture';
import { recordFilter } from './record-filter';
import { PLACEABLE_SURFACE_MIME, setPlaceableSurfaceDragData } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { readListing } from './api';
import { refusal } from './failure';
import { uploadFiles } from './upload';
import { shareAction } from './sharing-sheet';
import { addSelectedToTrayAction } from './tray';
import { setAsideActions } from './set-aside';
import { askSearch, openResult, placeViews, searchFields, type SearchAnswer, type SearchResult } from './search-results';
import { openScreen, fileTab as openingFile } from './open-screen';
import { queuedJobDone, queuedJobLabel, sendQueuedJob } from './queue-job';
import tidySettings from '../file-tidy.json';
import { editedFact, factFields, findFactField, personFieldKinds } from './file-facts.mjs';
import { addPersonField, personFields, readFacts, readFactsFromFiles, setFacts, type Facts } from './file-facts-store';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Version = { family: string; latest: boolean; latest_name: string; versions: number };
type Listed = { name: string; identity: string | null; byte_length: number | null; modified_at_ms: number | null; stored: boolean | null; media_type?: string | null; version?: Version; also_named?: number; also_at?: string[] };
type Listing = { collection: string; names: Listed[]; folders: string[]; next_after: string | null };
type Preview = FilePreviewRow;
type Row = { id: string; path: string; identity: string | null; name: string; kind: string; extension: string; preview: Preview; bytes: string | undefined; contentType: string; size: number | null; modified: number | null; stored: string; version: string; versions: number | null; alsoNamed: number | null; alsoAt: string[]; facts: Facts | null };

const FOLDER = 'folder:';
// Tidying: the job handed to the person's own AI (src/queued-work.json `tidy-files`) and the screen where its
// suggestions wait (the Workshop tool tool:list-file-tidy, whose screen is file-tidy-screen.tsx).
const TIDY_JOB = 'tidy-files';
const TIDY_SCREEN = 'tool:list-file-tidy';
// What the person deleted or archived, with the days each has left (records/workshop-recently-deleted-tool-records.json).
const RECENTLY_DELETED_SCREEN = 'tool:recently-deleted';
const LATEST = 'Latest';
const OLDER = 'Older version';

const FIELDS: FieldDescriptor[] = [
  // The picture: a video's still (with frames to scrub), a sound's waveform, a picture made small, anything else its
  // type's icon and name (shared MediaPreview).
  { id: 'preview', label: 'Preview', icon: 'Image', kind: 'thumbnail', width: 72, read: () => '',
    pictureUrl: (row: Row) => (row.bytes && row.contentType.startsWith('image/') ? row.bytes : null),
    render: (row: Row) => {
      const tile = { renderer: row.preview.renderer, title: row.name, icon: row.preview.icon, typeLabel: row.preview.type_label };
      return row.preview.made
        ? madeMediaPreviewContent({ ...tile, identity: row.identity, url: row.bytes, contentType: row.contentType, store: previewStore })
        : mediaPreviewContent(tile);
    } },
  { id: 'name', label: 'Name', icon: 'FileText', ruleKind: 'text', filterable: true, sortable: true, width: 320 },
  { id: 'kind', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 120 },
  { id: 'extension', label: 'Extension', icon: 'FileType', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 100, hiddenByDefault: true, read: (row: Row) => row.extension.toUpperCase() },
  { id: 'size', label: 'Size', icon: 'HardDrive', ruleKind: 'bytes', filterable: true, sortable: true, width: 110, read: (row: Row) => (row.size === null ? '' : formatBytes(row.size)), factValue: (row: Row) => row.size, sortValue: (row: Row) => row.size ?? -1 },
  { id: 'modified', label: 'Modified', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, groupable: true, sortable: true, width: 170, read: (row: Row) => (row.modified ? new Date(row.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''), factValue: (row: Row) => row.modified, sortValue: (row: Row) => row.modified ?? 0 },
  { id: 'stored', label: 'Stored', icon: 'CloudCheck', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 130, hiddenByDefault: true, values: { Stored: { tone: 'success' }, 'Still uploading': { tone: 'warning' } } },
  // Several versions of the same file (a copy number, a version number, an export time or a backup on the name): the
  // latest is marked, and the older ones are hidden by the starting filter below and one tap away (the Worker decides
  // which is which, src/file-versions.mjs).
  { id: 'version', label: 'Version', icon: 'History', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 130, values: { [LATEST]: { tone: 'success' }, [OLDER]: { tone: 'grey' } } },
  { id: 'versions', label: 'Versions', icon: 'Layers', ruleKind: 'number', filterable: true, sortable: true, width: 100, hiddenByDefault: true, read: (row: Row) => (row.versions === null ? '' : String(row.versions)), factValue: (row: Row) => row.versions },
  // The same bytes kept under other names too (in another folder, or twice): one stored file, several names.
  // It names where: the other folder (or name) first, then how many more.
  { id: 'also_named', label: 'Also kept in', icon: 'Copy', ruleKind: 'number', filterable: true, sortable: true, width: 220, read: (row: Row) => alsoKeptIn(row), factValue: (row: Row) => row.alsoNamed },
];

// Where else a file's bytes are kept: its other name's folder (its own name when that differs), then how many more.
const alsoKeptIn = (row: Row) => {
  if (row.alsoNamed === null) return '';
  const [first] = row.alsoAt;
  const place = first ? (baseName(first) === row.name ? first.slice(0, first.lastIndexOf('/')) || '/' : first) : '';
  const more = row.alsoNamed - (first ? 1 : 0);
  return [place, more > 0 ? `${more} more` : ''].filter(Boolean).join(' + ');
};

// A folder starts by showing the latest of each file's versions; clearing the filter shows the older ones too.
const LATEST_ONLY = { kind: 'group' as const, combinator: 'and', negate: false, rules: [{ kind: 'rule' as const, field: 'version', operator: 'is_none_of', params: { values: [OLDER] } }] };

// The request that opens one file in its own tab (file-screen.tsx), by click, by drag, or from its hover preview.
const fileTab = (row: Row) => openingFile({ id: row.identity ?? row.path, name: row.path || row.name, type: row.contentType });

// A file's made pictures as hover-preview fields: its still, frames and waveform.
const madeParts = (made: MadePreview | null | undefined) => made ? { poster: made.poster, frames: made.frames, peaks: made.peaks } : {};

function rowsOf(listing: Listing): Row[] {
  const folder = previewFor('folder');
  const folders = listing.folders.map(path => ({ id: `${FOLDER}${path}`, path, identity: null, name: baseName(path), kind: folder.type_label, extension: '', preview: folder, bytes: undefined, contentType: '', size: null, modified: null, stored: '', version: '', versions: null, alsoNamed: null, alsoAt: [], facts: null }));
  const files = listing.names.map(item => {
    const name = baseName(item.name);
    const extension = extensionOf(name);
    const preview = previewFor(familyOf(name, item.media_type));
    return {
      id: `file:${item.name}`, path: item.name, identity: item.identity, name, kind: preview.type_label, extension, preview,
      // The file's own bytes, read by range with this page's session; only once it is stored.
      bytes: item.identity && item.stored ? bytesAddress(item.identity) : undefined,
      contentType: contentTypeOf(name, item.media_type),
      size: item.byte_length, modified: item.modified_at_ms,
      stored: item.stored === false ? 'Still uploading' : item.stored ? 'Stored' : '',
      version: item.version ? (item.version.latest ? LATEST : OLDER) : '',
      versions: item.version?.versions ?? null,
      alsoNamed: item.also_named ?? null,
      alsoAt: item.also_at ?? [],
      facts: null,
    };
  });
  return [...folders, ...files];
}

const LOADING = { label: 'Loading your files', layout: 'rows' as const };

async function listFolder(collection: string): Promise<Listing> {
  const first = await readListing<Listing>(collection, { limit: 1000 });
  const names = [...first.names];
  for (let after = first.next_after; after;) {
    const page = await readListing<Listing>(collection, { limit: 1000, after });
    names.push(...page.names);
    after = page.next_after;
  }
  return { ...first, names };
}

// The folders from Files down to the one on screen, as breadcrumb steps.
function pathSteps(collection: string) {
  const parts = collection === '/' ? [] : collection.slice(1).split('/');
  return [{ id: '/', label: 'Files' }, ...parts.map((part, index) => ({ id: `/${parts.slice(0, index + 1).join('/')}`, label: part }))];
}

export function mountFilesScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  let collection = typeof props.surfaceInput?.collection === 'string' ? String(props.surfaceInput.collection) : '/';
  let views: ReturnType<typeof mountRecordViews> | null = null;
  // One path mount per folder on screen: the record views remount their toolbar only when this function changes.
  let placePath: ((host: HTMLElement) => () => void) | undefined;
  const list = document.createElement('div');
  list.className = 'trillion-files';
  const picker = document.createElement('div');
  picker.hidden = true;
  element.replaceChildren(list, picker);

  // The search box is the one search (src/search.mjs): files, GitHub and Trillion at once, each result saying where it
  // matched. Its words are handed over on Enter; clearing it shows the folder again.
  const SEARCH_WORDS = 'Search your files, GitHub and Trillion';
  let question = '';
  let found: SearchAnswer | null = null;
  let searchFailed = false;
  let stopAsking = () => {};
  let redraw: (() => void) | null = null;
  let shownMode: 'folder' | 'search' | null = null;
  const commitSearch = (value: string) => {
    question = value.trim();
    stopAsking();
    found = null;
    searchFailed = false;
    if (question) stopAsking = askSearch(question, answer => { if (answer.question === question) { found = answer; searchFailed = false; redraw?.(); } }, () => { searchFailed = true; redraw?.(); });
    redraw?.();
  };
  const search = () => ({ value: question, placeholder: SEARCH_WORDS, onCommit: commitSearch });

  const pathFor = (path: string) => (path === '/' ? undefined : (host: HTMLElement) => mountBreadcrumb(host, { steps: pathSteps(path), onOpen: open }));
  // Another folder reads from the loading rows, in the same tab.
  const open = (path: string) => { collection = path; placePath = pathFor(path); screen.show({ status: 'loading', ...LOADING }); void screen.reload(); };
  placePath = pathFor(collection);
  const upload = async (files: File[]) => {
    const note = notify(files.length === 1 ? `Uploading ${files[0].name}` : `Uploading ${files.length} files`, { kind: 'transfer', progress: { value: 0 }, timeout: 0, key: `upload:${Date.now()}` });
    const shares = new Map<string, number>();
    try {
      const named = await uploadFiles(files, collection, (name, share) => {
        shares.set(name, share);
        const done = [...shares.values()];
        note.update({ progress: { value: done.reduce((sum, part) => sum + part, 0) / files.length, label: `${done.filter(part => part >= 1).length} of ${files.length} done` } });
      });
      note.finish({ title: named.length === 1 ? `${baseName(named[0].name)} is in your files` : `${named.length} files are in your files`, progress: null, timeout: 5000 });
      await screen.reload();
    } catch (error) {
      note.finish({ title: 'Upload stopped', detail: errorWords(error), kind: 'error', progress: null, timeout: 0 });
      throw error;
    }
  };
  const chooser = mountFileDropzone(picker, { label: 'Upload files', description: '', accept: {}, onFiles: upload });
  const dropTarget = mountWorkspaceFileDropzone(element, { label: 'Drop to upload here', accept: {}, onFiles: upload });
  const onUploadAction = () => chooser.open();
  window.addEventListener('trillion-upload-files', onUploadAction);

  let stopReading = () => {};
  let redrawSoon: ReturnType<typeof setTimeout> | null = null;
  let drawing = 0;
  const stopDetails = () => {
    drawing += 1;
    stopReading();
    stopReading = () => {};
    if (redrawSoon) clearTimeout(redrawSoon);
    redrawSoon = null;
  };
  // A fact the person changed in the list, kept as that one fact of the file.
  const editFact = async (records: Row[], id: string, fieldId: string, typed: string) => {
    const row = records.find(record => record.id === id);
    const field = findFactField(fieldId, records, personFields());
    if (!row?.identity || !field) return;
    try {
      row.facts = await setFacts(row.identity, { [fieldId]: editedFact(field, typed) });
      redraw?.();
    } catch (error) { notify(`${field.label} could not change`, { kind: 'error', detail: errorWords(error) }); }
  };

  const screen = loadScreen(list, {
    loading: LOADING,
    read: () => listFolder(collection),
    failed: refusal('Your files could not load'),
    clear: () => { stopDetails(); redraw = null; views?.destroy(); views = null; shownMode = null; },
    draw: listing => {
      stopDetails();
      const mine = drawing;
      const records = rowsOf(listing);
      redraw = () => drawNow(records);
      drawNow(records);
      const identities = records.flatMap(row => (row.identity ? [row.identity] : []));
      if (!identities.length) return;
      // Names are useful immediately. The folder's facts and each file's own metadata arrive behind the first paint.
      void readFacts(identities).then(facts => {
        if (mine !== drawing) return;
        for (const row of records) {
          if (!row.identity) continue;
          const held = facts.get(row.identity);
          if (held) row.facts = { ...held, ...(row.facts ?? {}) };
        }
        redraw?.();
        // Each stored video, sound or picture's own bytes, read once, for when and where it was captured.
        stopReading = readFactsFromFiles(records.filter(row => row.identity).map(row => ({ identity: row.identity!, bytes: row.bytes, contentType: row.contentType, facts: row.facts })), (identity, held) => {
          if (mine !== drawing) return;
          for (const row of records) if (row.identity === identity) row.facts = { ...held, ...(row.facts ?? {}) };
          redrawSoon ??= setTimeout(() => { redrawSoon = null; if (mine === drawing) redraw?.(); }, 400);
        });
      }).catch(() => {
        // A missing details response must not hide names that the namespace has already listed.
        if (mine === drawing) notify('File details could not load', { kind: 'error' });
      });
    },
  });

  // What a search found: one row per thing with where it matched; a quick view per place filters to it.
  function drawFound() {
    const answer = found;
    const results = answer?.results ?? [];
    const still = answer?.pending.length ? answer.places.filter(place => answer.pending.some(item => item.place === place.id)).map(place => place.label.toLowerCase()) : [];
    const unavailable = answer?.unavailable.length ?? 0;
    const retrySearch = { label: 'Try again', run: () => commitSearch(question) };
    const emptyContent = searchFailed
      ? <ScreenState state={{ status: 'failed', title: 'Search could not finish', description: 'Try again to search your files and connected sources.', retry: retrySearch }} />
      : !answer && question
        ? <ScreenState state={{ status: 'loading', label: `Searching for “${question}”`, layout: 'rows' }} />
        : answer && !results.length && still.length
          ? <ScreenState state={{ status: 'loading', label: `Still looking for “${question}”`, layout: 'rows' }} />
          : answer && !results.length && unavailable
            ? <ScreenState state={{ status: 'unavailable', title: 'Some places could not be searched', description: 'The search may be incomplete. Try again to check those places.', retry: retrySearch }} />
            : answer && !results.length
              ? <ScreenState state={{ status: 'empty', title: 'Nothing found', description: 'Try another search.', icon: 'SearchX' }} />
              : undefined;
    const status = answer && results.length && unavailable
      ? <ScreenState state={{ status: 'unavailable', inline: true, title: 'Some places could not be searched', description: 'These results may be incomplete.', retry: retrySearch }} />
      : searchFailed && results.length
        ? <ScreenState state={{ status: 'failed', inline: true, title: 'Search could not finish', description: 'Your results are still here. Try again to finish the search.', retry: retrySearch }} />
        : undefined;
    const byId = new Map(results.map(result => [result.id, result] as const));
    const options = {
      label: still.length ? `Still looking in ${still.join(', ')} for “${question}”` : `Found for “${question}”`,
      fields: answer ? searchFields(answer) : [],
      records: results,
      identify: (result: SearchResult) => result.id,
      preferenceKey: 'trillion-search',
      views: [{ id: 'table', label: 'List', icon: 'List' }, { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }],
      ...recordFilter,
      search: search(),
      savedViews: answer ? placeViews(answer) : [],
      onOpen: (id: string) => { const result = byId.get(id); if (result) openResult(result); },
      previewFields: [{ id: 'content', label: 'Content', kind: 'media', read: (result: SearchResult) => (result.bytes ? { url: result.bytes, type: result.media_type ?? '', label: result.path?.slice(result.path.lastIndexOf('/') + 1) || result.name, ...(result.identity ? madeParts(settledPreview(result.identity)) : {}) } : null) }],
      rowActions: [{ id: 'open', label: 'Open', icon: 'SquareArrowOutUpRight', lead: true, run: (ids: string[]) => ids.forEach(id => { const result = byId.get(id); if (result) openResult(result); }) }],
      emptyMessage: answer ? (still.length ? 'Still looking.' : 'Nothing found.') : 'Searching.',
      emptyContent,
      status,
    };
    if (views && shownMode === 'search') views.update(options as never); else { views?.destroy(); views = mountRecordViews(list, options as never); }
    shownMode = 'search';
  }

  function drawNow(records: Row[]) {
      if (question) { drawFound(); return; }
      // An empty folder is the shared drop area, which is also the upload action.
      if (!records.length) {
        views?.destroy();
        views = null;
        shownMode = null;
        mountFileDropzone(list, { label: collection === '/' ? 'Upload your first files' : 'This folder is empty', description: 'Drop files here, or click to choose them. They are kept in your own Trillion space.', accept: {}, onFiles: upload });
        return;
      }
      const openRecord = (id: string) => {
        if (id.startsWith(FOLDER)) { open(id.slice(FOLDER.length)); return; }
        const row = records.find(record => record.id === id);
        if (row) window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: fileTab(row) }));
      };
      // Dragging a file (a row, a card, or its hover preview) onto the screen arrangement opens it in a tab there.
      const dragOut = (ids: string[], event: { dataTransfer: DataTransfer }) => {
        const row = records.find(record => ids.includes(record.id) && !record.id.startsWith(FOLDER));
        if (row) setPlaceableSurfaceDragData(event.dataTransfer, fileTab(row), row.name);
      };
      // Ask my AI to tidy these: the chosen files go to the person's own AI, whose title and folder suggestions wait on
      // the Tidy up screen for the person to accept or reject.
      const tidyLabel = queuedJobLabel(TIDY_JOB);
      const tidy = tidyLabel ? [{ id: 'tidy', label: tidyLabel, icon: 'Sparkles', appliesTo: (row: Row) => !row.id.startsWith(FOLDER) && Boolean(row.identity), run: (ids: string[]) => {
        const names = records.filter(row => ids.includes(row.id) && !row.id.startsWith(FOLDER)).map(row => row.path);
        if (!names.length) return;
        sendQueuedJob({ job_id: TIDY_JOB, context: { folder: collection, names: names.join('\n') }, press_key: `${TIDY_JOB}:${Date.now()}:${names.length}` })
          .then(sent => notify(sent.said || queuedJobDone, { kind: 'done' }), error => notify(errorWords(error), { kind: 'error' }));
      } }] : [];
      // Delete and Archive: a folder with everything in it, or one file once it has finished uploading.
      const takeAway = setAsideActions((row: Row) => (row.stored === 'Still uploading' ? null : { name: row.path }), (id: string) => records.find(record => record.id === id), () => { void screen.reload(); });
      const rowOf = (id: string) => records.find(row => row.id === id);
      const shareRecord = (row: Row) => row.identity ? `file:${row.identity}` : null;
      const share = shareAction(rowOf, shareRecord, (row: Row) => row.name);
      const addToTray = addSelectedToTrayAction(list, rowOf, shareRecord, (row: Row) => row.name);
      const options = {
        label: collection === '/' ? 'Files' : baseName(collection),
        // The Version column shows only in a folder that holds versions of the same file.
        fields: [...FIELDS.filter(field => (field.id === 'version' ? records.some(record => record.version) : field.id === 'also_named' ? records.some(record => record.alsoNamed !== null) : true)), ...(factFields(records, personFields()) as FieldDescriptor[])],
        // A field of the person's own, and a fact changed in place: kept beside the file for every AI to read.
        customFieldKinds: personFieldKinds(),
        onAddField: (field: { id: string; label: string; kind?: string }) => { void addPersonField(field).then(() => redraw?.(), error => notify('The field could not be added', { kind: 'error', detail: errorWords(error) })); },
        onEditFieldValue: (id: string, fieldId: string, typed: string) => void editFact(records, id, fieldId, typed),
        records,
        identify: (row: Row) => row.id,
        shareRecord,
        // A file's ⋯ offers every row the page has for it (menu-rows.tsx): its tools, the person's saved actions, formats.
        aboutRecord: (row: Row) => (row.identity ? { kind: 'file', id: row.identity, title: row.name, name: row.name, media_type: row.contentType, path: row.path, share: { kind: 'file', file: row.identity, name: row.name } } : null),
        preferenceKey: 'trillion-files',
        // A file list reads first as rows (Shopify Files, Descript); cards and a board are a switch away.
        views: [{ id: 'table', label: 'List', icon: 'List' }, { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }, { id: 'board', label: 'Board', icon: 'Columns3' }],
        // Cards read as a photo library: stretches of time by when each file was last changed, pinch or zoom to step.
        timeline: { fieldId: 'modified', levels: timelineLevels as never },
        ...recordFilter,
        initialRules: records.some(record => record.version === OLDER) ? (LATEST_ONLY as never) : undefined,
        toolbarStart: placePath,
        primaryAction: { label: 'Upload files', onSelect: () => chooser.open() },
        // A folder opens in this tab; a file opens in its own tab, where a video or sound plays (file-screen.tsx).
        onOpen: openRecord,
        // Resting the pointer on a file shows it (the shared hover preview); its small pictures, once made, come along.
        previewFields: [{ id: 'content', label: 'Content', kind: 'media', read: (row: Row) => row.bytes ? { url: row.bytes, type: row.contentType, label: row.name, icon: row.preview.icon, typeLabel: row.preview.type_label, open: fileTab(row), ...(row.identity ? madeParts(settledPreview(row.identity)) : {}) } : null }],
        onDragOut: dragOut,
        // Each file in a hover preview (and each screen of a carousel over several) offers these.
        rowActions: [{ id: 'open', label: 'Open', icon: 'SquareArrowOutUpRight', lead: true, appliesTo: (row: Row) => !row.id.startsWith(FOLDER), run: (ids: string[]) => ids.forEach(openRecord) },
          ...tidy, ...takeAway],
        bulkActions: [share, addToTray, ...tidy, ...takeAway],
        moreActions: { label: 'More', icon: 'Ellipsis', items: [{ id: 'tidy-up', label: tidySettings.screen.title, icon: 'Sparkles' }, { id: 'recently-deleted', label: 'Recently Deleted', icon: 'Trash2' }], onAction: (id: string) => { if (id === 'tidy-up') openScreen(TIDY_SCREEN); if (id === 'recently-deleted') openScreen(RECENTLY_DELETED_SCREEN); } },
        search: search(),
        emptyMessage: 'Nothing matches.',
      };
      if (views && shownMode === 'folder') views.update(options as never); else { views?.destroy(); views = mountRecordViews(list, options as never); }
      shownMode = 'folder';
  }

  return () => {
    stopDetails();
    redraw = null;
    window.removeEventListener('trillion-upload-files', onUploadAction);
    stopAsking();
    screen.dispose();
    chooser.destroy();
    dropTarget.destroy();
    element.replaceChildren();
  };
}
