// packages/ui/show/inline-edit-text/InlineEditText.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Seamless in-place text editing (the Amie pattern): the text IS the input.
// No box, no border, no background — at rest and while editing the element
// renders with the exact typography of the matching Text variant; clicking
// simply places the caret. Commit on blur/Enter, revert on Escape.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Raw <input> is legal ONLY inside ui primitives. Feature code passes
//    value/onCommit and never touches the element.
// 2. The edit state must be visually identical to the rest state — if the
//    field "turns into an input that looks like an input", this primitive
//    has failed its one job.
// 3. Generic: no product vocabulary. Any package, any string.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

export type InlineEditTextVariant = 'heading-xl' | 'heading-lg' | 'heading' | 'body' | 'body-xs';

export type InlineEditTextProps = {
  /** Current committed value. */
  value: string;
  /** Called with the trimmed new value when it changes and is non-empty. */
  onCommit: (next: string) => void;
  /** Typography — mirrors the Text variant scale. */
  variant?: InlineEditTextVariant;
  /** Faint affordance shown when the value is empty. */
  placeholder?: string;
  /** Accessible label for the field. */
  'aria-label': string;
  /** Render the value in the secondary color (subtitle style). */
  tone?: 'primary' | 'secondary';
  /**
   * Multiline mode: renders an auto-growing seamless textarea. Enter inserts
   * a newline; commit happens on blur.
   */
  multiline?: boolean;
  /** Minimum visible rows for multiline mode. Auto-growth still expands past this. */
  minRows?: number;
  /**
   * Observe the in-progress draft on every keystroke (composer use: trailing
   * affordances react to "has content" before commit). Purely additive —
   * commit semantics are unchanged.
   */
  onDraftChange?: (draft: string) => void;
  /**
   * Controlled draft (token-composer use): when provided, the in-progress
   * text is owned by the parent — pair with onDraftChange. Lets a composer
   * REWRITE the draft (e.g. strip an accepted @-token) without remounting.
   */
  draft?: string;
};

// Typography mirrors packages/ui/show/text/Text.tsx variants exactly — the
// seamlessness depends on byte-identical type styling.
const VARIANT_CLASS: Record<InlineEditTextVariant, string> = {
  'heading-xl': 'text-2xl font-semibold',
  'heading-lg': 'text-lg font-semibold',
  'heading': 'text-sm font-medium',
  'body': 'text-sm',
  'body-xs': 'text-xs',
};

export const InlineEditText = React.forwardRef<HTMLInputElement | HTMLTextAreaElement, InlineEditTextProps>(
  function InlineEditText({
    value,
    onCommit,
    variant = 'body',
    placeholder,
    tone = 'primary',
    multiline = false,
    minRows = 1,
    onDraftChange,
    draft: controlledDraft,
    'aria-label': ariaLabel,
  }, ref) {
  const [ownDraft, setOwnDraft] = React.useState(value);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    setOwnDraft(value);
  }, [value]);
  const draft = controlledDraft ?? ownDraft;
  const setDraft = (next: string) => { if (controlledDraft === undefined) setOwnDraft(next); };
  React.useLayoutEffect(() => {
    if (!multiline) return;
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [draft, multiline]);

  const setTextareaRef = React.useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | HTMLInputElement | null>).current = node;
  }, [ref]);

  const commit = React.useCallback(() => {
    const next = draft.trim();
    if (next === value.trim()) return;
    if (!next && !placeholder) {
      setDraft(value);
      return;
    }
    onCommit(next);
  }, [draft, onCommit, placeholder, value]);

  const toneClass = tone === 'secondary'
    ? 'text-[var(--text-secondary)]'
    : 'text-[var(--text-primary)]';
  const seamlessClass = `w-full min-w-0 cursor-text resize-none border-none bg-transparent p-0 outline-none placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-0 ${VARIANT_CLASS[variant]} ${toneClass}`;

  if (multiline) {
    return (
      <textarea
        ref={setTextareaRef}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={Math.max(minRows, draft.split('\n').length)}
        onChange={(event) => { setDraft(event.target.value); onDraftChange?.(event.target.value); }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setDraft(value);
            (event.target as HTMLTextAreaElement).blur();
          }
        }}
        className={`${seamlessClass} overflow-hidden`}
      />
    );
  }

  return (
    <input
      ref={ref as React.Ref<HTMLInputElement>}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => { setDraft(event.target.value); onDraftChange?.(event.target.value); }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          setDraft(value);
          (event.target as HTMLInputElement).blur();
        }
      }}
      className={seamlessClass}
    />
  );
});
