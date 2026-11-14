// packages/notifications/show/setting-save-bar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The persistent save/revert area for a setting screen. Shows the live status
// (dot + sentence), keeps Save reachable, and disables Save with a reason when
// nothing changed / offline / a write is in flight. Pure and blind: it consumes
// only the status/save/revert slices of a HumanSettingView.
//
// Reference anatomy (Mobbin CS-145 contract): "a persistent save/revert area",
// "a disabled save state when nothing changed", "a pending state that preserves
// the selected choice while the write is in flight", "mobile keeps the save
// action reachable at the bottom". Save is the primary action; Revert is
// secondary; status reads without inspecting developer details.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain literals. All words come from the projected view; no mode key
//    or backend term appears in source.
// 2. Composes only shared ui primitives (Card, Container, Text, Button,
//    StatusDot) — no raw div/span, no inline styling (L065).
// 3. The status tone maps to a generic StatusDot variant — never a color.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Button, Card, Container, StatusDot, Text } from '../../ui';
import type { HumanSettingView } from '../read-data/project-setting-view';
import type { SettingTone } from '../read-data/setting-copy-table';

// SettingTone is a superset name space that maps 1:1 onto the StatusDot status
// family except `idle`, which both share. Pure data mapping, no branching logic.
const DOT_STATUS: Record<SettingTone, 'success' | 'warning' | 'error' | 'info' | 'accent' | 'idle'> = {
  idle: 'idle',
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
  accent: 'accent',
};

export interface SettingSaveBarProps {
  view: HumanSettingView;
  onSave: () => void;
  onRevert: () => void;
}

export function SettingSaveBar({ view, onSave, onRevert }: SettingSaveBarProps) {
  const saving = view.status === 'saving';
  return (
    <Card
      variant="surface"
      layout="row"
      padding="md"
      data-setting-save-bar
      data-status={view.status}
      className="items-center justify-between gap-4"
    >
      <Container
        layout="horizontal"
        gap="sm"
        padding="none"
        alignItems="center"
        className="min-w-0"
      >
        <StatusDot status={DOT_STATUS[view.statusTone]} pulse={saving} label={view.statusCopy} />
        <Text
          variant="body-xs"
          color={view.status === 'error' ? 'error' : 'muted'}
          data-status-copy
          className="min-w-0 truncate"
        >
          {view.errorCopy ?? view.statusCopy}
        </Text>
      </Container>

      <Container layout="horizontal" gap="sm" padding="none" alignItems="center" className="shrink-0">
        <Button
          variant="ghost"
          size="sm"
          disabled={!view.revert.enabled}
          onClick={onRevert}
          data-setting-revert
        >
          {view.revert.label}
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!view.save.enabled}
          title={view.save.disabledReason ?? undefined}
          onClick={onSave}
          data-setting-save
        >
          {view.save.label}
        </Button>
      </Container>
    </Card>
  );
}
