// Tests for the appearance preset picker: pure item mapping + trigger render.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  appearancePresetItems,
  AppearancePresetControl,
} from './AppearancePresetControl';
import { BUILT_IN_APPEARANCE_PRESETS } from './appearance-preset-catalog';
import type { AppearancePreset } from './appearance-presets';

afterEach(() => cleanup());

describe('appearancePresetItems', () => {
  it('returns one item per built-in preset, mapping id->value and name->label', () => {
    const items = appearancePresetItems();
    expect(items).toHaveLength(BUILT_IN_APPEARANCE_PRESETS.length);
    for (let i = 0; i < BUILT_IN_APPEARANCE_PRESETS.length; i++) {
      const preset = BUILT_IN_APPEARANCE_PRESETS[i];
      expect(items[i].value).toBe(preset.id);
      expect(items[i].label).toBe(preset.name);
    }
  });

  it('is generic over the catalog — a custom 1-preset array yields exactly 1 item', () => {
    const custom: readonly AppearancePreset[] = [
      { id: 'nebula', name: 'Nebula', profile: { containerVariant: 'ghost' } },
    ];
    const items = appearancePresetItems(custom);
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe('nebula');
    expect(items[0].label).toBe('Nebula');
  });
});

describe('AppearancePresetControl', () => {
  it('renders the trigger Button with the accessible label', () => {
    const { getByRole } = render(<AppearancePresetControl onApply={() => {}} />);
    // The trigger states the ACTION ("Choose a style preset"), not the noun "Preset" —
    // it sits in a row already labelled "Style preset", so "Preset" read as "Preset Preset" (R46).
    const trigger = getByRole('button', { name: 'Choose a style preset' });
    expect(trigger).toBeTruthy();
  });
});
