// src/workspace/recently-deleted-screen.tsx
//
// PURPOSE
//   Recently Deleted: every file, folder and recording the person deleted or archived, newest first, each with where
//   it was, when and by whom, and how many days it has left before it moves on (Archived moves to Recently Deleted;
//   Recently Deleted is gone for good). Put back gives every name back where it was. How long each keeps things is a
//   choice in the view bar's menu. It is the screen of the account tool tool:recently-deleted
//   (records/workshop-recently-deleted-tool-records.json) and reads the same list any AI reads with
//   list_recently_deleted (src/namespace-set-aside.mjs). Ported from the Mac app's Archived and Recently Deleted views.
//   Above the list, the storage panel (storage-release-panel.tsx): storage kept, what waits to be given back and when,
//   and the person's release rules.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what the person's store kept (GET /work/api/namespace/set-aside); having nothing is said plainly with how
//      long things are kept.
//   2. Fields are DATA below and drawn by the shared record views; each state is a saved view and a menu of keep-for
//      choices built from the store's own answer (namespace-set-aside.json), so nothing here names a state.
//   3. Days left are the store's answer, worked out when read; changing keep-for reads the list again.
//   4. Every control is shared: record views (rows, saved views, row and selection actions, the view bar's menu),
//      screen states, notifications.

import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { mediaPreviewContent } from '../../parts/ui/show/media-preview';
import { formatBytes } from '../../parts/ui/show/notifications/notification-center';
import type { ActionMenuItem } from '../../parts/ui/show/action-menu';
import { familyOf, previewFor } from './file-picture';
import { recordFilter } from './record-filter';
import { readJson } from './api';
import { refusal } from './failure';
import { openScreen } from './open-screen';
import { onStoreChange } from './store-changes';
import { putBack } from './set-aside';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { StoragePanel, type Storage } from './storage-release-panel';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Item = {
  id: string; label: string; state: string; state_label: string; folder: boolean; names: string[]; name_count: number; byte_length: number;
  where: string | null; set_aside_at: string; by: string | null; after_days: number | null; due_at: string | null; days_left: number | null; due_words: string;
};
type State = { id: string; label: string; after_days: number | null; default_after_days: number | null; due_words: string };
type KeepFor = { states: State[]; choices: (number | null)[] };
type Listing = { items: Item[]; next_after: { ms: number; id: string } | null; keep_for: KeepFor };

const MINUTE = 60_000;
const daysWords = (days: number | null) => (days === null ? 'Until put back' : days === 1 ? '1 day' : `${days} days`);
// What a row's countdown says: "12 days", "Today", or nothing to count when it is kept until put back.
const leftWords = (item: Item) => (item.days_left === null ? 'Kept until put back' : item.days_left === 0 ? 'Today' : daysWords(item.days_left));

const fields = (now: number): FieldDescriptor[] => [
  { id: 'preview', label: 'Preview', icon: 'Image', kind: 'thumbnail', width: 72, sortable: false, read: () => '',
    render: (item: Item) => {
      const preview = previewFor(item.folder ? 'folder' : familyOf(item.names[0] ?? item.label));
      return mediaPreviewContent({ renderer: 'type-icon', title: item.label, icon: preview.icon, typeLabel: preview.type_label });
    } },
  { id: 'label', label: 'Name', icon: 'FileText', ruleKind: 'text', filterable: true, sortable: true, width: 280 },
  { id: 'state', label: 'In', icon: 'Inbox', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170, read: (item: Item) => item.state_label },
  { id: 'left', label: 'Time left', icon: 'Hourglass', ruleKind: 'number', filterable: true, sortable: true, width: 150,
    read: leftWords, factValue: (item: Item) => item.days_left, sortValue: (item: Item) => item.days_left ?? Number.MAX_SAFE_INTEGER },
  { id: 'then', label: 'Then', icon: 'ArrowRight', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 190, read: (item: Item) => (item.days_left === null ? '' : item.due_words) },
  { id: 'where', label: 'Was in', icon: 'Folder', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, read: (item: Item) => item.where ?? '' },
  { id: 'when', label: 'Since', icon: 'Clock', ruleKind: 'date', filterable: true, sortable: true, width: 170,
    read: (item: Item) => relativeWhen(item.set_aside_at, now, { clock: true }), factValue: (item: Item) => Date.parse(item.set_aside_at), sortValue: (item: Item) => Date.parse(item.set_aside_at) },
  { id: 'by', label: 'By', icon: 'User', ruleKind: 'choice', filterable: true, groupable: true, width: 150, hiddenByDefault: true, read: (item: Item) => item.by ?? '' },
  { id: 'size', label: 'Size', icon: 'HardDrive', ruleKind: 'bytes', filterable: true, sortable: true, width: 110, hiddenByDefault: true, read: (item: Item) => formatBytes(item.byte_length), factValue: (item: Item) => item.byte_length },
  { id: 'count', label: 'Files', icon: 'Files', ruleKind: 'number', filterable: true, sortable: true, width: 90, hiddenByDefault: true, read: (item: Item) => String(item.name_count), factValue: (item: Item) => item.name_count },
];

