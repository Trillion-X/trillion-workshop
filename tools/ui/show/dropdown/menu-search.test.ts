import { describe, expect, it } from '../../../../test/vitest-shim.mjs';
import { searchDropdownItems } from './menu-search.ts';
import type { DropdownItem } from './Dropdown.tsx';

describe('shared hierarchical menu search', () => {
  const items: DropdownItem[] = [
    { value: 'copy', label: 'Copy link', section: 'Text' },
    { value: 'turn', label: 'Turn into', section: 'Text', children: [
      { value: 'h1', label: 'Heading 1' },
      { value: 'h2', label: 'Heading 2' },
      { value: 'toggle', label: 'Toggle heading 1' },
    ] },
  ];

  it('finds nested leaves and preserves their parent path and category', () => {
    expect(searchDropdownItems(items, 'heading').map(row => [row.value, row.label, row.section])).toEqual([
      ['h1', 'Heading 1', 'Text › Turn into'],
      ['h2', 'Heading 2', 'Text › Turn into'],
      ['toggle', 'Toggle heading 1', 'Text › Turn into'],
    ]);
  });

  it('matches words from the origin path while keeping only the original selectable leaves', () => {
    expect(searchDropdownItems(items, 'turn heading').map(row => row.value)).toEqual(['h1', 'h2', 'toggle']);
    expect(searchDropdownItems(items, 'copy').map(row => [row.value, row.section])).toEqual([['copy', 'Text']]);
    expect(searchDropdownItems(items, 'color').map(row => row.value)).toEqual([]);
    expect(searchDropdownItems(items, 'text copy').map(row => row.value)).toEqual(['copy']);
  });

  it('preserves a disabled parent when its nested action is surfaced by search', () => {
    const disabled = [{ value: 'restricted', label: 'Move to', disabled: true, children: [
      { value: 'destination', label: 'Destination' },
    ] }];
    expect(searchDropdownItems(disabled, 'destination').map(row => [row.value, row.disabled])).toEqual([['destination', true]]);
  });
});
