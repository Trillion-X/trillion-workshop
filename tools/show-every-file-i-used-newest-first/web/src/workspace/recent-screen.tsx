// src/workspace/recent-screen.tsx
//
// PURPOSE
//   Recent: every file the person opened, watched, edited or published, newest first and split by day ("Today",
//   "Yesterday", a weekday, then dates), each with its picture, what happened last and when ("just now", "2 min ago",
//   "Yesterday 4:12 PM"). A row opens the file in its own tab the way Files does, and "Show in Files" opens the folder
//   it is in. It is the screen of the account tool tool:recent-files (records/workshop-account-tool-records.json) and
//   reads the same list any AI reads with recent_files (src/recent-files.mjs). Ported from the Mac's Recent screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only uses the person's store kept (GET /work/api/recent-files); none is made up, and having none is said plainly.
//   2. Fields are DATA below and drawn by the shared record views; the day headings are a computed field named by
//      groupDividerBy, so nothing here draws a heading, a row or a control.
//   3. What happened is an open set of words: the store answers each row's words (recent-files.json `words`), so a new
//      kind of use needs nothing here.
//   4. The time words come from the one relative-time part, and are read again every minute so "2 min ago" keeps
//      counting.
//   5. The list reads itself again when the person's store changes (store-changes.ts), so a file opened in another tab
//      rises to the top.

import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { relativeDay, relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { mediaPreviewContent, madeMediaPreviewContent } from '../../parts/ui/show/media-preview';
import { PLACEABLE_SURFACE_MIME, setPlaceableSurfaceDragData } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { bytesAddress, contentTypeOf, familyOf, previewFor } from './file-picture';
import { previewStore } from './made-previews';
import { readJson } from './api';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { openScreen, fileTab as openingFile } from './open-screen';
import { onStoreChange } from './store-changes';

type Used = {
  identity: string; name: string | null; title: string; media_type: string | null;
  last_at: string; last_kind: string; last_words: string; kinds: Record<string, string>;
};
type Recent = { items: Used[]; next_before: string | null; said: string };

const MINUTE = 60_000;

// The request that opens one file in its own tab (file-screen.tsx), by click or by drag.
const fileTab = (row: Used) => ({ ...openingFile({ id: row.identity, name: row.name ?? row.title, type: row.media_type }), title: row.title });
const folderOf = (name: string) => name.replace(/\/[^/]+$/, '') || '/';
const open = (detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail }));

// The fields a used file is shown with, read at `now` so the time words and day headings are current.
const recentFields = (now: number): FieldDescriptor[] => [
  // The picture: a video's still, a sound's waveform, a picture made small, anything else its type's icon (as in Files).
  { id: 'preview', label: 'Preview', icon: 'Image', kind: 'thumbnail', width: 72, sortable: false, read: () => '',
    render: (row: Used) => {
      const preview = previewFor(familyOf(row.title, row.media_type));
      const tile = { renderer: preview.renderer, title: row.title, icon: preview.icon, typeLabel: preview.type_label };
      return preview.made
        ? madeMediaPreviewContent({ ...tile, identity: row.identity, url: bytesAddress(row.identity), contentType: contentTypeOf(row.title, row.media_type), store: previewStore })
        : mediaPreviewContent(tile);
    } },
  { id: 'title', label: 'Name', icon: 'FileText', ruleKind: 'text', filterable: true, sortable: true, width: 300 },
  { id: 'what', label: 'What happened', icon: 'Activity', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 150, read: (row: Used) => row.last_words },
  { id: 'when', label: 'When', icon: 'Clock', ruleKind: 'date', filterable: true, sortable: true, width: 180,
    read: (row: Used) => relativeWhen(row.last_at, now, { clock: true }), factValue: (row: Used) => Date.parse(row.last_at), sortValue: (row: Used) => Date.parse(row.last_at) },
  { id: 'folder', label: 'Folder', icon: 'Folder', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, hiddenByDefault: true, read: (row: Used) => (row.name ? folderOf(row.name) : '') },
  // The heading each file sits under: the list breaks into days by it (groupDividerBy), so it starts out of the way.
  { id: 'day', label: 'Day', icon: 'CalendarDays', groupable: true, sortable: false, width: 160, hiddenByDefault: true, read: (row: Used) => relativeDay(row.last_at, now) },
];

export function mountRecentScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let shown: Recent | null = null;
  const list = document.createElement('div');
  list.className = 'trillion-recent';
  element.replaceChildren(list);

  function draw(answer: Recent) {
    shown = answer;
    const byId = new Map(answer.items.map(row => [row.identity, row] as const));
    const openFile = (id: string) => { const row = byId.get(id); if (row) open(fileTab(row)); };
    const options = {
      label: 'Recent',
      ...recordFilter,
      fields: recentFields(Date.now()),
      records: answer.items,
      identify: (row: Used) => row.identity,
      preferenceKey: 'trillion-recent',
      views: [{ id: 'table', label: 'List', icon: 'List' }, { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }],
      view: window.matchMedia('(max-width: 600px)').matches ? 'gallery' : 'table',
      groupDividerBy: 'day',
      onOpen: openFile,
      // Dragging a file onto the screen arrangement opens it in a tab there, as from Files.
      onDragOut: (ids: string[], event: { dataTransfer: DataTransfer }) => {
        const row = byId.get(ids[0]);
        if (row) setPlaceableSurfaceDragData(event.dataTransfer, fileTab(row), row.title);
      },
      rowActions: [
        { id: 'open', label: 'Open', icon: 'SquareArrowOutUpRight', lead: true, run: (ids: string[]) => ids.forEach(openFile) },
        { id: 'show-files', label: 'Show in Files', icon: 'FolderSearch', appliesTo: (row: Used) => Boolean(row.name),
          run: (ids: string[]) => { const row = byId.get(ids[0]); if (row?.name) open({ id: 'trillion.files', surfaceInput: { collection: folderOf(row.name) } }); } },
      ],
      emptyMessage: 'Nothing matches.',
    };
    if (views) views.update(options as never); else views = mountRecordViews(list, options as never);
  }

  const screen = loadScreen(list, {
    loading: { label: 'Loading your recent files', layout: 'rows' },
    read: () => readJson<Recent>('/work/api/recent-files'),
    empty: answer => (answer.items.length ? null : {
      status: 'empty', icon: 'History', title: 'Nothing yet',
      description: 'Files you open, watch, edit or publish show up here, newest first.',
      action: { label: 'Open Files', run: () => openScreen('trillion.files') },
    }),
    failed: refusal('Your recent files could not load'),
    clear: () => { views?.destroy(); views = null; shown = null; },
    draw,
  });
  const stopListening = onStoreChange(() => screen.reload());
  // "2 min ago" keeps counting, and a new day moves yesterday's files under their heading.
  const ticking = window.setInterval(() => { if (shown) draw(shown); }, MINUTE);
  return () => {
    window.clearInterval(ticking);
    stopListening();
    screen.dispose();
    element.replaceChildren();
  };
}
