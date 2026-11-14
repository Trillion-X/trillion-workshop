// packages/ui/show/persistence-status/PersistenceStatus.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The quiet, generic persistence/sync status indicator: a tiny dot (or spinner
// when in-flight) plus a terse label, in a semantic tone. Every authoring or
// editing surface needs "am I saved?" feedback, so this lives in shared `ui`
// (L088) rather than being duplicated per package.
//
// It is BLIND to any domain: it renders the {tone, label, detail, busy}
// descriptor it is handed. The WORDS ("Saving…", "Saved", "Couldn't save",
// "Update available") are Society supplied by the consumer — this primitive
// never enumerates persistence states, only the closed visual-semantics tone
// set (neutral/success/warning/error), which is Physics of emphasis, not domain.
//
// Reference anatomy (Mobbin MCP 2026-06-20, web): Confluence / Substack / Remote
// / Medium / Hashnode editors all surface save state as a small dot/cloud-icon +
// a terse word in the header — ambient, never a banner. See CS-065 reference
// contract § "Persistence / Save Status".
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / blind: no domain vocabulary, no closed persistence-state enum.
//    Tone is the only closed set (visual severity), the label is free Society.
// 2. Token-only color: dots use `bg-status-*` / `--text-muted`; the label uses
//    Text's semantic `color`. Zero hardcoded hex.
// 3. Quiet by construction: caption type, 1.5px gap, 6px dot — it informs, it
//    never shouts. The consumer renders nothing while idle.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import * as React from 'react';

import { cn } from '../cn';
import { Spinner } from '../spinner';
import { Text } from '../text';

export type PersistenceTone = 'neutral' | 'success' | 'warning' | 'error';

const DOT_BG: Record<PersistenceTone, string> = {
  neutral: 'bg-[var(--text-muted)]',
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
};

const LABEL_COLOR: Record<PersistenceTone, 'muted' | 'success' | 'warning' | 'error'> = {
  neutral: 'muted',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

export type PersistenceStatusProps = {
  /** The terse, user-language status word (Society) — e.g. "Saving…", "Saved". */
  label: string;
  /** Visual severity (Physics). Defaults to neutral. */
  tone?: PersistenceTone;
  /** Optional secondary text (e.g. a relative time or an error reason). */
  detail?: string;
  /** In-flight: shows a spinner instead of the dot (tone still colors the label). */
  busy?: boolean;
  className?: string;
};

export function PersistenceStatus({
  label,
  tone = 'neutral',
  detail,
  busy = false,
  className,
}: PersistenceStatusProps) {
  return (
    <span
      data-persistence-status
      role="status"
      aria-live="polite"
      className={cn('inline-flex items-center gap-1.5', className)}
    >
      {busy ? (
        <Spinner size="sm" />
      ) : (
        <span data-persistence-dot={tone} aria-hidden className={cn('h-1.5 w-1.5 rounded-full', DOT_BG[tone])} />
      )}
      <Text variant="caption" color={LABEL_COLOR[tone]}>
        {label}
      </Text>
      {detail ? (
        <Text variant="caption" color="faint">
          {detail}
        </Text>
      ) : null}
    </span>
  );
}
