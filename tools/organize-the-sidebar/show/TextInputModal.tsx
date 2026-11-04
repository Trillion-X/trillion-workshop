// packages/group/show/TextInputModal.tsx
//
// The board's IN-APP text input — the generic replacement for window.prompt, which
// does NOT work in every shell (the macOS WKWebView presenter has no JS text-input
// panel, so window.prompt silently returns null and every text-driven tool dies). This
// renders a real ui/ Modal + Textarea, so a user instruction, a link URL, a paste, a
// board name, or a rename all work in ANY shell (L089 — one code path, environment is
// not a code branch). One placeable panel serves every "ask the user for text" need (L063).
//
// L065: visuals via ui/ components only. The board owns the request state and resolves
// the promise; this component is the blind presenter of one pending request.

import React, { useEffect, useState } from 'react';
import { Button, Container, Textarea } from '../../ui';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

export interface TextInputRequest {
  /** Label shown as the panel title + textarea placeholder. */
  readonly label: string;
  /** Pre-filled value (e.g. the current name for a rename). */
  readonly value?: string;
  /** Confirm button label — defaults to "Add". */
  readonly submitLabel?: string;
  /** Resolves the awaiting caller: the entered text, or null on cancel. */
  readonly resolve: (value: string | null) => void;
}

export function TextInputModal({ request }: { request: TextInputRequest | null }) {
  const [text, setText] = useState('');
  // Re-seed whenever a NEW request opens (identity changes), so a rename pre-fills.
  useEffect(() => {
    setText(request?.value ?? '');
  }, [request]);

  if (!request) return null;
  const submit = () => request.resolve(text);
  const cancel = () => request.resolve(null);

  return (
    <FloatingPanel open onClose={cancel} title={request.label} width={448}>
      <Container layout="vertical" gap="md">
        <Textarea
          autoFocus
          autoGrow
          rows={1}
          value={text}
          placeholder={request.label}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Plain Enter submits (single-line feel); Shift+Enter inserts a newline
            // (multi-line paste, e.g. "one line → one note"). Escape is handled by FloatingPanel.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Container layout="horizontal" gap="sm" justifyContent="end" alignItems="center">
          <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit}>{request.submitLabel ?? 'Add'}</Button>
        </Container>
      </Container>
    </FloatingPanel>
  );
}
