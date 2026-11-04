// PORTED FROM: bitfield-packages/packages/chat/show/PresetButton.tsx @ e99ac5976
// frontends/web/src/packages/chat/PresetButton.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Individual pill-shaped preset button with icon, label, optional AI badge,
// and optional keyboard shortcut hint. Clicking executes the preset's prompt
// via the onExecute callback.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pill-shaped: rounded-full px-3 py-1.5
// 2. Glass secondary surface: bg-[var(--glass-bg-subtle)] border border-[var(--border-primary)] hover:bg-[var(--glass-bg-hover)]
// 3. Lucide React icon + label text
// 4. AI badge for auto_generated === true presets
// 5. Keyboard shortcut hint displayed when set (small text-[var(--text-muted)])
// 6. Exports pure function: getCategoryColor for category badges
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback } from 'react';
import * as LucideIcons from 'lucide-react';
import type { Preset } from '../read-data/read-chat-presets';
import { Button, Badge, Icon, Text } from '../../ui';

// ---------------------------------------------------------------------------
// PURE LOGIC FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Map preset category to Badge variant.
 * Exported for category badge rendering.
 */
export function getCategoryVariant(
  category: Preset['category'],
): 'accent' | 'success' | 'warning' | 'info' | 'neutral' {
  switch (category) {
    case 'task':
      return 'accent';
    case 'analysis':
      return 'success';
    case 'system':
      return 'warning';
    case 'project':
      return 'info';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface PresetButtonProps {
  /** The preset to render */
  preset: Preset;
  /** Callback when the preset is clicked */
  onExecute: (prompt: string) => void;
}

// ---------------------------------------------------------------------------
// ICON RESOLVER
// ---------------------------------------------------------------------------

/**
 * Dynamically resolve a Lucide icon by name.
 * Returns null if the icon is not found.
 */
function getLucideIcon(iconName: string) {
  const icon = (LucideIcons as unknown as Record<string, React.ComponentType<any>>)[
    capitalize(iconName)
  ];
  return icon || null;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function PresetButton({ preset, onExecute }: PresetButtonProps) {
  const handleClick = useCallback(() => {
    onExecute(preset.prompt);
  }, [preset.prompt, onExecute]);

  const IconComponent = getLucideIcon(preset.icon);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      title={preset.description}
      className="group rounded-full whitespace-nowrap shrink-0 transition-colors"
    >
      {/* Icon */}
      {IconComponent && (
        <Icon icon={IconComponent} size="md" className="group-hover:text-[var(--text-primary)]" color="muted" />
      )}

      {/* Label */}
      <Text variant="label">{preset.label}</Text>

      {/* AI badge (for auto-generated presets) */}
      {preset.auto_generated && (
        <Badge variant="accent" size="sm" className="ml-1">
          AI
        </Badge>
      )}

      {/* Keyboard shortcut hint */}
      {preset.shortcut && (
        <Text variant="caption" color="ghost" className="ml-1">
          {preset.shortcut}
        </Text>
      )}
    </Button>
  );
}
