// PORTED FROM: bitfield-packages/packages/chat/show/AgentStatusStrip.tsx @ e99ac5976
// packages/chat/show/AgentStatusStrip.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Cursor-style agent/model header chip strip (chat full-surface screen
// contract §3/§9.4): a quiet horizontal row of chips, one per active model
// session, each showing identity + live status — "Working 12s", "Thinking",
// "Done", "Failed". Sits in the thread header (SessionMetaBar).
//
// BLIND presentation: it renders whatever `sessions` it is given (built by
// build-agent-status-sessions.ts) and knows no CLI/model/provider name. A
// multi-agent turn = more chips, zero code change (L069/L090). The only behavior
// it owns is the per-second elapsed tick for a running ("working") chip — a
// display concern, kept here so the caller needn't run a timer.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Composed from ui/ primitives only (Container/Text/Badge/DisplayMark) via
//    PROPS — zero className, zero inline style (L065/L066).
// 2. Renders nothing when there are no sessions (no empty filler — L118).
// 3. The elapsed clock uses the SAME monotonic source as the caller's
//    startedAtMs, so "Working Ns" is consistent everywhere (L089).
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { Badge, Container, Text } from '../../ui';
import { DisplayMark } from '../../ui/show/display-mark';
import type { AgentSessionStatus, AgentPhase } from './build-agent-status-sessions';

/** Phase → status-pill color (Badge variant). */
const PHASE_VARIANT: Record<AgentPhase, 'info' | 'neutral' | 'success' | 'error'> = {
  working: 'info',
  thinking: 'neutral',
  done: 'success',
  error: 'error',
};

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** The status pill text for a session. "Working Ns" ticks live; the rest fixed. */
export function statusLabel(session: AgentSessionStatus): string {
  switch (session.phase) {
    case 'working': {
      if (session.startedAtMs === undefined) return 'Working';
      const seconds = Math.max(0, Math.round((nowMs() - session.startedAtMs) / 1000));
      return `Working ${seconds}s`;
    }
    case 'thinking':
      return 'Working';
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
  }
}

export interface AgentStatusStripProps {
  sessions: readonly AgentSessionStatus[];
}

export function AgentStatusStrip({ sessions }: AgentStatusStripProps) {
  // Re-render once a second while any chip is a running ("working") clock.
  const hasLiveClock = sessions.some((s) => s.phase === 'working' && s.startedAtMs !== undefined);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!hasLiveClock) return;
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasLiveClock]);

  if (sessions.length === 0) return null;

  return (
    <Container layout="horizontal" gap="sm" alignItems="center" padding="none" wrap>
      {sessions.map((session) => (
        <Container key={session.key} layout="horizontal" gap="xs" alignItems="center" padding="none">
          <DisplayMark size="xs" spec={session.mark} />
          <Text variant="caption" color="muted">
            {session.label}
          </Text>
          <Badge variant={PHASE_VARIANT[session.phase]} size="sm">
            {statusLabel(session)}
          </Badge>
        </Container>
      ))}
    </Container>
  );
}
