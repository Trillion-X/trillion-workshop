/** Small structural shapes keep the selection reader independent of React. */
export interface SelectableNavItem {
  id: string;
  viewId?: string;
  sections?: readonly SelectableNavSection[];
}

export interface SelectableNavSection {
  items: readonly SelectableNavItem[];
  sections?: readonly SelectableNavSection[];
}

/** Whether a section contains the active row anywhere in its owned tree. */
export function sectionContainsSelection(
  section: SelectableNavSection,
  selectionId: string,
): boolean {
  return section.items.some(item => itemContainsSelection(item, selectionId))
    || Boolean(section.sections?.some(child => sectionContainsSelection(child, selectionId)));
}

/** Whether a row or one of its nested owned rows is active. */
export function itemContainsSelection(
  item: SelectableNavItem,
  selectionId: string,
): boolean {
  return selectionId === item.id || selectionId === item.viewId
    || Boolean(item.sections?.some(section => sectionContainsSelection(section, selectionId)));
}

/** Keep selected nested destinations visible when a list is capped. */
export function itemsWithinSelectionCap<T extends SelectableNavItem>(
  items: readonly T[],
  showAtMost: number,
  selectionId: string | undefined,
): T[] {
  return items.filter((item, index) => index < showAtMost
    || Boolean(selectionId && itemContainsSelection(item, selectionId)));
}
