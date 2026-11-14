// src/workspace/sidebar-lists.ts
//
// NO PRIOR: moved out of src/workspace/main.tsx (its `sidebarCollections`) so a test can read the app's lists the way
// the page does; the graph shape is parts/sidebar/show/ProjectedCollectionNav.ts, ported from
// bitfield-packages/packages/sidebar.
//
// PURPOSE
//   The app's sidebar lists as the sidebar reads them: every list in surfaces.json `sidebar_collections`, to any
//   depth (a list's `collections` are lists inside it, drawn under it and opened and closed like a folder), each
//   holding the screens that name it (`sidebar_collection`) or that its `holds` rule takes by what they are.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list or a screen: which list a screen sits in is DATA in surfaces.json.
//   2. A list inside another is drawn only under its parent, never also at the top (read-surface-collections.ts).
//   3. A row sits in the most particular list that takes it: a row a nested list holds is not also in its parent.
//      Tools sit in lists inside Your tools by what they are for: a tool's screen `group` DATA rides on its row as
//      `source.group` (src/work-workshop.mjs toolSurfaces), and each such list `holds` the rows of one group.
//      A list marked `leftovers` takes only the rows its rule takes that no other list anywhere takes (Your tools
//      shows the tools no folder holds, while a folder of tools may sit anywhere, even at the top, as Content does).
//   4. A list with nothing in it at any depth is not drawn (ProjectedCollectionNav.ts `collectionHoldsAnything`),
//      unless it hosts a shared panel (`sidebar_content_host_by_section_id`).
//   5. A list may hold rows by a rule (`holds.rules`) and show only while its own rule holds (`shown_when`); the
//      formula engine decides both (sidebar-rules.mjs) and hands the answer in as `decided`. A list whose settings
//      say `repeats_rows` (New) shows rows that also sit in their own lists: it takes no row from any other list.

import { buildProjectedCollectionsNav } from 'trillion-workshop/tools/organize-the-sidebar/show/ProjectedCollectionNav.ts';
import { orderRows, type OrderBy } from 'trillion-workshop/tools/organize-the-sidebar/read-data/apply-list-rules.ts';

/** A list that holds rows by what they are rather than by name: the rows whose value at `path` is `equals`, or the
 * rows a rule tree over their facts holds for (sidebar-rules.mjs). */
export type Holds = { path?: string[]; equals?: unknown; rules?: unknown };
export type SidebarList = { id: string; name: string; icon?: string; settings?: Record<string, boolean>; show_at_most?: number; holds?: Holds; order_by?: OrderBy; shown_when?: unknown; row_chip?: { label: string; variant?: string }; leftovers?: boolean; hierarchy?: { parent_path: string[]; applies_when?: { path: string[]; equals: unknown }; rows_in_parent_when?: { path: string[]; equals: unknown }; lead_where_empty?: boolean }; collections?: SidebarList[] };
/** What the formula engine decided for the rule lists: the rows each holds and the lists hidden by their own rule. */
export type DecidedRules = { holds: Record<string, string[]>; hidden: string[] };
export type ScreenRow = Record<string, unknown> & { id: string; label?: unknown; sidebar_collection?: unknown; listed?: unknown };
export type SidebarListsData = { sidebar_collections: SidebarList[]; sidebar_content_host_by_section_id: Record<string, string> };

const valueAt = (row: unknown, path: string[]) => path.reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), row);
const repeats = (list: SidebarList) => list.settings?.repeats_rows === true;

