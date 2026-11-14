// packages/ai-agent-profile/read-data/agent-card-model.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PURE fold that turns one live `AgentProfile` (SSOT record) into the compact
// display model the `AgentCard` leaf renders. No I/O, no React, no Date/random —
// a caller supplies `nowMs` for the "last active" readout. Unit-testable in full.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. STATUS IS NEVER AN ENUM (L090 / enum-dissolution). The record carries a RAW
//    status string ("running", "idle", "retired", or anything a future loop
//    invents). This fold maps it to a display tone via an INJECTED capability map
//    (`tones`) supplied by the caller (product DATA), never a closed union or a
//    `switch (status)` here. An unknown key falls back to a neutral tone — a new
//    status is a DATA row in the tone map, zero code change here.
// 2. The card NEVER copies the agent record. This model is a projection of the
//    live profile; the board item that mounts the card holds only a pointer
//    (`surfaceInput.agentId`) + arrangement DATA. The record stays the SSOT.
// 3. Blind to product vocabulary: this file names "agent"/"department"/"status"
//    only because they are this package's own domain (ai-agent-profile), never
//    another package's internals (L098).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { AgentProfile } from './read-ai-agent-profiles';

/** One display tone for a status — a color the {@link AgentCard} paints the dot
 *  with plus a human label. Pure DATA, supplied by the caller (never core-owned). */
export interface StatusTone {
  /** Any CSS color (hex/var). Painted on the status ColorDot. */
  readonly color: string;
  /** The human-facing status label (never the raw key if a nicer one exists). */
  readonly label: string;
}

/** The injected status→tone capability map (L090). Keyed on the RAW status string.
 *  Absent key → the caller's supplied fallback. This is the ONLY place status
 *  identity is resolved; adding a status is a new entry here (DATA), not code. */
export type StatusToneMap = Readonly<Record<string, StatusTone>>;

/** The neutral tone used when a status key is absent from the injected map, or
 *  when the record carries no status at all. Grey, honest, never fabricated. */
export const NEUTRAL_TONE: StatusTone = { color: 'var(--text-tertiary, #8a8a8a)', label: 'Unknown' };

/** The compact display model the AgentCard renders — everything derived, nothing raw. */
export interface AgentCardModel {
  readonly agentId: string;
  /** `label || id` — what the human reads as the card title. */
  readonly title: string;
  /** The resolved status tone (color + label), from the injected map or neutral. */
  readonly tone: StatusTone;
  /** The raw status key (for data-attributes / test assertions); undefined if none. */
  readonly statusKey?: string;
  /** First model ref, if any — the model the agent runs on (e.g. "gpt-5.5"). */
  readonly model?: string;
  /** Department/role for the cluster label; undefined if the record carries none. */
  readonly department?: string;
  /** A relative "last active" phrase ("just now", "3m ago", "2h ago"), or undefined. */
  readonly lastActive?: string;
}

/**
 * Strip a leading address-namespace prefix from a model ref so the card shows the
 * model's own name, never the internal reference vocabulary (L114/L118 — product
 * UI speaks the user's domain, not the runtime's addressing). A model ref is an
 * address of the form `<namespace>:<id>` (e.g. `ai-model-descriptor:claude-sonnet-4-6`);
 * the `ai-model-descriptor:` (or any `word-word:`) prefix is internal addressing, so
 * we drop it and keep the id the user actually recognizes (`claude-sonnet-4-6`).
 * GENERIC (L090/enum-dissolution): it strips ANY namespace by shape, never enumerates
 * model ids into a closed name map — a new model needs zero code here. Idempotent;
 * a bare id (no namespace) passes through unchanged.
 */
export function displayModelName(ref: string): string {
  const stripped = ref.replace(/^[a-z0-9]+(?:-[a-z0-9]+)*:/i, '');
  return stripped.length > 0 ? stripped : ref;
}

/** Humanize a millisecond age into a compact relative phrase. Pure, bounded. */
function relativeAge(deltaMs: number): string {
  if (deltaMs < 0) return 'just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Fold one live profile into its card model. `tones` is the injected status→tone
 * DATA map (L090); `fallback` is used for an unknown/absent status; `nowMs` is
 * supplied by the caller (no ambient clock — keeps this deterministic + testable).
 */
export function foldAgentCard(
  profile: AgentProfile,
  tones: StatusToneMap = {},
  fallback: StatusTone = NEUTRAL_TONE,
  nowMs?: number,
): AgentCardModel {
  const statusKey = profile.status;
  const tone = (statusKey && tones[statusKey]) || fallback;
  const model = profile.model_refs.length > 0 ? displayModelName(profile.model_refs[0]) : undefined;
  const department = profile.department ?? profile.role;
  const lastActive =
    typeof nowMs === 'number' && typeof profile.updated_at_ms === 'number'
      ? relativeAge(nowMs - profile.updated_at_ms)
      : undefined;
  return {
    agentId: profile.id,
    title: profile.label ?? profile.id,
    tone,
    ...(statusKey ? { statusKey } : {}),
    ...(model ? { model } : {}),
    ...(department ? { department } : {}),
    ...(lastActive ? { lastActive } : {}),
  };
}

/**
 * Resolve the department a board item should cluster under — the raw `groupKey`
 * string `arrangeByFieldWithRegions` clusters by (blind, never enumerated). The
 * feed→board-item bridge writes THIS onto each item's presentation. Absent → a
 * stable "Unassigned" bucket so every agent lands somewhere (never dropped).
 */
export function agentDepartmentKey(profile: AgentProfile): string {
  return profile.department ?? profile.role ?? 'Unassigned';
}
