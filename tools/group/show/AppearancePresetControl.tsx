// Dropdown that applies a built-in appearance preset to the current board.

import { Button, Dropdown, Icon } from '../../ui';
import { Palette } from 'lucide-react';
import { BUILT_IN_APPEARANCE_PRESETS } from 'trillion-workshop/tools/organize-the-sidebar/show/appearance-preset-catalog.ts';
import type { AppearancePreset } from './appearance-presets';

export function appearancePresetItems(
  presets: readonly AppearancePreset[] = BUILT_IN_APPEARANCE_PRESETS,
): Array<{ value: string; label: string; icon?: string }> {
  return presets.map((p) => ({ value: p.id, label: p.name, icon: 'Palette' }));
}

export interface AppearancePresetControlProps {
  readonly value?: string;
  readonly onApply: (profile: Record<string, unknown>, presetId: string) => void;
  readonly presets?: readonly AppearancePreset[];
}

export function AppearancePresetControl(props: AppearancePresetControlProps): JSX.Element {
  const presets = props.presets ?? BUILT_IN_APPEARANCE_PRESETS;
  return (
    <Dropdown
      items={appearancePresetItems(presets)}
      value={props.value ?? ''}
      onValueChange={(id) => {
        const p = presets.find((x) => x.id === id);
        if (p) props.onApply(p.profile, p.id);
      }}
      align="start"
      aria-label="Board appearance preset"
      customTrigger={
        // Label is "Choose…" (with a Palette glyph), NOT "Preset" — the row it sits
        // in is already labelled "Style preset", so a "Preset" button read as the
        // duplicated "Preset Preset" a user flagged (R46). The button states the ACTION.
        <Button variant="ghost" size="sm" aria-label="Choose a style preset">
          <Icon icon={Palette} size="sm" /> Choose…
        </Button>
      }
    />
  );
}
