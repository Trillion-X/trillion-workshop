// packages/notifications/read-data/setting-copy-table.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Single source of truth for the human-facing copy of a setting screen's
// runtime STATUS. The blind projection (project-setting-view.ts) reads this
// table to turn a machine status enum into the exact words and visual tone the
// renderer shows — the renderer never authors status sentences itself.
//
// This is a deliberate translation boundary (L098): the descriptor-parsing
// layer (read-notifications-policy.ts) owns the 4 logic states
// (empty/ready/dirty/invalid) for the generic settings list; THIS table owns
// the 9 presentation states a dedicated setting screen surfaces, including the
// runtime-only phases (loading/saving/saved/offline) that data alone cannot
// describe. Two callers, two translations — not two sources of one truth.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary. No mode keys, property ids, target names, or
//    payload words appear here — only generic setting-screen status copy.
// 2. Every SettingStatus has exactly one copy entry. Adding a status is a data
//    edit here, not a code branch in the renderer.
// 3. `tone` maps to a generic StatusDot/Badge variant family — never a color.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/**
 * The presentation status of a setting screen. A superset of the descriptor
 * logic status: it adds the runtime phases (loading/saving/saved/offline) that
 * exist only while a human is interacting with the screen.
 */
export type SettingStatus =
  | 'loading'
  | 'default'
  | 'ready'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error'
  | 'invalid'
  | 'offline';

/** Generic status tone — maps to StatusDot/Badge variants, never to a color. */
export type SettingTone = 'idle' | 'info' | 'success' | 'warning' | 'error' | 'accent';

export interface SettingCopyEntry {
  /** Plain sentence describing the current status, in the user's language. */
  statusCopy: string;
  /** Generic visual tone for the status dot / badge. */
  tone: SettingTone;
}

const COPY: Record<SettingStatus, SettingCopyEntry> = {
  loading: { statusCopy: 'Loading your current choice…', tone: 'idle' },
  default: { statusCopy: 'Active now', tone: 'success' },
  ready: { statusCopy: 'Active now', tone: 'success' },
  dirty: { statusCopy: 'Unsaved change', tone: 'warning' },
  saving: { statusCopy: 'Saving…', tone: 'info' },
  saved: { statusCopy: 'Saved', tone: 'success' },
  error: { statusCopy: 'That change did not save. Your choice is unchanged.', tone: 'error' },
  invalid: { statusCopy: 'Your saved choice is no longer offered. Pick one below.', tone: 'warning' },
  offline: { statusCopy: 'You are offline. Changes cannot be saved right now.', tone: 'warning' },
};

/** The label shown on the "current value" badge before any change is made. */
export const CURRENT_BADGE_LABEL = 'Active now';
/** The label of the confirm/save control. */
export const SAVE_LABEL = 'Save';
/** The label of the discard/revert control. */
export const REVERT_LABEL = 'Revert';
/** Reason shown when Save is disabled because nothing changed. */
export const SAVE_DISABLED_NO_CHANGE = 'Choose a different option to save.';
/** Reason shown when Save is disabled because the screen is offline. */
export const SAVE_DISABLED_OFFLINE = 'Reconnect to save your change.';
/** Reason shown when Save is disabled while a write is already in flight. */
export const SAVE_DISABLED_SAVING = 'Saving your previous change…';

/**
 * The ONLY place a status becomes words. Total over SettingStatus — a missing
 * status is a compile error, never a silent blank.
 */
export function settingCopy(status: SettingStatus): SettingCopyEntry {
  return COPY[status];
}
