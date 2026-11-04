import { matchBlockShortcut } from '../read-data/match-block-shortcut.ts';
// parts/documents/show/DocumentEditor.tsx
//
// PURPOSE
//   The shared writing surface: a block editor with its own model and caret, built from the editing code of the
//   documents package's DocumentsSurface (bitfield-packages/packages/documents/show/DocumentsSurface.tsx: EditableBlock,
//   its keydown contract, the spatial caret, block selection) with everything that touched the Bitfield runtime, the
//   log or the sidebar replaced by plain props. Each block is its own editable; shortcuts typed at a block's start
//   reshape it (`# ` heading, `- ` bullet, `1. ` numbered, `> ` quote, `---` then Enter a divider), Enter continues or
//   leaves a list, Backspace at a block's start joins it to the one above, arrows cross between blocks by where they
//   sit on screen, `@` opens the caller's mention picker, and Select all twice selects every block for the selection
//   keys (Backspace deletes them).
//
// NON-NEGOTIABLE INVARIANTS
//   1. `value` is the truth and `onChange` receives every change; the DOM is only where words are typed. A block's DOM
//      is redrawn only when what it holds differs from its value, so typing is never disturbed.
//   2. Every rule is DATA (read-data/editing-rules.json, plus the caller's `rows`); every change is a pure function in
//      read-data/document-value.ts. This file reads the DOM, asks those functions, and places the caret.
//   3. It sends nothing and knows no product: a caller supplies what Enter sends (`enterSends` + `onSubmit`), how a
//      mention is picked (`renderPicker`) and drawn (`renderChip`), and which pastes it keeps for itself (`claimPaste`).
//   4. Looks come from screen-look (parts/screen-look/show/document-editor.css) by each block's `look` id; no colour or
//      size is written here. Nothing is built from markup strings.

import React from 'react';
import { isTextCompositionKey, splitEditableSelection, trackTextComposition } from '../../ui/show/rich-text-editor/editing-selection';
import { createEditorHistory, type EditorHistory } from '../../ui/show/rich-text-editor/editing-history';
import { createPortal } from 'react-dom';

import { Container } from '../../ui/show/container';
import { resolveCursorCommand } from '../read-data/cursor-commands.ts';
import { candidatesInRect, resolveGoalColumn, resolveInDirection, type Candidate, type GoalRun } from '../read-data/cursor-nav.ts';
import {
  applyAutoformat,
  applySelectionOp,
  changeBlockIndent,
  MAX_INDENT_LEVEL,
  continueBlock,
  editingRulesWith,
  enterDecision,
  insertMention,
  isDocumentEmpty,
  joinWithPrevious,
  leaveBlockKind,
  mintBlockId,
  normalizeDocument,
  pasteMarkdown,
  setBlockText,
  splitBlock,
  type DocumentValue,
  type Edited,
  type Focus,
} from '../read-data/document-value.ts';
import { literalIndentEdit, literalLineBreak, matchAutoformat, matchInputShortcut, textInputPolicyFor, type SceneNode as DocumentNode } from '../read-data/documents.ts';
import { CHIP_CLASS, caretFlatOffset, isDrawnAs, placeCaretAtFlatOffset, readBlockText, readBlockSelection, restoreBlockSelection, renderBlockRuns, type ColourOf } from '../read-data/inline-chip-dom.ts';
import type { InlineMark, Ref } from '../read-data/inline-tokens.ts';
import { matchSelectionOp } from '../read-data/selection-ops.ts';
import { pastedMarkdown } from '../read-data/paste-sources.ts';

/** What the editor asks of a mention picker while `@` is being typed. */
export type MentionPickerRequest = {
  /** The words typed after `@`. */
  query: string;
  /** Put this mention in place of the `@` and its words. */
  choose: (ref: Ref) => void;
  /** Close without choosing. */
  close: () => void;
  /** While open the picker takes Arrow Up/Down, Enter, Tab and Escape: it registers a handler that answers true for a
   *  key it used (null to stop). */
  keys: (handler: ((key: string) => boolean) | null) => void;
};

