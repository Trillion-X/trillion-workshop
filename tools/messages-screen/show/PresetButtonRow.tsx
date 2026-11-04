// PORTED FROM: bitfield-packages/packages/chat/show/PresetButtonRow.tsx @ e99ac5976
// frontends/web/src/packages/chat/PresetButtonRow.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Horizontal scrollable row of preset buttons. Renders all enabled presets,
// sorted by order field. Each preset is rendered as a PresetButton that can
// be clicked to execute the preset's prompt via the chat input.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Only renders enabled presets (enabled === true)
// 2. Presets are sorted ascending by order field
// 3. Horizontal scrollable container with overflow-x-auto
// 4. Shows "No presets configured" when list is empty
// 5. Exports pure functions: filterEnabledPresets, sortPresetsByOrder
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { PresetButton } from './PresetButton';
import { Text } from '../../ui';
import type { Preset } from '../read-data/read-chat-presets';

// ---------------------------------------------------------------------------
// PURE LOGIC FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Filter presets to only those that are enabled (enabled === true).
 */
export function filterEnabledPresets(presets: Preset[]): Preset[] {
  return presets.filter((p) => p.enabled === true);
}

/**
 * Sort presets ascending by order field (lower order = higher in list).
 */
export function sortPresetsByOrder(presets: Preset[]): Preset[] {
  return [...presets].sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface PresetButtonRowProps {
  /** List of all presets (may include disabled ones) */
  presets: Preset[];
  /** Callback when a preset is executed */
  onExecute: (prompt: string) => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function PresetButtonRow({ presets, onExecute }: PresetButtonRowProps) {
  const enabledAndSorted = sortPresetsByOrder(
    filterEnabledPresets(presets),
  );

  if (enabledAndSorted.length === 0) {
    return (
      <div className="px-3 py-2 text-center">
        <Text variant="body" color="faint">No saved starting points</Text>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border-primary)] px-3 py-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Text variant="body-xs" color="subtle" className="whitespace-nowrap shrink-0">
          Presets:
        </Text>
        {enabledAndSorted.map((preset) => (
          <PresetButton
            key={preset.id}
            preset={preset}
            onExecute={onExecute}
          />
        ))}
      </div>
    </div>
  );
}
