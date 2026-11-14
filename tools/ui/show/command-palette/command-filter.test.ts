import { describe, expect, it } from '../../../../test/vitest-shim.mjs';
import { filterCommands, type CommandPaletteItem } from './command-filter.ts';

const row = (id: string, label: string, extra: Partial<CommandPaletteItem> = {}): CommandPaletteItem => ({ id, label, run: () => {}, ...extra });

describe('command palette filter', () => {
  const items = [
    row('align', 'Align left', { section: 'Format' }),
    row('archive', 'Archive thread', { aliases: ['done', 'e'], score: 5 }),
    row('delete', 'Delete thread', { aliases: ['trash'] }),
    row('archive-all', 'Archive all', { section: 'Bulk', score: 1 }),
  ];

  it('keeps everything in the caller\'s order for an empty query', () => {
    expect(filterCommands(items, '  ').map(item => item.id)).toEqual(['align', 'archive', 'delete', 'archive-all']);
  });

  it('keeps the old contract: every token must be found, in any of label, section or detail', () => {
    expect(filterCommands(items, 'al le').map(item => item.id)).toEqual(['align']);
    expect(filterCommands(items, 'bulk arch').map(item => item.id)).toEqual(['archive-all']);
  });

  it('finds a row by an alias that is never shown', () => {
    expect(filterCommands(items, 'trash').map(item => item.id)).toEqual(['delete']);
    expect(filterCommands(items, 'done').map(item => item.id)).toEqual(['archive']);
  });

  it('orders matches by score, higher first, and equal scores keep the caller\'s order', () => {
    expect(filterCommands(items, 'arch').map(item => item.id)).toEqual(['archive', 'archive-all']);
    expect(filterCommands([row('a', 'Open one'), row('b', 'Open two')], 'open').map(item => item.id)).toEqual(['a', 'b']);
  });
});
