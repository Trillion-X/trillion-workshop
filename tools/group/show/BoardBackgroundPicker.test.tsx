// packages/group/show/BoardBackgroundPicker.test.tsx
//
// Render proof (RTL/jsdom) for the board-DEFAULT appearance controls, now rendered generically from
// the BOARD_DEFAULT_CONTROLS DATA descriptors via the blind BoardDefaultControl primitive. Asserts:
// (1) every descriptor's control renders in the open popover (a select shows its label; the color
// shows a color button); (2) the color's "Reset" is HIDDEN with no override and SHOWN once the board
// overrides that key; (3) clicking Reset clears the key via onSetBoardDefault(key, undefined);
// (4) the shared SSOT DATA (weights / swatches / padding) is fail-safe.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { BoardBackgroundPicker } from './BoardBackgroundPicker';
import {
  BOARD_DEFAULT_CONTROLS,
  CONNECTOR_WIDTH_OPTIONS,
  CONNECTOR_COLOR_PRESETS,
  PADDING_OPTIONS,
  coerceBoardDefaultValue,
} from './item-appearance';

afterEach(() => cleanup());

function mount(over: Partial<React.ComponentProps<typeof BoardBackgroundPicker>> = {}) {
  const props: React.ComponentProps<typeof BoardBackgroundPicker> = {
    open: true,
    onToggleOpen: vi.fn(),
    onDismiss: vi.fn(),
    currentBackgroundId: 'plain',
    onChooseBackground: vi.fn(),
    gridSnap: false,
    onToggleGridSnap: vi.fn(),
    onApplyAppearancePreset: vi.fn(),
    boardAppearance: undefined,
    onSetBoardDefault: vi.fn(),
    ...over,
  };
  render(<BoardBackgroundPicker {...props} />);
  return props;
}

/** The board-DEFAULT controls now live under a COLLAPSED-by-default "Defaults" section
 *  (R46 — so they no longer read as an unsectioned wall). Expand it before asserting on them. */
function expandDefaults() {
  fireEvent.click(screen.getByText('Defaults'));
}