export interface DocumentEditorProps {
  value: DocumentValue;
  onChange: (next: DocumentValue) => void;
  /** The box's accessible name (the first block carries it). */
  ariaLabel: string;
  /** Shown in the first block while nothing is written. */
  placeholder?: string;
  disabled?: boolean;
  /** The caller's own rule rows over the shipped ones (same shapes as editing-rules.json; a row with a shipped id
   *  replaces it). */
  rows?: readonly unknown[];
  /** A plain Enter sends (`onSubmit`); Shift+Enter then makes a new block. Without it, Enter makes a new block and
   *  Shift+Enter a line break inside one. In a list, Enter always continues or leaves the list. */
  enterSends?: boolean;
  onSubmit?: () => void;
  /** Escape outside a picker or a selection. */
  onEscape?: () => void;
  /** The picker drawn while `@` is typed (absent: `@` is only a character). */
  renderPicker?: (request: MentionPickerRequest) => React.ReactNode;
  /** How a mention is drawn inside the words (absent: its glyph and name). */
  renderChip?: (ref: Ref, colour: string | undefined) => React.ReactNode;
  /** The colour of a mention by its kind (a screen-look colour id). */
  colourOf?: ColourOf;
  /** A paste the caller keeps for itself (files, a link it turns into a card): the editor leaves it alone. */
  claimPaste?: (data: DataTransfer) => boolean;
  /** Label of each block after the first, given its position (1-based); the first block is named `ariaLabel`. */
  blockLabel?: (position: number) => string;
  /** Label of the selected-blocks region, for people using a screen reader. */
  selectionLabel?: (count: number) => string;
  /** A shortcut row whose DATA hands its words on (`dispatch`, e.g. `!! ` then words): the row's dispatch and the words. */
  onShortcutDispatch?: (dispatch: Record<string, unknown>, words: string) => void;
  /** A selection op whose DATA hands the selected blocks on (`effect.dispatch`): its target, payload and the ids. */
  onSelectionDispatch?: (target: string, payload: Record<string, unknown> & { selected: readonly string[] }) => void;
}

/** What a caller can do to the editor from outside. */
export type DocumentEditorHandle = {
  focus: () => void;
  /** Type `text` at the caret (the `@` button types an `@`, which opens the picker as typing one would). */
  insertText: (text: string) => void;
};

type Opened = { blockId: string; query: string; range?: { start: number; end: number } };
type CaretGeometry = { goalX: number; goalY: number; atTop: boolean; atBottom: boolean; atStart: boolean; atEnd: boolean };

const PICKER_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']);
const textOf = (node: DocumentNode) => (typeof node.props?.text === 'string' ? node.props.text : '');
const lookOf = (node: DocumentNode) => (typeof node.props?.look === 'string' ? node.props.look : undefined);

