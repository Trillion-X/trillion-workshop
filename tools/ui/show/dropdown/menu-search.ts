import type { DropdownItem } from './Dropdown';

/** Match a menu query against a phrase or against every remembered word. */
export function matchesMenuSearch(searchTerms: readonly string[], query: string): boolean {
  const words = (value: string) => value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const normalizedQuery = query.replace(/^\//, '').trim();
  if (!normalizedQuery) return false;
  const phrase = normalizedQuery.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const queryWords = words(normalizedQuery);
  const candidates = searchTerms.flatMap(words);
  if (candidates.length === 0) return false;
  if (searchTerms.some(term => term.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().startsWith(phrase))) return true;
  return queryWords.length > 0 && queryWords.every(queryWord => candidates.some(candidate => candidate.startsWith(queryWord)));
}

/**
 * Filter a hierarchical menu into selectable leaf results. Each result retains
 * its original section and submenu path as a visible category, while keeping
 * its original value so the caller's normal selection route remains authoritative.
 */
export function searchDropdownItems(items: readonly DropdownItem[], query: string): DropdownItem[] {
  const results: DropdownItem[] = [];
  const visit = (rows: readonly DropdownItem[], path: readonly string[], section?: string, parentDisabled = false) => {
    for (const row of rows) {
      const disabled = parentDisabled || row.disabled === true;
      const nextPath = row.children?.length ? [...path, row.label] : path;
      if (row.children?.length) visit(row.children, nextPath, row.section ?? section, disabled);
      else if (matchesMenuSearch([row.label, row.section ?? section ?? '', ...path], query)) {
        const category = [...new Set([row.section ?? section, ...path].filter((value): value is string => !!value))].join(' › ');
        results.push({ ...row, children: undefined, ...(disabled ? { disabled: true } : {}), ...(category ? { section: category } : {}) });
      }
    }
  };
  visit(items, []);
  return results;
}
