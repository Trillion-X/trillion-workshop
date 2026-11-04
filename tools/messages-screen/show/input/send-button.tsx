// PORTED FROM: bitfield-packages/packages/chat/show/input/send-button.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/input/send-button.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Send/Stop toggle button for the chat composer. Shows ArrowUp (send) when idle,
// Square (stop) when streaming. Primary variant for send, danger for stop.
// Includes an accessible keyboard hint tooltip via native title attribute.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Two distinct states: send (ArrowUp, primary) and stop (Square, danger)
// 2. Send is disabled when content is empty or the input is globally disabled
// 3. Stop is always enabled while streaming so the user can cancel
// 4. All styling through AICC Button and Icon components — zero raw HTML
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button, Icon } from '../../../ui';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface SendButtonProps {
  /** Whether a response is currently streaming */
  isStreaming: boolean;
  /** Disable the send button (e.g. empty input). Stop button is never disabled. */
  disabled: boolean;
  /** Called when the user clicks send */
  onSend: () => void;
  /** Called when the user clicks stop */
  onStop: () => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function SendButton({ isStreaming, disabled, onSend, onStop }: SendButtonProps) {
  if (isStreaming) {
    return (
      <Button
        variant="secondary"
        size="icon"
        onClick={onStop}
        aria-label="Stop response"
        title="Stop response"
      >
        <Icon icon={Square} size="sm" />
      </Button>
    );
  }

  return (
    <Button
      variant={disabled ? 'ghost' : 'primary'}
      size="icon"
      onClick={onSend}
      disabled={disabled}
      aria-label="Send message"
      title="Enter to send, Shift+Enter for newline"
      data-reach-action="send-message"
    >
      <Icon icon={ArrowUp} size="sm" />
    </Button>
  );
}
