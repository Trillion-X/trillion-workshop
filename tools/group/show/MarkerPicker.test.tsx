// MarkerPicker — pure markerItems mapping + trigger render tests.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { markerItems, MarkerPicker } from './MarkerPicker';
import { BOARD_MARKERS, type BoardMarker } from './board-marker-catalog';

afterEach(cleanup);

describe('markerItems (pure)', () => {
  it('produces exactly one item per marker', () => {
    const items = markerItems();
    expect(items).toHaveLength(BOARD_MARKERS.length);
    expect(items.map((i) => i.value)).toEqual(BOARD_MARKERS.map((m) => m.id));
  });

  it("a glyph marker's label starts with its glyph", () => {
    const disc = BOARD_MARKERS.find((m) => m.id === 'disc');
    expect(disc?.glyph).toBe('•');
    const item = markerItems().find((i) => i.value === 'disc');
    expect(item?.label.startsWith('•')).toBe(true);
    expect(item?.label).toContain('Disc');
  });

  it('a decimal ordinal marker\'s label starts with "1."', () => {
    const item = markerItems().find((i) => i.value === 'decimal');
    expect(item?.label.startsWith('1.')).toBe(true);
    expect(item?.label).toContain('Decimal');
  });

  it('is generic — a custom 1-marker array yields exactly 1 item', () => {
    const custom: readonly BoardMarker[] = [
      { id: 'x', label: 'Bullet X', produce: 'glyph', glyph: '❖' },
    ];
    const items = markerItems(custom);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ value: 'x', label: '❖  Bullet X' });
  });
});

describe('MarkerPicker (render)', () => {
  it('renders the "List marker" trigger', () => {
    render(<MarkerPicker onPick={() => {}} />);
    expect(screen.getByRole('button', { name: 'List marker' })).toBeTruthy();
  });
});
