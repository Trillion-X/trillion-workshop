// src/workspace/send-actions-tree.ts
//
// PURPOSE
//   The person's list of what their AI does with something they send (their saved instructions, the actions every
//   sharing place offers: the message box, the iPhone Share sheet, the Chrome extension, the Android share page), as
//   the shared recursive tree (parts/ui/show/coss/project-tree.tsx): add an action or a folder, edit an action's name
//   and words, rename a folder, drag or move a row up, down or into a folder, and remove one. The same tree is the
//   sidebar's "Your AI will" list (keepActionsTree, through the sidebar content host named in surfaces.json) and the
//   Sharing screen's list (actionsTreeOptions).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One list: every read and change goes through /work/api/share-destinations (src/share-destinations.mjs), the
//      route every sharing place reads; nothing is kept here.
//   2. Every change is sent as the whole arranged list (actions and folders, each in its order) and the tree is drawn
//      from what comes back.
//   3. Words are DATA (send-actions.json); nothing here names an action or a folder.
//   4. A row that starts a workflow shows the workflow icon; an edit sends only its name and words, so the route keeps
//      the workflow it starts.

import { mountIntoContentHost } from '../../parts/sidebar/show/content-host';
import { mountProjectTree, type ProjectTreeItem, type ProjectTreeOptions } from '../../parts/ui/show/coss/project-tree';
import { rowsInside } from '../action-folders.mjs';
import { postJson, readJson } from './api';
import { onStoreChange } from './store-changes';
import words from './send-actions.json';

export type SendAction = { id: string; label: string; words: string; folder: string | null; workflow?: { workflow_id: string } };
export type SendFolder = { id: string; label: string; folder: string | null };
export type SendActions = { actions: SendAction[]; folders: SendFolder[] };

const ROUTE = '/work/api/share-destinations';
const ACTION = 'action:';
const FOLDER = 'folder:';
const rowId = (kind: typeof ACTION | typeof FOLDER, id: string) => `${kind}${id}`;
const folderOfRow = (row: string | null) => (row ? row.slice(FOLDER.length) : null);

/** The list as tree rows: each folder holds its actions, then the folders inside it, each in its order. */
export function treeOf({ actions, folders }: SendActions): { items: ProjectTreeItem[]; roots: string[] } {
  const inside = (folder: string | null) => rowsInside({ actions, folders }, folder).map(row => (row.action ? rowId(ACTION, row.action.id) : rowId(FOLDER, row.folder.id)));
  return {
    items: [
      ...actions.map(action => ({ id: rowId(ACTION, action.id), name: action.label, description: action.words, namedIcon: action.workflow ? words.workflow_icon : words.action_icon, leaf: true })),
      ...folders.map(row => ({ id: rowId(FOLDER, row.id), name: row.label, children: inside(row.id), nameOnly: true })),
    ],
    roots: inside(null),
  };
}

/** `rows` with `id` taken out and put back inside `folder`, just before `before` (or after the last of its kind
 *  there); rows elsewhere keep their order. */
function placed<T extends { id: string; folder: string | null }>(rows: T[], id: string, folder: string | null, before: string | null): T[] {
  const row = rows.find(one => one.id === id);
  if (!row) return rows;
  const rest = rows.filter(one => one.id !== id);
  const at = before ? rest.findIndex(one => one.id === before) : -1;
  const lastThere = rest.map(one => one.folder).lastIndexOf(folder);
  const index = at >= 0 ? at : lastThere >= 0 ? lastThere + 1 : rest.length;
  return [...rest.slice(0, index), { ...row, folder }, ...rest.slice(index)];
}

/** The list after a row is moved inside `parentRowId` (null: the top), before the row `beforeRowId` (null: last).
 *  Actions sit before folders in a folder, so an action moved before a folder goes after that folder's last action,
 *  and a folder moved before an action goes first among its folders. */
