// packages/workflow-canvas/show/node-icon.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The shared node icon vocabulary for the Workflow Canvas: the icon-name → glyph
// map and the tinted icon-frame molecule. ONE definition, composed by both the
// node card and the inspector header (SSOT — never duplicated).
//
// Blind by construction: keyed by presentation icon NAMES (lucide-style) that
// read-data already translated from the node's Society kind/job into
// `display.iconName`. Neither the card nor the header ever sees 'trigger'/'ask'
// — only an icon name + an accent tone.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import {
  ArrowRightLeft as AskIcon,
  BookOpen as ReadIcon,
  CornerDownLeft as ReturnIcon,
  PenLine as WriteIcon,
  Play as RunIcon,
  Repeat as LoopIcon,
  Settings as SettingsIcon,
  Timer as WaitIcon,
  Zap as ZapIcon,
} from 'lucide-react';
import { Container, Icon } from '../../ui';

export type NodeGlyph = typeof SettingsIcon;

/** Presentation icon-name → glyph. NOT domain vocabulary — read-data maps the
 *  node's kind/job to one of these names; the renderers stay blind. */
const ICON_BY_NAME: Record<string, NodeGlyph> = {
  zap: ZapIcon,
  'arrow-right-left': AskIcon,
  'pen-line': WriteIcon,
  'book-open': ReadIcon,
  'corner-down-left': ReturnIcon,
  timer: WaitIcon,
  play: RunIcon,
  repeat: LoopIcon,
  settings: SettingsIcon,
};

/** The glyph for a presentation icon name (settings fallback for the unknown). */
export function iconForName(name: string): NodeGlyph {
  return ICON_BY_NAME[name] ?? SettingsIcon;
}

/**
 * The tinted icon frame shared by the node card and the inspector header — a
 * rounded square tinted by accent tone with the kind glyph centered (Lindy's
 * leading node icon). `selected` brightens the glyph; tone 'success' marks a
 * trigger.
 */
export function NodeIconFrame({
  iconName,
  accentTone,
  selected = false,
  size = 32,
}: {
  iconName: string;
  accentTone: 'success' | 'neutral';
  selected?: boolean;
  size?: number;
}): React.ReactElement {
  const Glyph = iconForName(iconName);
  return (
    <Container
      data-workflow-node-icon-frame="true"
      layout="vertical"
      alignItems="center"
      justifyContent="center"
      flex="none"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        minWidth: `${size}px`,
        borderRadius: 'var(--radius-default)',
        backgroundColor: accentTone === 'success'
          ? 'var(--status-success-bg, rgba(70, 167, 88, 0.12))'
          : 'var(--glass-bg-secondary)',
      }}
    >
      <Icon
        icon={Glyph}
        size="sm"
        color={accentTone === 'success' ? 'success' : selected ? 'primary' : 'secondary'}
      />
    </Container>
  );
}
