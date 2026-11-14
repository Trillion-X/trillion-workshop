// packages/ui/show/notice/Notice.tsx
//
// =============================================================================
// PURPOSE — a transient, non-interactive status chip ("Copied to clipboard",
// "Exported as SVG", "Could not save") pinned to an edge of its container.
// =============================================================================
//
// The universal "tell the user a fire-and-forget action just happened" overlay
// (L088 — shared UI bedrock). Unlike the full toast stack (`ui/show/toast`), this
// needs NO ToastProvider ancestor — it is a self-contained blind chip a surface
// can drop in and drive from its own ephemeral state + timer, so it works in
// every shell (WKWebView / web / studio) exactly like an in-panel overlay.
//
// BLIND (L090): given `text` + `tone` + `placement`, it renders a glass pill.
// It knows nothing about WHAT happened — the caller owns the message and the
// dismiss timing. `null`/'' text → renders nothing (absent-→-no-op).
//
// Lives in `ui` because it owns raw layout + design-token styling; feature
// packages render `<Notice .../>` and never touch raw HTML (L065).
// =============================================================================

import React from 'react';
import { Text } from '../text/Text';

export type NoticeTone = 'info' | 'success' | 'error';
export type NoticePlacement = 'top-center' | 'bottom-center';

export interface NoticeProps {
  /** The message, or null/'' for no notice. */
  text: string | null;
  /** Dot colour intent. Default 'info'. */
  tone?: NoticeTone;
  /** Which edge of the (position:relative) container to pin to. Default 'top-center'. */
  placement?: NoticePlacement;
  /** Trailing follow-up control ("Undo", "View", "Retry" — caller-owned label and
   *  behavior; the chip stays blind to WHAT it does). Present → the chip becomes
   *  interactive for that one control (pointer events scoped to the button only —
   *  the rest of the pill still lets clicks pass through). Absent → the classic
   *  non-interactive status chip, byte-identical behavior. */
  action?: { readonly label: string; readonly onAction: () => void };
}

const TONE_DOT: Record<NoticeTone, string> = {
  info: 'var(--text-secondary)',
  success: 'var(--accent-green, #22c55e)',
  error: 'var(--accent-red, #ef4444)',
};

function placementStyle(placement: NoticePlacement): React.CSSProperties {
  const base: React.CSSProperties = { left: '50%', transform: 'translateX(-50%)' };
  return placement === 'bottom-center' ? { ...base, bottom: 12 } : { ...base, top: 12 };
}

export function Notice({ text, tone = 'info', placement = 'top-center', action }: NoticeProps) {
  if (!text) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        zIndex: 60,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        borderRadius: 9999,
        background: 'var(--glass-bg-active, rgba(20,20,20,0.88))',
        border: '1px solid var(--border-primary)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
        ...placementStyle(placement),
      }}
    >
      <span
        aria-hidden
        style={{ width: 7, height: 7, borderRadius: 9999, background: TONE_DOT[tone], flexShrink: 0 }}
      />
      <Text variant="body-xs" as="span">
        {text}
      </Text>
      {action ? (
        <button
          type="button"
          onClick={action.onAction}
          style={{
            // pointer events re-enabled ONLY on the control — the pill stays pass-through
            pointerEvents: 'auto',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--text-primary)',
            font: 'inherit',
            fontSize: 12,
            fontWeight: 600,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

Notice.displayName = 'Notice';