/** The group graph the sidebar draws: the app's lists, nested as the DATA nests them, over the screens offered. */
export function sidebarCollections(rows: ScreenRow[], data: SidebarListsData, hostPackage: string, decided: DecidedRules = { holds: {}, hidden: [] }): unknown {
  const ruled = new Map(Object.entries(decided.holds).map(([id, held]) => [id, new Set(held)]));
  const hidden = new Set(decided.hidden);
  // A row with `listed: false` opens only where something places it (Home's own parts, a decision's tab): no list holds
  // it, not by its own list, a path or a rule, so New never lists the parts of Home.
  const heldBy = (list: SidebarList, row: ScreenRow) => row.listed !== false && (row.sidebar_collection === list.id
    || (list.holds?.path ? valueAt(row, list.holds.path) === list.holds.equals : false)
    || (ruled.get(list.id)?.has(row.id) ?? false));
  // A row a list inside takes is not also a row of the list around it: the most particular list holds it.
  const heldInside = (list: SidebarList, row: ScreenRow): boolean => (list.collections ?? []).some(child => (!repeats(child) && heldBy(child, row)) || heldInside(child, row));
  const every: SidebarList[] = [];
  const gather = (lists: SidebarList[]) => { for (const list of lists) { if (hidden.has(list.id)) continue; every.push(list); gather(list.collections ?? []); } };
  gather(data.sidebar_collections);
  const heldElsewhere = (list: SidebarList, row: ScreenRow) => every.some(other => other !== list && !repeats(other) && heldBy(other, row));
  const shown = (lists: SidebarList[] = []) => lists.filter(list => !hidden.has(list.id));
  const project = (list: SidebarList): Record<string, unknown> => {
    const listRows = orderRows(rows.filter(row => heldBy(list, row) && !heldInside(list, row) && !(list.leftovers && heldElsewhere(list, row))), list.order_by);
    const treeRows = list.hierarchy ? listRows.filter(row => !list.hierarchy!.applies_when || valueAt(row, list.hierarchy!.applies_when.path) === list.hierarchy!.applies_when.equals) : [];
    const ordinaryRows = treeRows.length ? listRows.filter(row => !treeRows.includes(row)) : listRows;
    const items = (sourceRows: ScreenRow[]) => sourceRows.map(row => ({ id: row.id, label: row.label }));
    const hierarchy = (sourceRows: ScreenRow[]) => {
      const rowById = new Map(sourceRows.map(row => [row.id, row]));
      const children = new Map<string | null, ScreenRow[]>();
      for (const row of sourceRows) {
        const parent = valueAt(row, list.hierarchy!.parent_path);
        const parentId = typeof parent === 'string' && parent !== row.id && rowById.has(parent) ? parent : null;
        children.set(parentId, [...(children.get(parentId) ?? []), row]);
      }
      const seen = new Set<string>();
      // A child row the list's DATA names (`rows_in_parent_when`) with nothing under it is a row of its parent's own
      // list (a pursuit's parts), never a list of one row.
      const inParent = (row: ScreenRow) => Boolean(list.hierarchy!.rows_in_parent_when) && valueAt(row, list.hierarchy!.rows_in_parent_when!.path) === list.hierarchy!.rows_in_parent_when!.equals && !(children.get(row.id)?.length);
      // A row with nothing under it (no parts of its own, no rows nested under it) is a row, never a list holding
      // only itself: a folder named like its one row draws every leaf twice.
      type Placed = { collection: Record<string, unknown> } | { row: ScreenRow };
      const node = (row: ScreenRow): Placed => {
        seen.add(row.id);
        const nested = (children.get(row.id) ?? []).filter(child => !seen.has(child.id));
        const own = nested.filter(inParent);
        for (const child of own) seen.add(child.id);
        const placed = nested.filter(child => !own.includes(child) && !seen.has(child.id)).map(child => node(child));
        const leaves = placed.flatMap(one => ('row' in one ? [one.row] : []));
        const childCollections = placed.flatMap(one => ('collection' in one ? [one.collection] : []));
        if (!own.length && !placed.length) return { row };
        const childId = `${hostPackage}-${list.id}-tree-${encodeURIComponent(row.id)}`;
        return { collection: {
          id: childId,
          name: typeof row.label === 'string' ? row.label : row.id,
          itemFamily: 'placeable-surface',
          items: [row, ...own, ...leaves].map(one => ({ id: one.id, label: one.label })),
          // A row holding its own rows (a pursuit showing its parts) is what an empty pane offers first.
          ...(own.length && list.hierarchy!.lead_where_empty ? { leadsWhereEmpty: true } : {}),
          collections: childCollections,
        } };
      };
      const roots = (children.get(null) ?? []).map(row => node(row));
      // A cycle has no root. Preserve every row once by making the first unseen row a root;
      // the traversal's seen set then cuts the back edge.
      for (const row of sourceRows) if (!seen.has(row.id)) roots.push(node(row));
      return {
        rows: roots.flatMap(one => ('row' in one ? [one.row] : [])),
        collections: roots.flatMap(one => ('collection' in one ? [one.collection] : [])),
      };
    };
    const tree = treeRows.length ? hierarchy(treeRows) : { rows: [], collections: [] };
    return {
    id: `${hostPackage}-${list.id}`,
    name: list.name,
    ...(list.icon ? { icon: list.icon } : {}),
    ...(list.settings ? { settings: list.settings } : {}),
    ...(list.show_at_most ? { showAtMost: list.show_at_most } : {}),
    hasContentHost: Boolean(data.sidebar_content_host_by_section_id[`collection:${hostPackage}-${list.id}`]),
    itemFamily: 'placeable-surface',
    // A list may name the order of its rows (`order_by`: New, newest first).
    items: items([...ordinaryRows, ...tree.rows]),
    collections: [...tree.collections, ...shown(list.collections).map(project)],
    };
  };
  return buildProjectedCollectionsNav({ scope: 'sidebar', collections: shown(data.sidebar_collections).map(project) as never });
}
