// bitfield/packages/ui/show/status-vocabulary/StatusVocabulary.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE one place raw status strings become human words, tones, and terminality
// flags. Every package that renders run/publish/job states reads this
// vocabulary instead of printing raw state enums, so a raw machine state can
// never appear as visible copy.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure data + pure function — no React, no I/O, no package vocabulary
// 2. Unknown states never throw: they de-hyphenate/de-underscore into neutral
//    readable words so a new backend state cannot crash a screen or leak enums
// 3. Packages may pass an override map (their own data) — the base mapping is
//    a generic floor, never a closed list
// 4. Output shape is stable: { label, tone, isTerminal, isError }
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** Semantic tone — maps onto Badge/Text variant names used across ui/. */
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** The humanized view of one raw status string. */
export interface StatusView {
  /** Human words — never the raw enum. */
  label: string;
  /** Semantic tone for Badge/Text color selection. */
  tone: StatusTone;
  /** True when the state will not change again without new user action. */
  isTerminal: boolean;
  /** True when the state means the user must intervene. */
  isError: boolean;
}

/** Per-package override map: raw state -> full or partial view. */
export type StatusOverrides = Record<string, Partial<StatusView>>;

/**
 * The generic base vocabulary. Keys are lowercase raw states observed across
 * package record contracts. Packages extend via overrides, never by editing
 * call sites.
 */
const BASE_VOCABULARY: Record<string, StatusView> = {
  submitted:  { label: 'Waiting to start', tone: 'neutral', isTerminal: false, isError: false },
  pending:    { label: 'Waiting to start', tone: 'neutral', isTerminal: false, isError: false },
  queued:     { label: 'Waiting to start', tone: 'neutral', isTerminal: false, isError: false },
  running:    { label: 'Making it',        tone: 'info',    isTerminal: false, isError: false },
  processing: { label: 'Making it',        tone: 'info',    isTerminal: false, isError: false },
  validated:  { label: 'Checked and ready', tone: 'info',   isTerminal: false, isError: false },
  scheduled:  { label: 'Scheduled',        tone: 'info',    isTerminal: true,  isError: false },
  completed:  { label: 'Done',             tone: 'success', isTerminal: true,  isError: false },
  done:       { label: 'Done',             tone: 'success', isTerminal: true,  isError: false },
  published:  { label: 'Published',        tone: 'success', isTerminal: true,  isError: false },
  failed:     { label: 'Needs attention',  tone: 'error',   isTerminal: true,  isError: true },
  error:      { label: 'Needs attention',  tone: 'error',   isTerminal: true,  isError: true },
  cancelled:  { label: 'Stopped',          tone: 'warning', isTerminal: true,  isError: false },
  timeout:    { label: 'Took too long',    tone: 'error',   isTerminal: true,  isError: true },
};

/**
 * Humanize one raw status string.
 *
 * Lookup order: overrides (exact, lowercase) -> base vocabulary -> generic
 * fallback that de-hyphenates/de-underscores and sentence-cases the words
 * with neutral tone. The fallback guarantees a new raw state still renders
 * as readable words.
 */
export function statusView(rawState: string | null | undefined, overrides?: StatusOverrides): StatusView {
  const key = (rawState ?? '').trim().toLowerCase();
  if (key.length === 0) {
    return { label: 'Not started', tone: 'neutral', isTerminal: false, isError: false };
  }
  const base = BASE_VOCABULARY[key];
  const override = overrides?.[key];
  if (base || override) {
    return { ...(base ?? { label: humanizeRaw(key), tone: 'neutral', isTerminal: false, isError: false }), ...override };
  }
  return { label: humanizeRaw(key), tone: 'neutral', isTerminal: false, isError: false };
}

/** De-hyphenate/de-underscore and sentence-case a raw word. */
function humanizeRaw(raw: string): string {
  const words = raw.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
