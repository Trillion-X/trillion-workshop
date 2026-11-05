import type { NavItemData, NavSectionData } from '../show/SidebarContent.tsx';
import type { SurfaceCollection } from './read-surface-collections.ts';
import type { CollectionViewState } from '../do-work/collection-view-preference.ts';
import { buildCollectionSections, collectSurfaceIds } from '../show/CollectionSections.ts';

/** Move caller rows into their saved lists without duplicating the source row or losing its owned outline. */
export function callerCollectionSections(
  source: readonly NavSectionData[], catalog: readonly NavItemData[],
  collections: readonly SurfaceCollection[], view: CollectionViewState,
): NavSectionData[] {
  const owned = new Map<string, NavSectionData[]>();
  const visit = (sections: readonly NavSectionData[]) => {
    for (const section of sections) {
      if (section.ownerSurfaceId && section.sections?.length) owned.set(section.ownerSurfaceId, section.sections);
      visit(section.sections ?? []);
    }
  };
  visit(source);
  const rows = new Map(catalog.map(item => [item.id, owned.has(item.id)
    ? { ...item, sections: owned.get(item.id) } : item]));
  const placed = collectSurfaceIds(collections, false);
  const uncollected = (sections: readonly NavSectionData[]): NavSectionData[] => sections.flatMap(section => {
    if (section.ownerSurfaceId && placed.has(section.ownerSurfaceId)) return [];
    const items = section.items.filter(item => !placed.has(item.surfaceId ?? item.viewId ?? item.id));
    const children = uncollected(section.sections ?? []);
    if (!items.length && !children.length && !section.bottomContent && !section.statusContent) return [];
    return [{ ...section, items, ...(section.sections ? { sections: children } : {}) }];
  });
  return [
    ...(view.mode === 'show-all' ? uncollected(source) : []),
    ...buildCollectionSections(collections, rows, view, true),
  ];
}
