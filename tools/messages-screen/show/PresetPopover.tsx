// PORTED FROM: bitfield-packages/packages/chat/show/PresetPopover.tsx @ e99ac5976
// bitfield-studio/packages/chat/show/PresetPopover.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The preset picker: a "Presets" pill that opens the enabled presets and, on
// pick, fires onSelectPreset with the preset's label/prompt/description so the
// parent can prefill the composer (not auto-send).
//
// This is a CONFIGURATION of the shared ui/ GroupedPicker primitive — the same
// picker the model/participant selector uses (L069: one picker, N configs). It
// runs GroupedPicker in ACTION-MENU mode (selected=undefined): picking a row
// fires an action instead of persisting a selection, so no row is checkmarked.
// Presets carry a one-line description, surfaced as the row subline.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Composes ui/ GroupedPicker — NO bespoke popover/dropdown here (L066/L069).
// 2. Reuses filterEnabledPresets/sortPresetsByOrder (no duplication).
// 3. Returns null when no enabled presets exist.
// 4. onSelectPreset fires with (label, prompt, description) — parent decides.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback } from 'react';
import { Zap } from 'lucide-react';
import { filterEnabledPresets, sortPresetsByOrder } from './PresetButtonRow';
import type { Preset } from '../read-data/read-chat-presets';
import { GroupedPicker, Icon } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface PresetPopoverProps {
  /** All presets (may include disabled ones — filtered internally) */
  presets: Preset[];
  /** Called when a preset is selected with label, prompt, and optional description */
  onSelectPreset: (label: string, prompt: string, description?: string) => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function PresetPopover({ presets, onSelectPreset }: PresetPopoverProps) {
  const enabledAndSorted = sortPresetsByOrder(filterEnabledPresets(presets));

  const handleSelect = useCallback(
    (preset: Preset) => {
      onSelectPreset(preset.label, preset.prompt, preset.description);
    },
    [onSelectPreset],
  );

  if (enabledAndSorted.length === 0) return null;

  return (
    <GroupedPicker<Preset>
      items={enabledAndSorted}
      selected={undefined}
      getKey={(preset) => preset.id}
      getLabel={(preset) => preset.label}
      getDescription={(preset) => preset.description}
      onSelect={handleSelect}
      triggerLabel="Presets"
      triggerLeading={<Icon icon={Zap} size="xs" color="faint" />}
    />
  );
}
