// PORTED FROM: bitfield-packages/packages/chat/show/input/chat-composer.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/input/chat-composer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The active-conversation chat composer: the canonical ChatInput field +
// send/stop control, with a SlashCommandMenu overlaid on top. This component
// owns ONLY the slash-command concern — the field, auto-grow, preset/context
// chips, and send/stop all live in the shared ChatInput primitive, so there is
// a single composer implementation across the empty-state hero and the docked
// conversation view (no second field to drift out of sync).
//
// Slash command detection: "/" typed at column 0 opens SlashCommandMenu.
// Selected slash commands are expanded inline or executed as actions.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. onSend receives the trimmed content (enforced by ChatInput).
// 2. Enter submits; Shift+Enter inserts a newline (enforced by ChatInput).
// 3. prefillValue applied once then cleared via onPrefillConsumed.
// 4. activePreset shown as a dismissible row above the field (by ChatInput).
// 5. Slash trigger detected at column 0 only — mid-word "/" is not a command.
// 6. All styling through AICC ui/ components — zero raw markup in this file.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '../../../ui';
import { ChatInput, useChatDraft } from '../ChatInput';
import { SlashCommandMenu } from './slash-command-menu';
import type { InputMode } from '../IdeaModePill';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface ChatComposerProps {
  draftScope?: string;
  /** Told on each edit that adds or changes words, so a host can say the person is typing (never the words). */
  onTyping?: () => void;
  /** Called when the user sends a message */
  onSend: (content: string) => boolean | void | Promise<boolean | void>;
  /** Called when the user clicks stop during streaming */
  onStop?: () => void;
  /** Disable the entire composer (e.g. not connected) */
  disabled?: boolean;
  /** Whether a response is currently streaming */
  isStreaming?: boolean;
  /** Placeholder text for the field */
  placeholder?: string;
  /** Current input mode for mode-specific placeholder copy */
  inputMode?: InputMode;
  /** Footer content rendered on the left side of the action bar */
  footer?: React.ReactNode;
  /** External value to prefill into the field */
  prefillValue?: string;
  /** Called after prefill has been consumed (parent should clear prefillValue) */
  onPrefillConsumed?: () => void;
  /** Active preset badge shown above the field */
  activePreset?: { label: string; prompt: string; description?: string } | null;
  /** Called when the user dismisses the active preset */
  onPresetDismiss?: () => void;
  /** Read-only chip for context attached to the next message (selected text). */
  selectedContext?: { label: string; excerpt?: string } | null;
}

export function chatInputPlaceholderForMode(mode: InputMode): string {
  if (mode === 'ai-work') return 'Describe the outcome for AI work. The right packages will show owner, blockers, and proof.';
  if (mode === 'idea') return 'Write the idea you want saved to the current project.';
  return 'Type a message...';
}

// ---------------------------------------------------------------------------
// SLASH DETECTION HELPERS
// ---------------------------------------------------------------------------

/** Returns true if the cursor is at column 0 after a "/" character */
function isSlashTrigger(value: string, cursorPos: number): boolean {
  if (cursorPos === 0) return false;
  const textBefore = value.slice(0, cursorPos);
  const lineStart = textBefore.lastIndexOf('\n') + 1;
  return textBefore.slice(lineStart) === '/' || textBefore.slice(lineStart).startsWith('/');
}

/** Extracts the search text after the leading "/" on the current line */
function getSlashSearchText(value: string, cursorPos: number): string {
  const textBefore = value.slice(0, cursorPos);
  const lineStart = textBefore.lastIndexOf('\n') + 1;
  const lineContent = textBefore.slice(lineStart);
  return lineContent.startsWith('/') ? lineContent.slice(1) : '';
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ChatComposer({
  draftScope,
  onTyping,
  onSend,
  onStop,
  disabled = false,
  isStreaming = false,
  placeholder,
  inputMode = 'chat',
  footer,
  prefillValue,
  onPrefillConsumed,
  activePreset,
  onPresetDismiss,
  selectedContext,
}: ChatComposerProps) {
  // ChatComposer owns the text so it can drive slash detection over the value.
  const [value, setValue] = useChatDraft(draftScope);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashSearch, setSlashSearch] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Apply external prefill into the controlled value.
  useEffect(() => {
    if (prefillValue) {
      setValue(prefillValue);
      onPrefillConsumed?.();
      fieldRef.current?.focus();
    }
  }, [prefillValue, onPrefillConsumed]);

  const handleValueChange = useCallback((next: string) => {
    setValue(next);
    if (next) onTyping?.();
    // Slash detection: check if "/" is at the start of the current line.
    const pos = next.length;
    if (isSlashTrigger(next, pos)) {
      setSlashSearch(getSlashSearchText(next, pos));
      setSlashOpen(true);
    } else {
      setSlashOpen(false);
      setSlashSearch('');
    }
  }, [setValue, onTyping]);

  const handleSlashSelect = useCallback((command: string) => {
    // Replace the slash trigger with the command (without the slash), then close.
    if (command === '/clear') {
      setValue('');
    } else if (command === '/compact' || command === '/plan') {
      setValue(command + ' ');
    }
    setSlashOpen(false);
    setSlashSearch('');
    fieldRef.current?.focus();
  }, [setValue]);

  const resolvedPlaceholder = placeholder ?? chatInputPlaceholderForMode(inputMode);

  return (
    <Card variant="nested" padding="none">
      <SlashCommandMenu
        isOpen={slashOpen}
        onClose={() => setSlashOpen(false)}
        onSelect={handleSlashSelect}
        searchText={slashSearch}
        anchorRef={fieldRef as React.RefObject<HTMLElement | null>}
      />
      <ChatInput
        onSend={onSend}
        disabled={disabled}
        isStreaming={isStreaming}
        onStop={onStop}
        placeholder={resolvedPlaceholder}
        footer={footer}
        activePreset={activePreset}
        onPresetDismiss={onPresetDismiss}
        selectedContext={selectedContext}
        value={value}
        onValueChange={handleValueChange}
        fieldRef={fieldRef}
      />
    </Card>
  );
}
