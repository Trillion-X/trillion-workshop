// parts/sidebar/read-data/without-folders.ts
//
// PURPOSE
//   The sidebar's sections as they read with no folders drawn: every row of every list, every list inside a list and
//   every row's own child list, in the order the folders held them, as plain rows. Drawn when a show rule hides the
//   control `sidebar.folders` (parts/sidebar/controls.json): the person reaches every screen they reached before, with
//   no folder headings to open, close or manage.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: nothing is read or written; the lists themselves are untouched, so showing folders again draws them as kept.
//   2. No row is lost and none is drawn twice (a screen in two folders shows once, where it first appears).
//   3. Content a section carries of its own (status, content below it) stays, beneath the rows.

import type { NavItemData, NavSectionData } from '../show/SidebarContent';

function rowsOf(section: NavSectionData): NavItemData[] {
  return [
    ...section.items.flatMap(item => [withoutChildren(item), ...(item.sections ?? []).flatMap(rowsOf)]),
    ...(section.sections ?? []).flatMap(rowsOf),
  ];
}

function withoutChildren(item: NavItemData): NavItemData {
  if (!item.sections) return item;
  const { sections: _sections, ...row } = item;
  return row;
}

/** Every section's rows as plain rows in one untitled section, followed by the sections' own content. */
export function withoutFolders(sections: readonly NavSectionData[]): NavSectionData[] {
  const seen = new Set<string>();
  const items = sections.flatMap(rowsOf).filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  const kept = sections.filter(section => section.statusContent || section.bottomContent)
    .map(section => ({ id: section.id, items: [], ...(section.statusContent ? { statusContent: section.statusContent } : {}), ...(section.bottomContent ? { bottomContent: section.bottomContent } : {}) }));
  return [...(items.length ? [{ id: 'rows', items }] : []), ...kept];
}
