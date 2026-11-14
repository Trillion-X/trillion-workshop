import { describe, expect, it } from '../../../../test/vitest-shim.mjs';
import table from '../../../group/show/board-commands.json' with { type: 'json' };
import { coachedCommand, keysOf, paletteItems, rowById, shortcutGroups, type CommandTable } from './command-table.ts';
import { coach, tipsOn, type CoachingHistory } from './shortcut-coaching.ts';
import { filterCommands } from '../command-palette/command-filter.ts';

const board = table as CommandTable;
const run = () => {};

describe('one command table feeds the sheet, the palette and the tips', () => {
  it('draws every key the way the sheet does, from one glyph row', () => {
    expect(keysOf(board, rowById(board, 'group')!)).toBe('⌘G');
    expect(keysOf(board, rowById(board, 'ungroup')!)).toBe('⌘⇧G');
    expect(shortcutGroups(board).find(group => group.heading === 'Arrange')!.rows[0]).toEqual({ label: 'Group', keys: ['⌘', 'G'] });
  });

  it('offers in the palette only the rows that ask for it and have a runner, with keys as the hint', () => {
    const items = paletteItems(board, { 'zoom-to-fit': run, 'reset-zoom': run, 'keyboard-shortcuts': run, group: run });
    expect(items.map(item => item.id)).toEqual(['cmd-zoom-to-fit', 'cmd-reset-zoom', 'cmd-keyboard-shortcuts']);
    expect(items[0]).toMatchObject({ label: 'Zoom to fit', hint: '⇧1', section: 'View', command: 'zoom-to-fit', score: 2 });
    expect(items[1]!.label).toBe('Reset zoom to 100%');
    expect(paletteItems(board, { 'zoom-to-fit': run }).length).toBe(1);
  });

  it('finds a command by an alias the table gives it', () => {
    const items = paletteItems(board, { 'zoom-to-fit': run, 'reset-zoom': run, 'keyboard-shortcuts': run });
    expect(filterCommands(items, 'hotkeys').map(item => item.id)).toEqual(['cmd-keyboard-shortcuts']);
    expect(filterCommands(items, 'zoom').map(item => item.id)).toEqual(['cmd-zoom-to-fit', 'cmd-reset-zoom']);
  });
});

describe('shortcut coaching', () => {
  const zoom = coachedCommand(board, 'zoom-to-fit')!;
  const t0 = Date.parse('2026-10-19T10:00:00Z');

  it('names the shortcut when a command is run the slow way, and never when run by its keys', () => {
    const told = coach(zoom, 'palette', {}, t0);
    expect(told!.tip).toBe('Tip: Zoom to fit is ⇧1.');
    expect(coach(zoom, 'keys', {}, t0)).toBe(null);
    expect(coach(undefined, 'palette', {}, t0)).toBe(null);
    expect(coachedCommand(board, 'no-such-command')).toBe(undefined);
  });

  it('spaces tips out, caps them for each command and for the day, and stays quiet once turned off', () => {
    let history: CoachingHistory = coach(zoom, 'palette', {}, t0)!.history;
    expect(coach(zoom, 'palette', history, t0 + 60_000)).toBe(null);
    history = coach(zoom, 'palette', history, t0 + 400_000)!.history;
    history = coach(zoom, 'palette', history, t0 + 800_000)!.history;
    expect(history.counts!['zoom-to-fit']).toBe(3);
    expect(coach(zoom, 'palette', history, t0 + 1_200_000)).toBe(null);
    const other = coachedCommand(board, 'group')!;
    expect(coach(other, 'palette', history, t0 + 1_200_000)!.history.today).toBe(4);
    expect(coach(other, 'palette', tipsOn(history, false), t0 + 1_200_000)).toBe(null);
    expect(coach(other, 'palette', tipsOn(tipsOn(history, false), true), t0 + 1_200_000)).not.toBe(null);
    expect(coach(other, 'palette', history, t0 + 90_000_000)!.history.today).toBe(1);
  });
});
