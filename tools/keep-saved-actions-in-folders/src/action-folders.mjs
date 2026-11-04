// src/action-folders.mjs
//
// How the person's saved actions sit in their folders, for every place that offers them (the message box, the
// Sharing screen and sidebar tree, the Chrome extension, the Android share page). The list itself is the one
// share_destinations answers (src/share-destinations.mjs): actions, each with the id of the folder it sits in or null,
// and folders, each with the folder it sits in. Pure: no reads, no words.
//
// Invariants
// - Within a folder its actions come first, then the folders inside it, each in the order given; the same order the
//   owner reads its tree in (src/agents.mjs instructionsInTreeOrder), so the first action shown is the first one.
// - A folder that sits inside itself, or in a folder that is not in the list, is never walked twice.

/** The rows inside `folder` (null: the top), in order: { action } for each action, then { folder } for each folder. */
export function rowsInside({ actions = [], folders = [] }, folder = null) {
  return [
    ...actions.filter(action => (action.folder ?? null) === folder).map(action => ({ action })),
    ...folders.filter(row => (row.folder ?? null) === folder).map(row => ({ folder: row })),
  ];
}

/** The list as a nested tree: each node { action } or { folder, rows } with the rows inside that folder. */
export function actionTree(list, folder = null, path = new Set()) {
  return rowsInside(list, folder).flatMap(row => {
    if (row.action) return [row];
    if (path.has(row.folder.id)) return [];
    return [{ folder: row.folder, rows: actionTree(list, row.folder.id, new Set(path).add(row.folder.id)) }];
  });
}

/** The actions in groups, in the list's order: the top's own actions first (path []), then each folder that holds
 *  actions, with the names of the folders it sits in (path, outermost first). For a place that shows one flat list
 *  under headings. */
export function actionGroups(list) {
  const groups = [];
  const walk = (nodes, path) => {
    const actions = nodes.filter(node => node.action).map(node => node.action);
    if (actions.length) groups.push({ path, actions });
    for (const node of nodes) if (node.folder) walk(node.rows, [...path, node.folder.label]);
  };
  walk(actionTree(list), []);
  return groups;
}
