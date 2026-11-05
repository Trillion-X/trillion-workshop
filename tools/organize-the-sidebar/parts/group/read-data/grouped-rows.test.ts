// packages/group/read-data/grouped-rows.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { foldRowGroups, namedGroupCount } from '../../../read-data/grouped-rows.ts';

describe('foldRowGroups — the ONE declared-order grouping fold (Insights menu + actions popover)', () => {
  const row = (label: string, group?: string) => ({ label, group });

  it('folds by first-seen group order, keeps within-group declared order', () => {
    const rows = [row('a', 'X'), row('b', 'Y'), row('c', 'X'), row('d', 'Y'), row('e', 'X')];
    expect(foldRowGroups(rows, (r) => r.group)).toEqual([
      { group: 'X', rows: [row('a', 'X'), row('c', 'X'), row('e', 'X')] },
      { group: 'Y', rows: [row('b', 'Y'), row('d', 'Y')] },
    ]);
  });

  it('ungrouped rows collect under the empty-string key at their arrival position', () => {
    const rows = [row('a'), row('b', 'X'), row('c')];
    const groups = foldRowGroups(rows, (r) => r.group);
    expect(groups.map((g) => g.group)).toEqual(['', 'X']);
    expect(groups[0].rows.map((r) => r.label)).toEqual(['a', 'c']);
  });

  it('never enumerates a group name — ANY data string is a group (L090)', () => {
    const rows = [row('a', 'Complétement Nouveau'), row('b', '🎾')];
    expect(foldRowGroups(rows, (r) => r.group).map((g) => g.group)).toEqual(['Complétement Nouveau', '🎾']);
  });

  it('empty input → empty fold (no phantom group)', () => {
    expect(foldRowGroups([], () => undefined)).toEqual([]);
  });

  it('namedGroupCount gates headers: 0 for all-ungrouped, 1 for single named, N for many', () => {
    expect(namedGroupCount([{ group: '' }])).toBe(0);
    expect(namedGroupCount([{ group: 'X' }, { group: '' }])).toBe(1);
    expect(namedGroupCount([{ group: 'X' }, { group: 'Y' }])).toBe(2);
  });
});
