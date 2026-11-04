// PORTED FROM: bitfield-packages/packages/chat/show/participant-badge-color.ts @ e99ac5976
// packages/chat/show/participant-badge-color.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Conversation-history display helper for participant badge colors.
// This is browser-local presentation code, not a central shared bucket.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Participant colors come from participant records, not TypeScript branches
// 2. Returns a CSS color value suitable for `style={{ color: ... }}`
// 3. Unknown/unconfigured participants get neutral white/40 fallback
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

const DEFAULT_PARTICIPANT_BADGE_COLOR = 'rgba(255, 255, 255, 0.40)';

export function participantBadgeColor(_participantRef: string, configuredColor?: string | null): string {
  const trimmed = typeof configuredColor === 'string' ? configuredColor.trim() : '';
  return trimmed || DEFAULT_PARTICIPANT_BADGE_COLOR;
}
