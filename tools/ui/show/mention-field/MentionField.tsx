// parts/ui/show/mention-field/MentionField.tsx
//
// PURPOSE
//   The words part of every message box: plain writing with the browser's own spelling help, where typing
//   `@` offers anything the person can mention (people, AIs, spaces, files, every kind of record they keep) in the
//   shared picker (../mention-picker), and choosing one drops it in as a coloured chip. The value is plain text with each chip kept as a token of the documents part
//   (parts/documents/read-data: the token model, the chip DOM and the key decision are that part's, ported from the
//   documents package), so a caller stores and sends it as a string and reads the mentions back with `refsIn`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The candidates and what each kind looks like (label, icon, colour) are the caller's DATA; nothing
//      here names a kind.
//   2. The field is a plain-text editable (contentEditable "plaintext-only"): pasted formatting never
//      enters, Shift+Enter is a new line, Enter sends (composer-key-action.ts).
//   3. The DOM is the editing surface and `value` the truth: a value that differs from what the field holds
//      (cleared after sending, a suggestion chosen) is drawn in; typing reports the new value.
//   4. Spelling correction stays on: spellcheck, autocorrect and sentence capitals.

import React from 'react';

import { Container } from '../container';
import { MentionPicker, pickMentions } from '../mention-picker';
import { composerKeyAction } from '../../../documents/read-data/composer-key-action.ts';
import { makeRefChip, readBlockText, renderBlockRuns } from '../../../documents/read-data/inline-chip-dom.ts';

// A message box keeps words as written: no inline marks are drawn from them.
const NO_MARKS = [] as const;

/** Something the person can mention: a DATA kind, the thing's own id, and its name. */
export type MentionCandidate = { kind: string; value: string; label: string; detail?: string };
/** How a kind of mention looks, from the caller's DATA. `colour` is a screen-look colour id. */
export type MentionKind = { label: string; icon: string; colour: string };

export interface MentionFieldProps {
  value: string;
  onValueChange: (next: string) => void;
  onSubmit: () => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  candidates?: readonly MentionCandidate[];
  kinds?: Readonly<Record<string, MentionKind>>;
  /** The picker's accessible name. */
  pickerLabel?: string;
  /** Hears the words typed after `@` (null when the picker closes), for a caller that searches as they are typed. */
  onQuery?: (query: string | null) => void;
}

type Opened = { node: Text; start: number; end: number; query: string };
const QUERY = /(^|\s)@([^\s@]{0,40})$/;

export const MentionField = React.forwardRef<HTMLDivElement, MentionFieldProps>(function MentionField({
  value, onValueChange, onSubmit, ariaLabel, placeholder = '', disabled = false, candidates = [], kinds = {}, pickerLabel = 'Mention', onQuery,
}, forwarded) {
  const field = React.useRef<HTMLDivElement | null>(null);
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const [highlighted, setHighlighted] = React.useState(0);
  // The one kind the picker shows (null: every kind); a picker opened again starts on every kind.
  const [kind, setKind] = React.useState<string | null>(null);
  const pickerId = React.useId();
  const colourOf = React.useCallback((kind: string) => kinds[kind]?.colour, [kinds]);

  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    field.current = node;
    if (typeof forwarded === 'function') forwarded(node);
    else if (forwarded) forwarded.current = node;
  }, [forwarded]);

  // The value is drawn in whenever the field holds something else (cleared after a send, set by a caller).
  React.useLayoutEffect(() => {
    const el = field.current;
    if (el && readBlockText(el, NO_MARKS) !== value) renderBlockRuns(el, value, NO_MARKS, colourOf);
  }, [value, colourOf]);

  const query = opened?.query ?? null;
  React.useEffect(() => { onQuery?.(query); }, [query, onQuery]);
  React.useEffect(() => { if (query === null) setKind(null); }, [query]);
  const matches = React.useMemo(() => (query === null ? [] : pickMentions(candidates, kinds, query, kind)), [query, candidates, kinds, kind]);

  const findQuery = React.useCallback(() => {
    const el = field.current;
    const selection = el?.ownerDocument.defaultView?.getSelection();
    const node = selection?.anchorNode;
    if (!el || (!candidates.length && !onQuery) || !selection?.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || node.parentNode !== el) { setOpened(null); return; }
    const text = node as Text;
    const found = QUERY.exec(text.data.slice(0, selection.anchorOffset));
    setOpened(found ? { node: text, start: selection.anchorOffset - found[2].length - 1, end: selection.anchorOffset, query: found[2] } : null);
    setHighlighted(0);
  }, [candidates.length, onQuery]);

  const report = React.useCallback(() => {
    const el = field.current;
    if (el) onValueChange(readBlockText(el, NO_MARKS));
  }, [onValueChange]);

  const choose = React.useCallback((candidate: MentionCandidate) => {
    const el = field.current;
    if (!el || !opened || !opened.node.isConnected || opened.node.data.slice(opened.start, opened.start + 1) !== '@') { setOpened(null); return; }
    const doc = el.ownerDocument;
    const range = doc.createRange();
    range.setStart(opened.node, opened.start);
    range.setEnd(opened.node, Math.min(opened.end, opened.node.length));
    range.deleteContents();
    const after = doc.createTextNode(' ');
    range.insertNode(after);
    range.insertNode(makeRefChip({ kind: candidate.kind, value: candidate.value, label: candidate.label }, colourOf(candidate.kind), doc));
    const caret = doc.createRange();
    caret.setStart(after, 1);
    caret.collapse(true);
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    setOpened(null);
    el.focus();
    report();
  }, [opened, colourOf, report]);

  const open = Boolean(opened && matches.length);
  return (
    <Container width="full" className="mention-field-root">
      <div
        ref={setRef}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        contentEditable={disabled ? 'false' : 'plaintext-only'}
        suppressContentEditableWarning
        spellCheck
        autoCorrect="on"
        autoCapitalize="sentences"
        tabIndex={disabled ? -1 : 0}
        data-placeholder={placeholder}
        data-empty={value ? undefined : 'true'}
        className="mention-field"
        onInput={() => { report(); findQuery(); }}
        onClick={findQuery}
        onKeyUp={event => { if (event.key.startsWith('Arrow') && !open) findQuery(); }}
        onBlur={() => setOpened(null)}
        onKeyDown={event => {
          // An input method composing a character keeps Enter for itself.
          if (event.nativeEvent.isComposing) return;
          const intent = composerKeyAction({ key: event.key, shiftKey: event.shiftKey, isEmpty: !value, overlayOpen: open });
          if (intent === 'defer') {
            event.preventDefault();
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setHighlighted(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
            else if (event.key === 'Escape') setOpened(null);
            else choose(matches[highlighted] ?? matches[0]);
          } else if (intent === 'submit') {
            event.preventDefault();
            onSubmit();
          } else if (intent === 'dismiss') setOpened(null);
        }}
      />
      {open && opened ? (
        <Container className="mention-field-picker">
          <MentionPicker id={pickerId} candidates={candidates} kinds={kinds} query={opened.query} kind={kind}
            onKindChange={next => { setKind(next); setHighlighted(0); }} highlighted={highlighted} onHighlight={setHighlighted}
            onChoose={choose} label={pickerLabel} />
        </Container>
      ) : null}
    </Container>
  );
});

MentionField.displayName = 'MentionField';