// The caret's screen position, and whether it sits on the block's first or last line and at its start or end: the
// four edges from which an arrow crosses into a neighbouring block.
function readCaretGeometry(el: HTMLElement): CaretGeometry | null {
  const view = el.ownerDocument.defaultView;
  const selection = view?.getSelection();
  if (!view || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const rects = range.getClientRects();
  const box = el.getBoundingClientRect();
  const caret = rects.length ? rects[0] : box;
  const lineHeight = caret.height || parseFloat(view.getComputedStyle(el).lineHeight || '20') || 20;
  const before = range.cloneRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(el);
  after.setStart(range.endContainer, range.endOffset);
  return {
    goalX: rects.length ? caret.left : box.left,
    goalY: caret.top,
    atTop: caret.top - box.top < lineHeight * 0.6 || !rects.length,
    atBottom: box.bottom - caret.bottom < lineHeight * 0.6 || !rects.length,
    atStart: before.toString().length === 0 && !before.cloneContents().querySelector(`.${CHIP_CLASS}`),
    atEnd: after.toString().length === 0 && !after.cloneContents().querySelector(`.${CHIP_CLASS}`),
  };
}

// The caret at screen x on the target block's top or bottom line (the goal column kept), or at its start or end, by
// the browser's own point-to-caret hit test.
function placeCaretAtEdge(el: HTMLElement, goalX: number, edge: 'top' | 'bottom' | 'start' | 'end', marks: readonly InlineMark[]): void {
  el.focus();
  if (edge === 'end') { placeCaretAtFlatOffset(el, Number.MAX_SAFE_INTEGER, marks); return; }
  if (edge === 'start') { placeCaretAtFlatOffset(el, 0, marks); return; }
  const doc = el.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const view = doc.defaultView;
  const box = el.getBoundingClientRect();
  const lineHeight = parseFloat(view?.getComputedStyle(el).lineHeight || '20') || 20;
  const x = Math.max(box.left + 2, Math.min(goalX, box.right - 2));
  const y = edge === 'top' ? box.top + Math.min(lineHeight / 2, box.height / 2) : box.bottom - Math.min(lineHeight / 2, box.height / 2);
  const selection = view?.getSelection();
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? doc.createRange() : doc.caretRangeFromPoint?.(x, y) ?? null;
  if (position && range) range.setStart(position.offsetNode, position.offset);
  if (!range || !selection || !el.contains(range.startContainer)) { placeCaretAtFlatOffset(el, edge === 'top' ? 0 : Number.MAX_SAFE_INTEGER, marks); return; }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// The whole of a block's words is selected (so a second Select all takes every block).
function wholeBlockSelected(el: HTMLElement): boolean {
  const selection = el.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return (el.textContent ?? '') === '';
  const range = selection.getRangeAt(0);
  const all = el.ownerDocument.createRange();
  all.selectNodeContents(el);
  return range.compareBoundaryPoints(Range.START_TO_START, all) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, all) >= 0;
}

type BlockProps = {
  node: DocumentNode;
  label: string;
  placeholder: string | undefined;
  marks: readonly InlineMark[];
  literal: boolean;
  colourOf: ColourOf | undefined;
  renderChip: DocumentEditorProps['renderChip'];
  disabled: boolean;
  selected: boolean;
  register: (id: string, el: HTMLElement | null) => void;
  onInput: (node: DocumentNode, el: HTMLElement, group?: string) => void;
  onKeyDown: (node: DocumentNode, event: React.KeyboardEvent<HTMLElement>) => void;
  onPaste: (node: DocumentNode, event: React.ClipboardEvent<HTMLElement>) => void;
  onFocus: () => void;
};

// One block. Words are an editable; anything else a rule made (a divider) is drawn by its look and stepped over.
function Block({ node, label, placeholder, marks, literal, colourOf, renderChip, disabled, selected, register, onInput, onKeyDown, onPaste, onFocus }: BlockProps) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [hosts, setHosts] = React.useState<HTMLElement[]>([]);
  const text = textOf(node);
  const indentLevel = Number.isInteger(node.props?.indent_level) ? Math.max(0, Math.min(MAX_INDENT_LEVEL, Number(node.props?.indent_level))) : 0;
  const words = node.kind === 'Text';
  const setRef = React.useCallback((el: HTMLElement | null) => { ref.current = el; register(node.id, el); }, [node.id, register]);
  React.useEffect(() => { if (ref.current && words) return trackTextComposition(ref.current); }, [words]);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !literal) return;
    const refuseFormat = (event: InputEvent) => { if (event.inputType.startsWith('format')) event.preventDefault(); };
    el.addEventListener('beforeinput', refuseFormat);
    return () => el.removeEventListener('beforeinput', refuseFormat);
  }, [literal]);

  const gatherHosts = React.useCallback(() => {
    const el = ref.current;
    if (!el || !renderChip) return;
    const found = Array.from(el.querySelectorAll<HTMLElement>(`.${CHIP_CLASS}`));
    for (const host of found) if (!host.dataset.drawnBy) { host.replaceChildren(); host.dataset.drawnBy = 'caller'; }
    setHosts(current => (current.length === found.length && current.every((host, index) => host === found[index]) ? current : found));
  }, [renderChip]);

  // The value is drawn in when the block holds something else (a shortcut applied, a mention chosen, a new value), and
  // once the caret is elsewhere, when words typed with their markers (`**balls**`) still show the markers.
  const draw = React.useCallback((caretHere: boolean) => {
    const el = ref.current;
    if (!el || !words) return;
    if (literal) {
      if (el.textContent !== text) el.textContent = text;
      gatherHosts();
      return;
    }
    if (readBlockText(el, marks) !== text || (!caretHere && !isDrawnAs(el, text, marks))) renderBlockRuns(el, text, marks, colourOf);
    gatherHosts();
  }, [text, marks, literal, colourOf, words, gatherHosts]);
  React.useLayoutEffect(() => { draw(ref.current !== null && ref.current.ownerDocument.activeElement === ref.current); }, [draw]);

  if (!words) {
    return <Container ref={setRef as React.Ref<HTMLDivElement>} role="separator" className="document-block" data-look={lookOf(node)} data-node-id={node.id} data-selected={selected || undefined} />;
  }
  return (
    <>
      <Container
        ref={setRef as React.Ref<HTMLDivElement>}
        layout="flow"
        gap="none"
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={!literal}
        autoCapitalize={literal ? 'off' : 'sentences'}
        autoCorrect={literal ? 'off' : 'on'}
        tabIndex={disabled ? -1 : 0}
        className="document-block"
        data-look={lookOf(node)}
        data-indent-level={indentLevel || undefined}
        style={{ '--document-indent-level': indentLevel } as React.CSSProperties}
        data-node-id={node.id}
        data-selected={selected || undefined}
        data-placeholder={placeholder}
        data-empty={text === '' ? 'true' : undefined}
        onInput={(event: React.FormEvent<HTMLElement>) => { onInput(node, event.currentTarget, `typing:${node.id}`); gatherHosts(); }}
        onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => onKeyDown(node, event)}
        onPaste={(event: React.ClipboardEvent<HTMLElement>) => onPaste(node, event)}
        onFocus={onFocus}
        onBlur={() => draw(false)}
      />
      {renderChip ? hosts.map(host => createPortal(
        renderChip({ kind: host.dataset.refKind ?? '', value: host.dataset.refValue ?? '', label: host.dataset.refLabel ?? '', ...(host.dataset.refIcon ? { icon: host.dataset.refIcon } : {}) }, host.dataset.colour),
        host,
        `${host.dataset.refKind}:${host.dataset.refValue}:${hosts.indexOf(host)}`,
      )) : null}
    </>
  );
}

