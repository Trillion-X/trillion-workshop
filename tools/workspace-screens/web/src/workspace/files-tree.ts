// src/workspace/files-tree.ts
//
// PURPOSE
//   The person's files as a folder tree inside the sidebar's "Your files" list: the shared recursive tree
//   (parts/ui/show/coss/project-tree.tsx, the one tree for navigation, filters and choosing a folder) in its navigator
//   mode, filled from the person's namespace a folder at a time. Opening a folder reads it; choosing a file opens it
//   in its own tab, exactly as Files does.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The tree is mounted into the sidebar's content host (parts/sidebar/show/content-host.ts); the sidebar's code is
//      not touched and the host is named by DATA (surfaces.json sidebar_content_host_by_section_id).
//   2. A folder is read only when it is opened, one page of the namespace listing; each file shows its latest version.
//   3. The tree reads itself again when the person's store changes (a new folder from any AI appears on its own).
//   4. A plan without files (a free plan, or a plan that just ended while the page is open) shows no rows; the read's
//      refusal is never left to reach the page as an unanswered failure.

import { mountIntoContentHost } from '../../parts/sidebar/show/content-host';
import { mountProjectTree, type ProjectTreeItem } from '../../parts/ui/show/coss/project-tree';
import { baseName, familyOf, previewFor } from './file-picture';
import { openFile } from './open-screen';
import { onStoreChange } from './store-changes';
import { PlanNeeded, readListing } from './api';

type Listed = { name: string; identity: string | null; media_type?: string | null; version?: { latest: boolean } };
type Listing = { names: Listed[]; folders: string[] };

const FILE = 'file:';
const ROOT = '/';

/** One folder of the namespace as tree rows: its folders (opened on demand), then its files. */
async function folderRows(folder: string): Promise<ProjectTreeItem[]> {
  const listing = await readListing<Listing>(folder, { limit: 1000 })
    .catch(error => { if (error instanceof PlanNeeded) return { names: [], folders: [] } satisfies Listing; throw error; });
  const folderTone = previewFor('folder').tree_tone;
  const folders = listing.folders.map(path => ({ id: path, name: baseName(path), expandable: true, manageable: false, tone: folderTone }));
  const files = listing.names
    .filter(item => item.version?.latest !== false)
    .map(item => { const preview = previewFor(familyOf(item.name, item.media_type)); return { id: `${FILE}${item.identity ?? item.name}`, name: baseName(item.name), namedIcon: preview.icon, tone: preview.tree_tone, manageable: false }; });
  return [...folders, ...files];
}

/** Mount the files tree into the sidebar content host `hostId`, for as long as the page lives. */
export function keepFilesTree(hostId: string): () => void {
  const names = new Map<string, string>();
  const remember = (rows: ProjectTreeItem[]) => { for (const row of rows) names.set(row.id, row.name); return rows; };
  return mountIntoContentHost(hostId, host => {
    const tree = mountProjectTree(host, {
      items: [],
      label: 'Your files',
      selectionMode: 'none',
      searchable: false,
      emptyLabel: 'No files yet',
      reload: async () => { const rows = remember(await folderRows(ROOT)); return { items: rows, roots: rows.map(row => row.id) }; },
      loadChildren: async folder => remember(await folderRows(folder)),
      onOpen: id => { if (id.startsWith(FILE)) openFile({ id: id.slice(FILE.length), name: names.get(id) }); },
    });
    void tree.refresh();
    const stopListening = onStoreChange(() => tree.refresh());
    return () => { stopListening(); tree.destroy(); };
  });
}
