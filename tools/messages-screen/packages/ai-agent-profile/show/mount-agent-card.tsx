// packages/ai-agent-profile/show/mount-agent-card.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The package-owned browser mount for ONE compact agent card. It is the ONLY
// file here that touches the live runtime: it reads the global `published-records`
// feed, finds the agent named by `surfaceInput.agentId`, folds it into the card
// model, and renders the pure `AgentCard`. A `group` board item mounts THIS via
// `extra.placeableSurface = { packageName:'ai-agent-profile', entryName:'agent-card',
// surfaceInput:{ agentId } }` — so the card is a live WINDOW onto the SSOT record,
// never a copy.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Live reads happen HERE, never in the surface. `AgentCard` is props-only.
// 2. The agent record is the SSOT — this mount reads it live every render; it
//    holds no copy. When the agent is absent (retired / feed loading), render an
//    HONEST unavailable state, never fabricated data (L117).
// 3. Status→tone is DATA: `STATUS_TONE_MAP` is an injected map (L090), overridable
//    by a future `agent-status-tone` record; there is no status enum / switch.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary, mountReactSurface } from '@/packages/ui';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import { readAgentProfiles, type PublishedRecord } from '../read-data/read-ai-agent-profiles';
import {
  foldAgentCard,
  NEUTRAL_TONE,
  type StatusToneMap,
} from '../read-data/agent-card-model';
import { AgentCard } from './AgentCard';

const PUBLISHED_RECORDS_INPUT = 'published-records';

/**
 * The default status→tone DATA map (L090). Keyed on RAW status strings a loop may
 * stamp; unknown keys fall back to {@link NEUTRAL_TONE}. This is DATA, not a
 * closed enum — a product may override it per deployment; adding a status is a new
 * entry here or in an override record, never a code branch. Colors reference
 * design tokens where possible so the dot honours the theme.
 */
export const STATUS_TONE_MAP: StatusToneMap = {
  running: { color: 'var(--status-success, #34d399)', label: 'Running' },
  active: { color: 'var(--status-success, #34d399)', label: 'Active' },
  available: { color: 'var(--status-success, #34d399)', label: 'Available' },
  working: { color: 'var(--status-success, #34d399)', label: 'Working' },
  idle: { color: 'var(--status-warning, #fbbf24)', label: 'Idle' },
  waiting: { color: 'var(--status-warning, #fbbf24)', label: 'Waiting' },
  spawning: { color: 'var(--status-info, #60a5fa)', label: 'Spawning' },
  new: { color: 'var(--status-info, #60a5fa)', label: 'New' },
  error: { color: 'var(--status-error, #f87171)', label: 'Error' },
  failed: { color: 'var(--status-error, #f87171)', label: 'Failed' },
  retired: { color: 'var(--text-tertiary, #8a8a8a)', label: 'Retired' },
  stopped: { color: 'var(--text-tertiary, #8a8a8a)', label: 'Stopped' },
};

/** Coerce whatever the published-records input yields into a record array. The
 *  feed may arrive as a bare array or wrapped ({records}/{items}/{value}); this
 *  normalizes all shapes so the reader (which filters by kind+shape) is robust. */
export function toPublishedRecords(raw: unknown): PublishedRecord[] {
  if (Array.isArray(raw)) return raw as PublishedRecord[];
  if (raw && typeof raw === 'object') {
    const carrier = raw as Record<string, unknown>;
    for (const key of ['records', 'items', 'value', 'published']) {
      const v = carrier[key];
      if (Array.isArray(v)) return v as PublishedRecord[];
    }
  }
  return [];
}

/** Pull the agent id this card was mounted for out of the opaque surfaceInput. */
export function readAgentId(surfaceInput: unknown): string | null {
  if (surfaceInput && typeof surfaceInput === 'object' && !Array.isArray(surfaceInput)) {
    const id = (surfaceInput as Record<string, unknown>).agentId;
    if (typeof id === 'string' && id.trim().length > 0) return id;
  }
  return null;
}

function AgentCardReader({ surfaceInput }: { surfaceInput?: unknown }) {
  const agentId = readAgentId(surfaceInput);
  const publishedRaw = useBitfieldData(PUBLISHED_RECORDS_INPUT);

  const profile = React.useMemo(() => {
    if (!agentId) return null;
    const profiles = readAgentProfiles(toPublishedRecords(publishedRaw));
    return profiles.find((p) => p.id === agentId) ?? null;
  }, [agentId, publishedRaw]);

  if (!profile) {
    // Honest unavailable state — the agent is retired or the feed is still
    // loading. Never fabricate a card (L117).
    return (
      <Card variant="panel" padding="sm" data-package="ai-agent-profile" data-surface="agent-card" data-status="unavailable">
        <Container layout="vertical" gap="xs">
          <Text variant="body" weight="semibold" color="subtle" truncate>
            {agentId ?? 'Agent'}
          </Text>
          <Text variant="caption" color="subtle">
            Unavailable
          </Text>
        </Container>
      </Card>
    );
  }

  const model = foldAgentCard(profile, STATUS_TONE_MAP, NEUTRAL_TONE, Date.now());
  return <AgentCard model={model} />;
}

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="AgentCard">
      <AgentCardReader surfaceInput={props.surfaceInput} />
    </ErrorBoundary>,
  );
}