export const DocumentEditor = React.forwardRef<DocumentEditorHandle, DocumentEditorProps>(function DocumentEditor({
  value, onChange, ariaLabel, placeholder, disabled = false, rows = [], enterSends = false, onSubmit, onEscape,
  renderPicker, renderChip, colourOf, claimPaste, blockLabel = position => `${ariaLabel}, line ${position}`,
  selectionLabel = count => `${count} selected`, onSelectionDispatch, onShortcutDispatch,
}, forwarded) {
  const rules = React.useMemo(() => editingRulesWith(rows), [rows]);
  const textPolicy = React.useCallback((node: DocumentNode) => textInputPolicyFor(rules.shortcuts, node.props?.made_by_shortcut), [rules.shortcuts]);
  const marksForNode = React.useCallback((node: DocumentNode) => textPolicy(node)?.mode === 'literal' ? [] : rules.marks, [rules.marks, textPolicy]);
  const doc = React.useMemo(() => normalizeDocument(value, rules, mintBlockId), [value, rules]);
  const elements = React.useRef(new Map<string, HTMLElement>());
  const root = React.useRef<HTMLElement | null>(null);
  const pendingFocus = React.useRef<Focus | null>(null);
  const goalRun = React.useRef<GoalRun | null>(null);
  const pickerKeys = React.useRef<((key: string) => boolean) | null>(null);
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const docRef = React.useRef(doc);
  const onChangeRef = React.useRef(onChange);
  const pendingFocusId = React.useRef<string | null>(null);
  const controlledFingerprint = JSON.stringify(doc);
  const controlledFingerprintRef = React.useRef(controlledFingerprint);
  const lastEmittedFingerprint = React.useRef<string | null>(null);
  const historyRef = React.useRef<EditorHistory<DocumentValue> | null>(null);
  if (!historyRef.current) {
    historyRef.current = createEditorHistory({
      apply: snapshot => {
        docRef.current = snapshot;
        lastEmittedFingerprint.current = JSON.stringify(snapshot);
        const target = snapshot.blocks.find(block => block.id === pendingFocusId.current && block.kind === 'Text')
          ?? snapshot.blocks.find(block => block.kind === 'Text' && block.visible !== false);
        pendingFocus.current = target ? { blockId: target.id, at: 'end' } : null;
        onChangeRef.current(snapshot);
      },
    });
  }
  onChangeRef.current = onChange;
  if (controlledFingerprintRef.current !== controlledFingerprint) {
    if (lastEmittedFingerprint.current === controlledFingerprint) lastEmittedFingerprint.current = null;
    else historyRef.current?.clear();
    controlledFingerprintRef.current = controlledFingerprint;
  }
  docRef.current = doc;

  const register = React.useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);

  const commit = React.useCallback((edited: Edited) => {
    pendingFocus.current = edited.focus;
    pendingFocusId.current = edited.focus.blockId;
    const before = docRef.current;
    const after = edited.value;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    historyRef.current?.record(before, after);
    docRef.current = after;
    lastEmittedFingerprint.current = JSON.stringify(after);
    onChangeRef.current(after);
  }, []);

  // After a change the caret goes where the change said (blocks have drawn their new words by now).
  React.useLayoutEffect(() => {
    const focus = pendingFocus.current;
    if (!focus) return;
    pendingFocus.current = null;
    const el = elements.current.get(focus.blockId);
    if (!el) return;
    el.focus();
    const target = doc.blocks.find(block => block.id === focus.blockId);
    const marks = target ? marksForNode(target) : rules.marks;
    if (typeof focus.at === 'number' && typeof focus.end === 'number') restoreBlockSelection(el, focus.at, focus.end, marks);
    else placeCaretAtFlatOffset(el, focus.at === 'end' ? Number.MAX_SAFE_INTEGER : focus.at, marks);
  }, [doc, marksForNode, rules.marks]);

  const orderedWords = React.useCallback(() => doc.blocks.filter(node => node.kind === 'Text' && node.visible !== false)
    .map(node => ({ node, el: elements.current.get(node.id) })).filter((row): row is { node: DocumentNode; el: HTMLElement } => Boolean(row.el)), [doc]);

  React.useImperativeHandle(forwarded, () => ({
    focus: () => {
      const last = orderedWords().at(-1);
      if (!last) return;
      last.el.focus();
      placeCaretAtFlatOffset(last.el, Number.MAX_SAFE_INTEGER, marksForNode(last.node));
    },
    insertText: (words: string) => {
      const active = root.current?.ownerDocument.activeElement;
      const inside = orderedWords().find(row => row.el === active) ?? orderedWords().at(-1);
      if (!inside) return;
      const marks = marksForNode(inside.node);
      if (inside.el !== active) { inside.el.focus(); placeCaretAtFlatOffset(inside.el, Number.MAX_SAFE_INTEGER, marks); }
      const before = readBlockText(inside.el, marks);
      const at = caretFlatOffset(inside.el, marks);
      const spaced = words.startsWith('@') && at > 0 && !/\s$/.test(before.slice(0, at)) ? ` ${words}` : words;
      inside.el.ownerDocument.execCommand('insertText', false, spaced);
    },
  }), [orderedWords, marksForNode]);

  // `@` and the words after it (the row whose picker opens where the caret is) open the caller's picker.
  const findPicker = React.useCallback((node: DocumentNode, el: HTMLElement) => {
    if (!renderPicker) return;
    if (textPolicy(node)?.mode === 'literal') { setOpened(null); return; }
    const marks = marksForNode(node);
    const text = readBlockText(el, marks);
    const at = caretFlatOffset(el, marks);
    const hit = at < 0 ? null : matchInputShortcut(text, 'inline', rules.shortcuts, at);
    setOpened(hit && hit.renderer === 'picker' ? { blockId: node.id, query: hit.query, ...(hit.range ? { range: hit.range } : {}) } : null);
  }, [renderPicker, rules, marksForNode, textPolicy]);

  const onInput = React.useCallback((node: DocumentNode, el: HTMLElement, group?: string) => {
    goalRun.current = null;
    const before = docRef.current;
    const marks = marksForNode(node);
    const after = setBlockText(before, node.id, readBlockText(el, marks));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      historyRef.current?.record(before, after, group);
      docRef.current = after;
      lastEmittedFingerprint.current = JSON.stringify(after);
      onChangeRef.current(after);
    }
    findPicker(node, el);
  }, [findPicker, marksForNode]);

  const navigate = (el: HTMLElement, key: string, node: DocumentNode): boolean => {
    const geometry = readCaretGeometry(el);
    const command = geometry ? resolveCursorCommand(key, geometry, rules.cursorCommands) : null;
    if (!geometry || !command) return false;
    const from = el.getBoundingClientRect();
    const vertical = command.direction.dx === 0 && (command.landEdge === 'top' || command.landEdge === 'bottom');
    const column = vertical ? resolveGoalColumn(goalRun.current, geometry.goalX) : geometry.goalX;
    const candidates: Candidate[] = orderedWords().filter(row => row.el !== el).map(row => {
      const box = row.el.getBoundingClientRect();
      return { id: row.node.id, rect: { x: box.left, y: box.top, w: box.width, h: box.height } };
    });
    const target = resolveInDirection({ x: from.left, y: from.top, w: from.width, h: from.height }, command.direction, candidates, { x: column, y: geometry.goalY });
    const targetEl = target ? elements.current.get(target) : null;
    if (!targetEl) return false;
    const targetNode = orderedWords().find(row => row.node.id === target)?.node;
    placeCaretAtEdge(targetEl, column, command.landEdge, targetNode ? marksForNode(targetNode) : rules.marks);
    const landed = readCaretGeometry(targetEl);
    goalRun.current = vertical && landed ? { column, landedX: landed.goalX } : null;
    return true;
  };

  const onKeyDown = (node: DocumentNode, event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled || isTextCompositionKey(event.nativeEvent)) return;
    const el = event.currentTarget;
    const { key } = event;
    const currentDoc = docRef.current;
    const policy = textPolicy(node);
    const literal = policy?.mode === 'literal';
    const marks = marksForNode(node);
    if (opened && PICKER_KEYS.has(key)) {
      const used = pickerKeys.current?.(key) ?? false;
      if (used || key === 'Escape') {
        event.preventDefault();
        if (key === 'Escape') setOpened(null);
        return;
      }
    }
    if (literal && policy?.indent_unit && key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const selection = readBlockSelection(el, marks);
      if (!selection) return;
      event.preventDefault();
      const edited = literalIndentEdit(readBlockText(el, marks), selection.start, selection.end, policy.indent_unit, event.shiftKey);
      commit({ value: setBlockText(currentDoc, node.id, edited.text), focus: { blockId: node.id, at: edited.start, end: edited.end } });
      return;
    }
    if (key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const selection = el.ownerDocument.defaultView?.getSelection();
      if (selection?.isCollapsed) {
        const edited = changeBlockIndent(currentDoc, node.id, event.shiftKey ? -1 : 1, rules, caretFlatOffset(el, marks));
        if (edited) { event.preventDefault(); commit(edited); return; }
      }
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'a' && wholeBlockSelected(el)) {
      event.preventDefault();
      setOpened(null);
      setSelected(currentDoc.blocks.map(one => one.id));
      root.current?.focus();
      return;
    }
    if (!event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && rules.cursorCommands.some(command => command.key === key)) {
      if (navigate(el, key, node)) { event.preventDefault(); return; }
    }
    goalRun.current = null;
    if (key === 'Backspace' && !event.metaKey && !event.altKey) {
      const geometry = readCaretGeometry(el);
      if (geometry?.atStart) {
        const joined = joinWithPrevious(currentDoc, node.id);
        if (joined) { event.preventDefault(); commit(joined); return; }
      }
    }
    // A row that hands its words on (`dispatch`) fires on its own terminator; the block empties.
    const handOff = !literal && (key === ' ' || key === 'Enter') ? matchInputShortcut(key === ' ' ? `${readBlockText(el, marks)} ` : readBlockText(el, marks), key === ' ' ? 'space' : 'enter', rules.shortcuts) : null;
    if (handOff?.shortcut.dispatch && onShortcutDispatch) {
      event.preventDefault();
      onShortcutDispatch(handOff.shortcut.dispatch, handOff.captured.text.trim());
      commit({ value: setBlockText(currentDoc, node.id, ''), focus: { blockId: node.id, at: 0 } });
      return;
    }
    if (key === ' ') {
      if (literal) return;
      const text = readBlockText(el, marks);
      const at = caretFlatOffset(el, marks);
      const head = at < 0 ? text : text.slice(0, at);
      const tail = at < 0 ? '' : text.slice(at);
      const match = matchBlockShortcut(`${head} `, 'space', rules.autoformat, rules.shortcuts, node.props?.made_by_shortcut);
      if (match && match.captured.text === '') {
        event.preventDefault();
        commit(applyAutoformat(currentDoc, node.id, { ...match, captured: { ...match.captured, text: tail } }, mintBlockId, tail.length));
        return;
      }
    }
    if (key === 'Enter') {
      const text = readBlockText(el, marks);
      const split = splitEditableSelection(el, fragment => readBlockText(fragment, marks));
      if (!split) return;
      const at = split.before.length;
      if (policy?.enter === 'line_break') {
        event.preventDefault();
        const inserted = literalLineBreak(split.before + split.after, at, policy);
        commit({ value: setBlockText(currentDoc, node.id, `${split.before}${inserted}${split.after}`), focus: { blockId: node.id, at: at + inserted.length } });
        return;
      }
      const selectedOut = setBlockText(currentDoc, node.id, split.before + split.after);
      const divider = matchAutoformat(text, 'enter', rules.autoformat);
      if (divider) { event.preventDefault(); commit(applyAutoformat(currentDoc, node.id, divider, mintBlockId)); return; }
      // Shift+Enter is a plain new line: it never continues or ends a list.
      const decision = event.shiftKey ? { does: 'make_a_plain_block' as const } : enterDecision(selectedOut, node.id, rules);
      if (decision.does === 'make_another_one_like_this') { event.preventDefault(); commit(continueBlock(selectedOut, node.id, at, decision, mintBlockId)); return; }
      if (decision.does === 'leave_this_kind') {
        event.preventDefault();
        commit(changeBlockIndent(selectedOut, node.id, -1, rules, at) ?? leaveBlockKind(selectedOut, node.id));
        return;
      }
      if (enterSends && !event.shiftKey) { event.preventDefault(); onSubmit?.(); return; }
      if (!enterSends && event.shiftKey) {
        event.preventDefault();
        el.ownerDocument.execCommand('insertLineBreak');
        onInput(node, el);
        return;
      }
      event.preventDefault();
      commit(splitBlock(selectedOut, node.id, at, mintBlockId));
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      if (onEscape) onEscape();
      else el.blur();
    }
  };

  const onPaste = (node: DocumentNode, event: React.ClipboardEvent<HTMLElement>) => {
    if (disabled || (claimPaste && claimPaste(event.clipboardData))) return;
    const plain = event.clipboardData.getData('text/plain');
    // A paste from another editor keeps its structure (paste-sources.json); a literal block keeps the plain characters.
    const pasted = textPolicy(node)?.mode === 'literal' ? plain : pastedMarkdown(event.clipboardData.getData('text/html'))?.markdown ?? plain;
    if (!pasted) return;
    const marks = marksForNode(node);
    const split = splitEditableSelection(event.currentTarget, fragment => readBlockText(fragment, marks));
    if (!split) return;
    event.preventDefault();
    const at = split.before.length;
    const currentDoc = docRef.current;
    if (textPolicy(node)?.mode === 'literal') {
      const normalized = pasted.replace(/\r\n?/g, '\n');
      commit({ value: setBlockText(currentDoc, node.id, `${split.before}${normalized}${split.after}`), focus: { blockId: node.id, at: at + normalized.length } });
      return;
    }
    if (!pasted.includes('\n')) {
      commit({ value: setBlockText(currentDoc, node.id, `${split.before}${pasted}${split.after}`), focus: { blockId: node.id, at: at + pasted.length } });
      return;
    }
    commit(pasteMarkdown(setBlockText(currentDoc, node.id, split.before + split.after), node.id, at, pasted, rules, mintBlockId));
  };

  // Keys while blocks are selected run the selection ops (DATA); anything else lets the selection go.
  const onSelectionKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (isTextCompositionKey(event.nativeEvent)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      const history = historyRef.current;
      const available = event.shiftKey ? history?.state().future.length : history?.state().past.length;
      if (available) {
        event.preventDefault();
        void (event.shiftKey ? history?.redo() : history?.undo());
        return;
      }
    }
    if (!selected.length || event.target !== root.current) return;
    const op = matchSelectionOp(event.key, rules.selectionOps);
    if (!op) return;
    event.preventDefault();
    const landing = selected;
    setSelected([]);
    if ('clear' in op.effect) {
      const first = elements.current.get(doc.blocks.find(one => landing.includes(one.id) && one.kind === 'Text')?.id ?? '');
      first?.focus();
      return;
    }
    if ('dispatch' in op.effect) {
      onSelectionDispatch?.(op.effect.dispatch.target, { ...op.effect.dispatch.payload, selected: landing });
      return;
    }
    commit(applySelectionOp(docRef.current, op, landing, rules, mintBlockId));
  };

  // A drag that starts between blocks draws a box; every block it touches is selected. A finger dragging there is
  // scrolling the words, not drawing a box: selecting would hide the caret and leave the scroll to the page.
  const dragFrom = React.useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (selected.length) setSelected([]);
    dragFrom.current = event.target === root.current && event.pointerType !== 'touch' ? { x: event.clientX, y: event.clientY } : null;
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const from = dragFrom.current;
    if (!from || event.buttons !== 1) return;
    const box = { x: Math.min(from.x, event.clientX), y: Math.min(from.y, event.clientY), w: Math.abs(event.clientX - from.x), h: Math.abs(event.clientY - from.y) };
    const candidates: Candidate[] = doc.blocks.flatMap(node => {
      const el = elements.current.get(node.id);
      if (!el) return [];
      const rect = el.getBoundingClientRect();
      return [{ id: node.id, rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height } }];
    });
    const touched = candidatesInRect(box, candidates);
    if (touched.length) { setSelected(touched); root.current?.focus(); }
  };

  const closePicker = React.useCallback(() => setOpened(null), []);
  const pickerKeysFrom = React.useCallback((handler: ((key: string) => boolean) | null) => { pickerKeys.current = handler; }, []);
  const request: MentionPickerRequest | null = opened && renderPicker ? {
    query: opened.query,
    choose: ref => {
      const target = opened;
      setOpened(null);
      commit(insertMention(docRef.current, target.blockId, ref, target.range));
    },
    close: closePicker,
    keys: pickerKeysFrom,
  } : null;

  const empty = isDocumentEmpty(doc);
  const wordBlocks = doc.blocks.filter(node => node.kind === 'Text');
  return (
    <Container
      ref={root as React.Ref<HTMLDivElement>}
      layout="vertical"
      width="full"
      className="document-editor"
      tabIndex={-1}
      aria-label={selected.length ? selectionLabel(selected.length) : undefined}
      data-selecting={selected.length ? 'true' : undefined}
      onKeyDown={onSelectionKey}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => { dragFrom.current = null; }}
      // A press on the space around the words (a finger rarely lands on the one short line) puts the caret at the end
      // of the last words, as pressing inside a text field does.
      onClick={(event: React.MouseEvent<HTMLElement>) => {
        const around = event.target === root.current || (event.target instanceof Element && event.target.classList.contains('document-editor-blocks'));
        if (!around || selected.length || disabled) return;
        const last = orderedWords().at(-1);
        if (!last) return;
        last.el.focus();
        placeCaretAtFlatOffset(last.el, Number.MAX_SAFE_INTEGER, marksForNode(last.node));
      }}
    >
      <Container layout="vertical" width="full" className="document-editor-blocks">
      {doc.blocks.filter(node => node.visible !== false).map(node => (
        <Block
          key={node.id}
          node={node}
          label={node.id === wordBlocks[0]?.id ? ariaLabel : blockLabel(wordBlocks.indexOf(node) + 1)}
          placeholder={empty && node.id === wordBlocks[0]?.id ? placeholder : undefined}
          marks={marksForNode(node)}
          literal={textPolicy(node)?.mode === 'literal'}
          colourOf={colourOf}
          renderChip={renderChip}
          disabled={disabled}
          selected={selected.includes(node.id)}
          register={register}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => { if (selected.length) setSelected([]); }}
        />
      ))}
      </Container>
      {request ? <Container className="document-editor-picker">{renderPicker?.(request)}</Container> : null}
    </Container>
  );
});

DocumentEditor.displayName = 'DocumentEditor';
