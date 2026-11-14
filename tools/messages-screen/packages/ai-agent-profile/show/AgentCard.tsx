// packages/ai-agent-profile/show/AgentCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The compact, props-only live-mount card for ONE agent (~240×120). Rendered as
// the content of a `group` board item (the item holds only a pointer +
// arrangement; this card live-reads the agent record via its mount). Cofounder.co
// company-card anatomy: title, a status dot (tone from DATA), model, department,
// and a "last active" line. NO live reads here — the mount folds the model and
// passes it in (invariant 1 of mount-agent-card).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Props-only. Zero I/O, zero live reads, zero clock — deterministic render.
// 2. Styling via `ui` primitives + tokens only (L065/L066): Card, ColorDot,
//    Container, Text. Color for the status dot is DATA (a hex/var from the tone
//    map) — the ONE sanctioned data-driven color path (ColorDot's documented
//    exception).
// 3. No status enum, no `switch (status)` — the tone arrives pre-resolved in the
//    model (L090). This file never names a specific status string.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Card } from '@/packages/ui/show/card';
import { ColorDot } from '@/packages/ui/show/color-dot';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import type { AgentCardModel } from '../read-data/agent-card-model';

export interface AgentCardProps {
  readonly model: AgentCardModel;
}

/**
 * Render one agent's compact card. Everything is derived DATA on `model`; this
 * component adds no decisions of its own beyond layout.
 */
export function AgentCard({ model }: AgentCardProps) {
  return (
    <Card
      variant="panel"
      padding="sm"
      data-package="ai-agent-profile"
      data-surface="agent-card"
      data-agent-id={model.agentId}
      data-status={model.statusKey ?? 'unknown'}
    >
      <Container layout="vertical" gap="xs">
        {/* Title row: status dot + agent name */}
        <Container layout="horizontal" alignItems="center" gap="xs">
          <ColorDot color={model.tone.color} size="md" label={model.tone.label} />
          <Text variant="body" weight="semibold" truncate>
            {model.title}
          </Text>
        </Container>

        {/* Status label */}
        <Text variant="caption" color="muted">
          {model.tone.label}
        </Text>

        {/* Meta row: department + model */}
        {(model.department || model.model) && (
          <Container layout="horizontal" alignItems="center" gap="xs" wrap="wrap">
            {model.department && (
              <Text variant="caption" color="subtle" truncate>
                {model.department}
              </Text>
            )}
            {model.department && model.model && (
              <Text variant="caption" color="subtle">
                ·
              </Text>
            )}
            {model.model && (
              <Text variant="caption" color="subtle" truncate>
                {model.model}
              </Text>
            )}
          </Container>
        )}

        {/* Last active */}
        {model.lastActive && (
          <Text variant="caption" color="subtle">
            {model.lastActive}
          </Text>
        )}
      </Container>
    </Card>
  );
}