describe('BoardBackgroundPicker — descriptor-driven board-default controls', () => {
  it('renders a control for every BOARD_DEFAULT_CONTROLS descriptor when open', () => {
    mount();
    expandDefaults();
    for (const d of BOARD_DEFAULT_CONTROLS) {
      // Each control (select or color) exposes its descriptor label as the widget's accessible name.
      expect(screen.getAllByLabelText(d.label).length).toBeGreaterThan(0);
    }
  });

  it('surfaces the (i) help affordance from the default BOARD_SETTING_INFO catalog (no primitive-without-product)', () => {
    // The SettingInfoOverlay primitive is only a product if a real descriptor catalog feeds it.
    // mount() passes NO settingInfoDescriptors → the component must fall back to BOARD_SETTING_INFO,
    // so non-obvious settings show a "Help for <title>" (i) button. Before this default was wired,
    // settingInfoDescriptors was always undefined and NO help icon ever rendered.
    mount();
    expandDefaults();
    expect(screen.getByLabelText('Help for Note style')).toBeTruthy(); // containerVariant
    expect(screen.getByLabelText('Help for Bullet marker')).toBeTruthy(); // marker
    // A self-evident control (a labelled number field) has NO help icon — no filler affordance (L118).
    expect(screen.queryByLabelText('Help for New note width')).toBeNull(); // defaultWidth: no info entry
  });

  it('renders the "None" (no color, no tile) background FIRST so a board is never forced to wear a pattern (R46)', () => {
    mount();
    const swatches = screen.getAllByLabelText(/^Background: /);
    // First swatch is "None" — the no-pattern surface pulled to the front (display-only ordering;
    // the catalog default stays 'dots', unchanged).
    expect(swatches[0].getAttribute('aria-label')).toBe('Background: None');
  });

  it('shows "Save this look" only when onSaveLook is provided, and fires it on click', () => {
    // Absent → no save affordance (the capture surface is opt-in).
    mount({ onSaveLook: undefined });
    expect(screen.queryByText('Save this look')).toBeNull();
    cleanup();
    const onSaveLook = vi.fn();
    mount({ onSaveLook });
    fireEvent.click(screen.getByText('Save this look'));
    expect(onSaveLook).toHaveBeenCalledTimes(1);
  });

  it('HIDES a color control Reset when the board has no override for that key', () => {
    mount({ boardAppearance: undefined });
    expandDefaults();
    expect(screen.queryByLabelText('Reset connector color')).toBeNull();
  });

  it('SHOWS Reset once the board overrides the key, and clearing it clears the key', () => {
    const props = mount({ boardAppearance: { connectorColor: '#ef4444' } });
    expandDefaults();
    const reset = screen.getByLabelText('Reset connector color');
    expect(reset).toBeTruthy();
    fireEvent.click(reset);
    // Reset routes through the ONE generic setter with undefined → the cascade key is deleted.
    expect(props.onSetBoardDefault).toHaveBeenCalledWith('connectorColor', undefined);
  });

  it('a number control writes a coerced NUMBER on input and clears the key when emptied', () => {
    const props = mount({ boardAppearance: { defaultWidth: 220 } });
    expandDefaults();
    const input = screen.getByLabelText('New note width') as HTMLInputElement;
    expect(input.value).toBe('220');
    // Typing a px value writes a real number (not the string) through the generic setter.
    fireEvent.change(input, { target: { value: '300' } });
    expect(props.onSetBoardDefault).toHaveBeenCalledWith('defaultWidth', 300);
    // Emptying the field clears the cascade key (falls back to the global default footprint).
    fireEvent.change(input, { target: { value: '' } });
    expect(props.onSetBoardDefault).toHaveBeenCalledWith('defaultWidth', undefined);
  });

  it('coerceBoardDefaultValue is the SSOT coercion contract (empty clears, number-kind → Number)', () => {
    expect(coerceBoardDefaultValue('', 'number')).toBeUndefined();
    expect(coerceBoardDefaultValue('', 'string')).toBeUndefined();
    expect(coerceBoardDefaultValue('', 'boolean')).toBeUndefined();
    expect(coerceBoardDefaultValue('300', 'number')).toBe(300);
    expect(coerceBoardDefaultValue('surface')).toBe('surface');
    // boolean-kind (the connector-dashed select): 'true'/'false' → real booleans, '' clears.
    expect(coerceBoardDefaultValue('true', 'boolean')).toBe(true);
    expect(coerceBoardDefaultValue('false', 'boolean')).toBe(false);
  });

  it('every descriptor is well-formed and its SSOT DATA is fail-safe', () => {
    // A select descriptor must carry options; a color descriptor must carry presets. The stored
    // weights parse to positive numbers, the swatches are hexes, the padding rows are non-empty.
    for (const d of BOARD_DEFAULT_CONTROLS) {
      expect(d.key.length).toBeGreaterThan(0);
      expect(d.label.length).toBeGreaterThan(0);
      if (d.widget === 'select') expect((d.options ?? []).length).toBeGreaterThan(0);
      if (d.widget === 'color') expect((d.presets ?? []).length).toBeGreaterThan(0);
      // A number control must coerce to a number (else it stores a string at a numeric cascade key).
      if (d.widget === 'number') expect(d.valueKind).toBe('number');
    }
    for (const opt of CONNECTOR_WIDTH_OPTIONS) {
      const n = Number(opt.value);
      expect(Number.isFinite(n) && n > 0).toBe(true);
    }
    for (const hex of CONNECTOR_COLOR_PRESETS) expect(/^#[0-9a-fA-F]{6}$/.test(hex)).toBe(true);
    for (const opt of PADDING_OPTIONS) expect(typeof opt.value === 'string' && opt.value.length > 0).toBe(true);
  });
});