export function moved(list: SendActions, rowIdToMove: string, parentRowId: string | null, beforeRowId: string | null): SendActions {
  const folder = folderOfRow(parentRowId);
  if (rowIdToMove.startsWith(ACTION)) {
    const before = beforeRowId?.startsWith(ACTION) ? beforeRowId.slice(ACTION.length) : null;
    return { ...list, actions: placed(list.actions, rowIdToMove.slice(ACTION.length), folder, before) };
  }
  const id = rowIdToMove.slice(FOLDER.length);
  const before = beforeRowId?.startsWith(FOLDER) ? beforeRowId.slice(FOLDER.length)
    : beforeRowId ? list.folders.find(row => row.folder === folder && row.id !== id)?.id ?? null : null;
  return { ...list, folders: placed(list.folders, id, folder, before) };
}

/** The list without a row; a folder's own rows move up into the folder around it. */
export function removed(list: SendActions, rowIdToRemove: string): SendActions {
  if (rowIdToRemove.startsWith(ACTION)) return { ...list, actions: list.actions.filter(action => rowId(ACTION, action.id) !== rowIdToRemove) };
  const id = rowIdToRemove.slice(FOLDER.length);
  const up = list.folders.find(row => row.id === id)?.folder ?? null;
  return {
    actions: list.actions.map(action => (action.folder === id ? { ...action, folder: up } : action)),
    folders: list.folders.filter(row => row.id !== id).map(row => (row.folder === id ? { ...row, folder: up } : row)),
  };
}

/** What the route saves for a list: every action and folder, in order, each with the folder it sits in. */
const saving = (list: SendActions) => ({
  folders: list.folders.map(({ id, label, folder }) => ({ id, label, folder })),
  actions: list.actions.map(({ id, label, words: said, folder }) => ({ id, label, words: said, folder })),
});

/** The shared tree's options for the person's list, starting from `start` when it was already read; `onChanged`
 *  hears every list the route answers with. A change is made to the list as last read, never to an unread one. */
export function actionsTreeOptions(start: SendActions | null = null, onChanged: (list: SendActions) => void = () => {}): ProjectTreeOptions {
  let list: SendActions = start ?? { actions: [], folders: [] };
  let read: Promise<void> | null = start ? Promise.resolve() : null;
  const reload = async () => { read = readJson<SendActions>(ROUTE).then(answer => { list = answer; onChanged(answer); }); await read; return treeOf(list); };
  const change = async (next: (current: SendActions) => SendActions) => {
    if (!read) await reload(); else await read;
    list = await postJson<SendActions>(ROUTE, saving(next(list)));
    onChanged(list);
  };
  const first = start ? treeOf(start) : { items: [], roots: [] };
  return {
    ...first,
    label: words.label,
    selectionMode: 'none',
    searchLabel: words.search,
    emptyLabel: words.empty,
    words: words.tree,
    createKinds: words.kinds,
    detailsIcon: false,
    reload,
    onCreate: (parent, name, kind) => change(current => (kind === 'folder'
      ? { ...current, folders: [...current.folders, { id: '', label: name, folder: folderOfRow(parent) }] }
      : { ...current, actions: [...current.actions, { id: '', label: name, words: name, folder: folderOfRow(parent) }] })),
    onRename: (id, name) => change(current => ({ ...current, folders: current.folders.map(row => (rowId(FOLDER, row.id) === id ? { ...row, label: name } : row)) })),
    onEdit: (id, { name, description }) => change(current => ({ ...current, actions: current.actions.map(action => (rowId(ACTION, action.id) === id ? { ...action, label: name, words: description || name } : action)) })),
    onReorder: (id, parent, before) => change(current => moved(current, id, parent, before)),
    onMove: (id, parent) => change(current => moved(current, id, parent, null)),
    onDelete: id => change(current => removed(current, id)),
  };
}

/** The list inside the sidebar's content host `hostId`, read again whenever the person's store changes. */
export function keepActionsTree(hostId: string): () => void {
  return mountIntoContentHost(hostId, host => {
    const tree = mountProjectTree(host, actionsTreeOptions());
    void tree.refresh();
    const stopListening = onStoreChange(() => tree.refresh());
    return () => { stopListening(); tree.destroy(); };
  });
}
