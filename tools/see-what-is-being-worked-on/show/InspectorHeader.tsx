// packages/workflow-canvas/show/InspectorHeader.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The inspector panel header, matching the Lindy flow-editor right-panel anatomy:
// a leading kind ICON (the same tinted frame the node card uses), the node title
// over a quiet type subtitle, and a close button. Editable nodes rename in place
// (click the title — Lindy's Rename without the menu detour).
//
// Blind: it takes a presentation icon name + accent tone (read-data already
// translated the node's Society kind), never a kind word. Composes the shared
// NodeIconFrame so the header and the card show the identical icon (SSOT).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { X as CloseIcon } from 'lucide-react';
import { Button, Container, Icon, Input, Text, Toggle } from '../../ui';
import { NodeIconFrame } from './node-icon';
import { NodeActionMenu, type NodeMenuAction } from './NodeActionMenu';

export interface InspectorHeaderProps {
  /** Presentation icon name (display.iconName) — blind; never a kind word. */
  iconName: string;
  /** Accent tone tinting the icon frame ('success' marks a trigger). */
  accentTone: 'success' | 'neutral';
  /** Node title (the human name). */
  title: string;
  /** Quiet type subtitle under the title (e.g. "Starts work" / "Action"). */
  typeLabel: string;
  editable: boolean;
  renaming: boolean;
  onTitleChange: (name: string) => void;
  onStartRename: () => void;
  onStopRename: () => void;
  onClose: () => void;
  /**
   * Current on/off state of the node. Drives the header's Enabled toggle —
   * Lindy's anatomy keeps on/off as a top-level pill beside the title, NOT
   * buried in the "…" menu.
   */
  enabled?: boolean;
  /**
   * When provided, the header renders the Enabled toggle. Pass it only for
   * nodes the user actually owns; shipped nodes show no dead control (L114).
   */
  onToggleEnabled?: (enabled: boolean) => void;
  /**
   * Per-node overflow actions (Rename / Delete / …). When empty/undefined the
   * "…" trigger is not rendered — the header decides nothing about which
   * actions exist; the caller hands it self-describing rows.
   */
  menuActions?: readonly NodeMenuAction[];
}

export function InspectorHeader({
  iconName,
  accentTone,
  title,
  typeLabel,
  editable,
  renaming,
  onTitleChange,
  onStartRename,
  onStopRename,
  onClose,
  enabled,
  onToggleEnabled,
  menuActions,
}: InspectorHeaderProps): React.ReactElement {
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" data-workflow-inspector-header="true">
      <NodeIconFrame iconName={iconName} accentTone={accentTone} />
      <Container flex={1} layout="vertical" gap="xs" style={{ minWidth: 0 }}>
        {editable && renaming ? (
          <Input
            aria-label="Action name"
            value={title}
            autoFocus
            onChange={(event) => onTitleChange(event.target.value)}
            onBlur={onStopRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') onStopRename();
            }}
          />
        ) : (
          <Text
            variant="body-sm"
            weight="semibold"
            truncate
            title={editable ? 'Click to rename' : title}
            style={editable ? { cursor: 'text' } : undefined}
            onClick={editable ? onStartRename : undefined}
            data-workflow-rename-title={editable ? 'true' : undefined}
          >
            {title}
          </Text>
        )}
        {typeLabel && <Text variant="caption" color="muted" truncate>{typeLabel}</Text>}
      </Container>
      {onToggleEnabled && (
        <Toggle
          checked={enabled ?? false}
          onCheckedChange={onToggleEnabled}
          label={enabled ? 'On' : 'Paused'}
        />
      )}
      {menuActions && menuActions.length > 0 && <NodeActionMenu actions={menuActions} />}
      <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
        <Icon icon={CloseIcon} size="sm" />
      </Button>
    </Container>
  );
}
