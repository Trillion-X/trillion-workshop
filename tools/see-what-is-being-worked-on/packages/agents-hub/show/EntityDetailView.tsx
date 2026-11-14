// package-set://bitfield-studio/packages/agents-hub/show/EntityDetailView.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The DETAIL panel for any non-agent building block (Model, Tool, Instruction,
// Memory, Run, Permission). Opening any card in those categories shows THIS
// inline — full content, who uses it, its facts — exactly the way opening an
// agent shows AgentManagerView. One detail primitive, every kind a
// configuration of it (L069): the caller hands a finished EntityDetailModel of
// human display strings; this view only arranges them. It never decodes records
// and never speaks internal vocabulary.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Real content is VISIBLE inline — full description, not a truncated teaser.
// 2. Empty sections say so honestly; never a sample row (no fake data, L117).
// 3. Delete is shown only when the caller passes onDelete (a building block with
//    a writable home); history with no writable home shows no false Delete.
// 4. No internal vocabulary in visible copy — human language only (L114/L118).
//
// =============================================================================

import React from 'react';
import { Badge, Button, Card, Container, NamedIcon, Text } from '@/packages/ui';
import type { EntityCardProps } from '@/packages/agents-hub/show/EntityCard';

export interface EntityDetailField {
  label: string;
  value: string;
}

/** Everything the detail panel renders — all human display strings. */
export interface EntityDetailModel {
  icon: string;
  /** Singular kind word for the subtitle, e.g. "Model", "Tool". */
  kindLabel: string;
  name: string;
  context?: string;
  badge?: string;
  badgeTone?: EntityCardProps['badgeTone'];
  /** Full, untruncated body (instruction text, tool description, memory…). */
  description?: string;
  /** Names of agents that use this block (already resolved to human names). */
  usedBy: readonly string[];
  /** Extra fact rows (capabilities, provider, timestamps…). */
  fields: readonly EntityDetailField[];
}

export interface EntityDetailViewProps {
  entity: EntityDetailModel;
  /** Plural category label for the back button, e.g. "Models". */
  backLabel: string;
  onBack: () => void;
  /** Present → render a Delete action; absent → this block can't be deleted. */
  onDelete?: () => void;
  busy?: boolean;
}

export function EntityDetailView({
  entity,
  backLabel,
  onBack,
  onDelete,
  busy,
}: EntityDetailViewProps): React.ReactElement {
  return (
    <Container layout="vertical" gap="md" flex="1" minHeight="0" overflow="hidden">
      {/* ---- header: back, identity, badge, delete ---- */}
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button variant="ghost" size="sm" aria-label={`Back to ${backLabel}`} onClick={onBack}>
          <NamedIcon name="ArrowLeft" size="xs" />
          {backLabel}
        </Button>
        <Card variant="nested" padding="xs">
          <NamedIcon name={entity.icon} size="sm" />
        </Card>
        <Container layout="vertical" flex="1" overflow="hidden">
          <Text variant="heading-md" truncate>{entity.name}</Text>
          <Text variant="body-xs" color="faint" truncate>
            {entity.context ? `${entity.kindLabel} · ${entity.context}` : entity.kindLabel}
          </Text>
        </Container>
        {entity.badge && <Badge variant={entity.badgeTone ?? 'muted'}>{entity.badge}</Badge>}
        {onDelete && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Delete ${entity.name}`}
            disabled={busy}
            onClick={onDelete}
          >
            <NamedIcon name="Trash2" size="xs" />
            Delete
          </Button>
        )}
      </Container>

      {/* ---- body ---- */}
      <Container layout="vertical" gap="md" flex="1" overflow="y-auto" minHeight="0">
        <Card variant="nested" padding="md" layout="stack">
          <Text variant="overline" color="faint">Details</Text>
          {entity.description
            ? <Text variant="body-sm" color="muted">{entity.description}</Text>
            : <Text variant="body-xs" color="faint">No description.</Text>}
        </Card>

        {entity.fields.length > 0 && (
          <Card variant="nested" padding="md" layout="stack">
            {entity.fields.map((field) => (
              <Container key={field.label} layout="horizontal" gap="md" alignItems="baseline">
                <Container layout="vertical" minWidth="140px">
                  <Text variant="body-xs" color="faint">{field.label}</Text>
                </Container>
                <Text variant="body-sm">{field.value}</Text>
              </Container>
            ))}
          </Card>
        )}

        <Card variant="nested" padding="md" layout="stack">
          <Text variant="overline" color="faint">Used by</Text>
          {entity.usedBy.length === 0
            ? <Text variant="body-xs" color="faint">Not used by any agent yet.</Text>
            : (
              <Container layout="horizontal" gap="xs" wrap="wrap">
                {entity.usedBy.map((name) => (
                  <Badge key={name} variant="muted">{name}</Badge>
                ))}
              </Container>
            )}
        </Card>
      </Container>
    </Container>
  );
}
