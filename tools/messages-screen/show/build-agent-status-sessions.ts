// PORTED FROM: bitfield-packages/packages/chat/show/build-agent-status-sessions.ts @ e99ac5976
// packages/chat/show/build-agent-status-sessions.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure projection: distill the active turn + its participants into the blind
// `AgentSessionStatus[]` the AgentStatusStrip renders in the thread header. This
// is the data half of the Cursor "agent/model header row" anatomy (chat
// full-surface screen contract §3/§9.4) — each active model session shown with
// its live status (Working Ns / Thinking / Done / Failed).
//
// Blind + generic: it names no CLI/model/provider, adds no code per agent, and
// reads identity from the ONE universal participant→mark mapping. The caller
// (ChatView) owns the turn state and supplies a single phase descriptor; this
// fans it across the active participants. A multi-agent turn = more participants
// in, more chips out, zero code change (L069/L090).
//
// NON-NEGOTIABLE INVARIANTS
//   - Pure function — no React, no I/O. Unit-testable with plain data (L089).
//   - Zero domain vocabulary; phase is a generic lifecycle, not a model name.
//   - Identity marks via participantToMarkSpec only (no second mark renderer).
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { DisplayMarkSpec } from '../../ui/show/display-mark';
import type { AddressedParticipantInfo } from '../read-data/read-addressed-exchange-participants';
import { participantToMarkSpec } from './participant-mark-spec';

/** Generic turn lifecycle phase (not a model name). */
export type AgentPhase = 'working' | 'thinking' | 'done' | 'error';

/** One agent/model chip in the header strip. */
export interface AgentSessionStatus {
  /** Stable key (the participant ref). */
  key: string;
  /** Human label shown on the chip. */
  label: string;
  /** Universal identity mark. */
  mark: DisplayMarkSpec;
  /** Lifecycle phase → drives the status pill. */
  phase: AgentPhase;
  /** Monotonic ms when the turn began (live "Working Ns" elapsed). */
  startedAtMs?: number;
  /** Extra detail (e.g. an error message), surfaced via the chip. */
  message?: string;
}

/**
 * The active turn distilled to the one thing the header needs: its phase (and,
 * for a running turn, when it started). Null = no active/recent turn → no strip.
 * The caller owns the turn state; this projection is blind to how a turn runs.
 */
export interface AgentTurnDescriptor {
  phase: AgentPhase;
  startedAtMs?: number;
  message?: string;
}

/** Fan the active turn's phase across its participants into header chips. */
export function buildAgentStatusSessions(
  turn: AgentTurnDescriptor | null,
  participants: readonly AddressedParticipantInfo[],
): AgentSessionStatus[] {
  if (!turn || participants.length === 0) return [];
  return participants.map((participant) => ({
    key: participant.participantRef,
    label: participant.label || participant.participantRef,
    mark: participantToMarkSpec(participant),
    phase: turn.phase,
    ...(turn.startedAtMs !== undefined ? { startedAtMs: turn.startedAtMs } : {}),
    ...(turn.message ? { message: turn.message } : {}),
  }));
}
