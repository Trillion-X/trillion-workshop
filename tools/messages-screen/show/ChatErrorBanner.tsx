// PORTED FROM: bitfield-packages/packages/chat/show/ChatErrorBanner.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/ChatErrorBanner.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Dismissible error banner displayed below chat input when a chat:error event
// is received from the server. Shows error message in glassmorphism style with
// red accent border. Includes dismiss button to clear the error from store.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Glassmorphism styling: glass-surface border border-red-500/20 text-red-400
// 2. Dismissible via X button that calls onDismiss callback
// 3. Owner diagnostics are reduced to plain task language before rendering
// 4. Uses Button (variant="ghost", size="icon") and Icon (name="X") from ui
// 5. Accessible: proper button semantics, aria-label on dismiss
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { X } from 'lucide-react';
import { Button, Icon } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ChatErrorBannerProps {
  /** Error message text to display */
  error: string;
  /** Callback when user dismisses the error */
  onDismiss: () => void;
  /** Replays the exact retained intent when the failing seam is retryable. */
  onRetry?: () => void;
}

const INTERNAL_DIAGNOSTIC = /(?:\b(?:payload|receipt|projection|workflow|dispatcher|dispatch|producer|seam|authority|cryptographic|envelope|transport|binding|capability|adapter|owner|cursor|sequence|scope|native|jscore|react|webkit|atom|hash|multihash)\b|(?:package|action|proof|slot)::?|\b1f:[0-9a-f]{16,}|\b[a-z][a-z0-9_-]+:[a-z0-9:_-]+\b|\b(?:fe|e)_[a-z0-9_]+\b)/i;

export function plainChatError(error: string): string {
  const message = error.trim();
  if (!message || INTERNAL_DIAGNOSTIC.test(message)) return 'Something went wrong. Try again.';
  return message;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ChatErrorBanner({ error, onDismiss, onRetry }: ChatErrorBannerProps) {
  const visibleError = plainChatError(error);
  return (
    <div role="alert" aria-live="assertive" className="flex items-center gap-2 px-3 py-2 text-xs rounded-lg glass-surface border border-red-500/20 text-red-400">
      {/* Error message */}
      <span className="flex-1 truncate">{visibleError}</span>

      {onRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>
      ) : null}

      {/* Dismiss button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="shrink-0"
      >
        <Icon icon={X} size="sm" />
      </Button>
    </div>
  );
}