async function listAll(): Promise<Listing> {
  const at = (after: Listing['next_after']) => `/work/api/namespace/set-aside${after ? `?after_ms=${after.ms}&after_id=${encodeURIComponent(after.id)}` : ''}`;
  const first = await readJson<Listing>(at(null));
  const items = [...first.items];
  for (let after = first.next_after; after;) {
    const page = await readJson<Listing>(at(after));
    items.push(...page.items);
    after = page.next_after;
  }
  return { ...first, items };
}

export function mountRecentlyDeletedScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let shown: Listing | null = null;
  const list = document.createElement('div');
  list.className = 'trillion-recently-deleted';
  const storageHost = document.createElement('div');
  storageHost.className = 'trillion-storage-release';
  element.replaceChildren(storageHost, list);
  // The storage panel, drawn again from the store's answer whenever the list changes.
  let unmountStorage: (() => void) | null = null;
  const drawStorage = () => readJson<Storage>('/work/api/namespace/storage').then(storage => {
    unmountStorage?.();
    unmountStorage = mountReactSurface(storageHost, <StoragePanel key={Date.now()} initial={storage} />);
  }, error => notify('Storage could not load', { kind: 'error', detail: errorWords(error) }));

  // The view bar's menu: for each state, how long it keeps things, the current choice checked.
  const keepChoices = new Map<string, { state: string; days: number | null }>();
  const keepMenu = (keep: KeepFor) => ({
    label: 'How long things are kept', icon: 'Hourglass',
    detail: keep.states.map(state => `${state.label}: ${daysWords(state.after_days)}`).join(' · '),
    items: keep.states.map((state): ActionMenuItem => ({
      id: `keep:${state.id}`, label: state.label, icon: 'Hourglass', hint: daysWords(state.after_days),
      items: keep.choices.map(days => {
        const id = `keep:${state.id}:${days ?? 'forever'}`;
        keepChoices.set(id, { state: state.id, days });
        return { id, label: daysWords(days), icon: 'Clock', checked: state.after_days === days };
      }),
    })),
    onAction: (id: string) => {
      const chosen = keepChoices.get(id);
      if (!chosen) return;
      void readJson<KeepFor>('/work/api/namespace/keep-for', { method: 'POST', body: JSON.stringify({ after_days: { [chosen.state]: chosen.days } }) })
        .then(() => { screen.reload(); void drawStorage(); }, error => notify('The time could not change', { kind: 'error', detail: errorWords(error) }));
    },
  });

  function draw(answer: Listing) {
    shown = answer;
    const back = (ids: string[]) => { void putBack(ids).then(() => { screen.reload(); void drawStorage(); }); };
    const options = {
      label: 'Recently Deleted',
      fields: fields(Date.now()),
      records: answer.items,
      identify: (item: Item) => item.id,
      preferenceKey: 'trillion-recently-deleted',
      views: [{ id: 'table', label: 'List', icon: 'List' }, { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }],
      ...recordFilter,
      // One saved view per state the store answered with (namespace-set-aside.json).
      savedViews: answer.keep_for.states.map(state => ({ id: state.id, label: state.label, search: '', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'state', operator: 'is_any_of', params: { values: [state.label] } }] } })),
      moreActions: keepMenu(answer.keep_for),
      rowActions: [{ id: 'put-back', label: 'Put back', icon: 'Undo2', lead: true, run: back }],
      bulkActions: [{ id: 'put-back', label: 'Put back', icon: 'Undo2', run: back }],
      emptyMessage: 'Nothing matches.',
    };
    if (views) views.update(options as never); else views = mountRecordViews(list, options as never);
  }

  const screen = loadScreen(list, {
    loading: { label: 'Loading Recently Deleted', layout: 'rows' },
    read: listAll,
    empty: answer => (answer.items.length ? null : {
      status: 'empty', icon: 'Trash2', title: 'Nothing deleted',
      description: answer.keep_for.states.map(state => `${state.label} keeps things ${state.after_days === null ? 'until you put them back' : `for ${daysWords(state.after_days)}`}.`).join(' '),
      action: { label: 'Open Files', run: () => openScreen('trillion.files') },
    }),
    failed: refusal('Recently Deleted could not load'),
    clear: () => { views?.destroy(); views = null; shown = null; },
    draw,
  });
  void drawStorage();
  const stopListening = onStoreChange(() => { screen.reload(); void drawStorage(); });
  // "3 min ago" keeps counting while the tab is open.
  const ticking = window.setInterval(() => { if (shown) draw(shown); }, MINUTE);
  return () => {
    window.clearInterval(ticking);
    stopListening();
    unmountStorage?.();
    screen.dispose();
    element.replaceChildren();
  };
}
