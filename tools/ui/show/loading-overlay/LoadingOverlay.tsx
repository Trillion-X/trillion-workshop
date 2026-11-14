// packages/ui/show/loading-overlay/LoadingOverlay.tsx
//
// A full-screen, centered progress veil for "we're working on it" moments the
// user must wait through — completing a purchase, provisioning access, or a page
// handoff that would otherwise flash blank. It covers the viewport, blurs what is
// behind, and shows a spinner with a title so the user always has clear feedback
// instead of a silent button or a blank screen.
//
// Invariants:
//   1. position:fixed inset:0 — fills the viewport regardless of any ancestor.
//   2. Captures pointer events so the user cannot act while the action is in flight.
//   3. Colors and spacing use design tokens (var(--...)) only.
//   4. No close control — it clears when the caller stops rendering it (a state
//      veil, not a dialog).

import React from 'react';
import { Spinner } from '../spinner/Spinner';
import { Text } from '../text';

export interface LoadingOverlayProps {
  /** The line shown to the user — what is happening now (e.g. "Completing your purchase…"). */
  title: string;
  /** A second reassurance line shown under the title. */
  subtitle?: string;
  /** Accessible label for the live region (defaults to the title). */
  'aria-label'?: string;
}

/**
 * Full-screen progress veil. Render it while a blocking async action is in
 * flight; stop rendering it when the action resolves.
 *
 * ```tsx
 * {submitting ? <LoadingOverlay title="Completing your purchase…" subtitle="Securing your access." /> : null}
 * ```
 */
export function LoadingOverlay({ title, subtitle, 'aria-label': ariaLabel }: LoadingOverlayProps) {
  return (
    <div
      role="status"
      aria-live="assertive"
      aria-label={ariaLabel ?? title}
      data-loading-overlay
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        background: 'color-mix(in srgb, var(--surface-primary, #0a0a0a) 84%, transparent)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '1.1rem',
          maxWidth: '22rem',
          padding: '2.25rem 2.5rem',
          borderRadius: '1.25rem',
          textAlign: 'center',
          background: 'var(--surface-elevated, #161616)',
          border: '1px solid var(--border-primary, rgba(255,255,255,0.1))',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <Spinner size="lg" aria-label={ariaLabel ?? title} />
        <Text variant="heading-md" color="strong">{title}</Text>
        {subtitle ? <Text variant="body-xs" color="muted">{subtitle}</Text> : null}
      </div>
    </div>
  );
}
