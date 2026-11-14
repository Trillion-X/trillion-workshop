// packages/file-editor/show/AskAiToEditSelectedFileText.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Floating popover component for inline AI editing via Cmd+K. Renders above
// a CodeMirror selection, shows a preview of selected text, captures edit
// description from user, and dispatches to chat with full context (file path,
// line numbers, selected text). Positioned absolutely near the selection.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Similar to ChatInput — uses raw textarea for complex input widget
// 2. Positioned via absolute positioning with top/left from props (Physics level)
// 3. Selected text preview truncated to ~3 lines with ellipsis if longer
// 4. Textarea auto-focused on mount for immediate user input
// 5. Enter key submits, Escape key cancels
// 6. Send button disabled while empty (whitespace ignored)
// 7. Escape and clickaway (via onCancel) can dismiss
// 8. All glassmorphism styling via Card variant="glass"
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - position: { top, left } from CodeMirror coords for popover placement
// - selectedText: preview of what user has selected (context)
// - filePath: shown to user so they know which file is being edited
// - lineRange: { start, end } shown as (line X-Y) in context
// - onSubmit: called with (description) — parent sends to chat
// - onCancel: called to dismiss popover
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Card, Container, Button, Text } from '../../ui/index.ts';

/**
 * Props for AskAiToEditSelectedFileText popover
 */
export interface AskAiToEditSelectedFileTextProps {
  /** Position for the popover (pixel coordinates from CodeMirror) */
  position: { top: number; left: number };

  /** The currently selected text (shown as context) */
  selectedText: string;

  /** File path for context display */
  filePath: string;

  /** Line range for context (e.g., "42-56") */
  lineRange?: { start: number; end: number };

  /** Callback when user submits an edit description */
  onSubmit: (description: string) => void;

  /** Callback when user cancels */
  onCancel: () => void;
}

/**
 * Truncate text to ~3 lines with ellipsis if longer
 */
function truncatePreview(text: string, maxLines: number = 3): string {
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + '...';
  }
  return text;
}

/**
 * AskAiToEditSelectedFileText: Floating popover for Cmd+K inline AI editing
 *
 * Renders a glassmorphic card with:
 * - File path + line range label
 * - Selected text preview (truncated)
 * - Textarea input for edit description
 * - Send and Cancel buttons
 * - Keyboard: Enter to send, Escape to cancel
 *
 * Positioned absolutely near CodeMirror selection. Uses raw textarea element
 * for input (same pattern as ChatInput) due to complexity of custom input widgets.
 */
export function AskAiToEditSelectedFileText({
  position,
  selectedText,
  filePath,
  lineRange,
  onSubmit,
  onCancel,
}: AskAiToEditSelectedFileTextProps) {
  const [description, setDescription] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Handle keyboard shortcuts: Enter to send, Escape to cancel
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (description.trim()) {
          onSubmit(description.trim());
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [description, onSubmit, onCancel],
  );

  // Dismiss on click outside (Escape key also works)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onCancel();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onCancel]);

  const canSend = description.trim().length > 0;
  const lineRangeLabel = lineRange
    ? ` (lines ${lineRange.start}-${lineRange.end})`
    : '';

  return (
    <div
      ref={containerRef}
      // L065: fixed positioning needed for popover placement relative to CodeMirror selection
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 1000,
      }}
    >
      <Card
        variant="glass"
        padding="md"
        // L065: Dynamic sizing and shadow for glassmorphic popover aesthetic
        style={{
          minWidth: '280px',
          maxWidth: '420px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
        }}
      >
        <Container layout="vertical" gap="sm">
          {/* Context label: file path + line range */}
          <Text variant="caption" color="muted">
            {filePath}
            {lineRangeLabel}
          </Text>

          {/* Selected text preview */}
          <Container
            layout="vertical"
            padding="sm"
            // L065: Custom glassmorphic styling and overflow constraint for preview container
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '4px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              maxHeight: '100px',
              overflow: 'auto',
            }}
          >
            <Text
              variant="body-xs"
              color="subtle"
              // L065: Pre-wrap formatting to preserve code/text indentation in preview
              style={{
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
              }}
            >
              {truncatePreview(selectedText, 3)}
            </Text>
          </Container>

          {/* Description input — native textarea (like ChatInput) */}
          <textarea
            ref={textareaRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the edit you want..."
            rows={2}
            className="w-full bg-transparent px-2 py-1.5 text-[var(--text-primary)]
              placeholder-white/30 text-sm resize-none rounded border border-[rgba(255,255,255,0.1)]
              focus:outline-none focus:border-[rgba(255,255,255,0.3)]"
          />

          {/* Action buttons */}
          <Container layout="horizontal" gap="sm" justifyContent="flex-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              variant="accent"
              size="sm"
              disabled={!canSend}
              onClick={() => {
                if (canSend) {
                  onSubmit(description.trim());
                }
              }}
            >
              Send to AI
            </Button>
          </Container>
        </Container>
      </Card>
    </div>
  );
}

export type { AskAiToEditSelectedFileTextProps };
