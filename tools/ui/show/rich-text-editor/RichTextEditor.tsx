// bitfield/packages/ui/rich-text-editor/RichTextEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical contentEditable editor surface for caller-owned structured content.
// Wraps contentEditable div with proper event handling while the caller owns
// visual styling, the machine-readable document model, and DOM translation.
//
// Trigger keys (@ and /) are intercepted and delegated to callbacks with
// caret position info, enabling parent components to show overlay menus
// (entity autocomplete, slash commands) at the correct position.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. contentEditable div is the Physics necessity for keyboard input
// 2. Visual styling is caller-owned className data; this component only supplies generic editor mechanics
// 3. Placeholder text shows when content is empty
// 4. Selection tracking via onMouseUp and onKeyUp callbacks
// 5. Caller-provided editor HTML is the rendered projection, not source truth
// 6. Trigger keys delegate to parent via callbacks with caret rect
// 7. onInput callback returns the live editor root for caller-side parsing
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { cn } from '../cn';

// Headings / lists / links / blockquotes inside the editor are flattened to
// `inherit` by the global CSS preflight, so `formatBlock h1..h6`, list toggles,
// and links applied no visible change (a user: "header option does nothing").
// New arbitrary Tailwind heading variants can't be added — the studio's global
// stylesheet is PRECOMPILED, so an unseen class is inert. Inject ONE scoped
// stylesheet (em-relative, so it scales with the note's base size) once; it
// styles both the live editor and the read-only projection (same component).
let richTextContentStylesInjected = false;
function ensureRichTextContentStyles(): void {
  if (typeof document === 'undefined' || richTextContentStylesInjected) return;
  if (document.getElementById('rte-content-styles')) { richTextContentStylesInjected = true; return; }
  const el = document.createElement('style');
  el.id = 'rte-content-styles';
  el.textContent = [
    '.rte-content h1{font-size:1.6em;font-weight:700;line-height:1.2;margin:.2em 0}',
    '.rte-content h2{font-size:1.35em;font-weight:700;line-height:1.25;margin:.2em 0}',
    '.rte-content h3{font-size:1.15em;font-weight:600;margin:.2em 0}',
    '.rte-content h4{font-size:1em;font-weight:600;margin:.2em 0}',
    '.rte-content h5{font-size:.9em;font-weight:600;margin:.2em 0}',
    '.rte-content h6{font-size:.85em;font-weight:600;margin:.2em 0}',
    '.rte-content ul{list-style:disc;padding-left:1.4em;margin:.2em 0}',
    '.rte-content ol{list-style:decimal;padding-left:1.4em;margin:.2em 0}',
    '.rte-content li{margin:.1em 0}',
    '.rte-content a{color:var(--accent-primary,#6ea8fe);text-decoration:underline}',
    '.rte-content blockquote{font-family:var(--font-display,inherit);font-size:1.12em;line-height:1.45;color:var(--text-secondary,inherit);margin:.3em 0}',
  ].join('');
  document.head.appendChild(el);
  richTextContentStylesInjected = true;
}

// ============================================================================
// TYPES
// ============================================================================

/** Caret position rect for overlay positioning */
export interface CaretRect {
  top: number;
  left: number;
  height: number;
}

export interface RichTextEditorProps {
  /** HTML projection of the caller-owned document model */
  editorHtml: string;
  /** Caller-owned visual classes, normally screen-look token classes */
  className?: string;
  /** Placeholder text when content is empty */
  placeholder?: string;
  /** Optional ref to the contentEditable root */
  editorRef?: React.MutableRefObject<HTMLDivElement | null> | ((node: HTMLDivElement | null) => void);
  /** Called when user releases mouse (selection tracking) */
  onSelectionChange?: () => void;
  /** Called when @ key is pressed — provides caret rect for overlay positioning */
  onAtKey?: (caretRect: CaretRect) => void;
  /** Called when / key is pressed — provides caret rect for overlay positioning */
  onSlashKey?: (caretRect: CaretRect) => void;
  /** Called on every input event with the live contentEditable root */
  onInput?: (root: HTMLDivElement) => void;
  /** Called after built-in trigger key handling so callers can submit or own menus */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Called when the editor loses focus — callers commit the live content here. */
  onBlur?: (event: React.FocusEvent<HTMLDivElement>) => void;
  /** Read-only projection: render the same HTML without editing (display surface).
   *  The caller toggles this to flip a node between view and edit with one component. */
  readOnly?: boolean;
  /** Additional style overrides */
  style?: React.CSSProperties;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Gets the caret bounding rect from the current browser selection.
 * Returns null if no selection or no range exists.
 */
function getCaretRect(): CaretRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  // When the range rect has zero dimensions (e.g., collapsed caret at start),
  // insert a temporary span to measure the caret position.
  if (rect.width === 0 && rect.height === 0) {
    const span = document.createElement('span');
    span.textContent = '\u200B'; // zero-width space
    range.insertNode(span);
    const spanRect = span.getBoundingClientRect();
    const result = { top: spanRect.top, left: spanRect.left, height: spanRect.height };
    span.parentNode?.removeChild(span);
    // Restore selection after span removal
    sel.removeAllRanges();
    sel.addRange(range);
    return result;
  }

  return { top: rect.top, left: rect.left, height: rect.height };
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * RichTextEditor: Canonical contentEditable surface for caller-owned structured content.
 *
 * Provides a styled contentEditable div with placeholder support and trigger
 * key interception for @ mentions and / slash commands. The caller owns the
 * machine-readable document model and projects it into `editorHtml`; this
 * component only syncs that projection into the DOM and returns the live root
 * on input so the caller can parse it back.
 *
 * @example
 * ```tsx
 * <RichTextEditor
 *   editorHtml="<div>Projected editor content</div>"
 *   placeholder="Start typing..."
 *   editorRef={editorRootRef}
 *   onSelectionChange={() => captureSelection()}
 *   onAtKey={(rect) => openEntityAutocomplete(rect)}
 *   onSlashKey={(rect) => openSlashCommandMenu(rect)}
 *   onInput={(root) => syncContent(root)}
 * />
 * ```
 */
export function RichTextEditor({
  className,
  editorHtml,
  placeholder = 'Start writing your thoughts...',
  editorRef,
  onSelectionChange,
  onAtKey,
  onSlashKey,
  onInput,
  onKeyDown,
  onBlur,
  readOnly = false,
  style,
}: RichTextEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const setEditorRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof editorRef === 'function') {
      editorRef(node);
      return;
    }
    if (editorRef && typeof editorRef === 'object' && 'current' in editorRef) {
      editorRef.current = node;
    }
  }, [editorRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (root.innerHTML !== editorHtml) {
      root.innerHTML = editorHtml;
    }
  }, [editorHtml]);

  const handleSelectionChange = useCallback(() => {
    onSelectionChange?.();
  }, [onSelectionChange]);

  const handleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    onInput?.(e.currentTarget);
  }, [onInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === '@' && onAtKey) {
      // Defer to next frame so the @ character is inserted first,
      // giving us an accurate caret position after the character
      requestAnimationFrame(() => {
        const rect = getCaretRect();
        if (rect) onAtKey(rect);
      });
    }
    if (e.key === '/' && onSlashKey) {
      requestAnimationFrame(() => {
        const rect = getCaretRect();
        if (rect) onSlashKey(rect);
      });
    }
    onKeyDown?.(e);
  }, [onAtKey, onKeyDown, onSlashKey]);

  useLayoutEffect(() => { ensureRichTextContentStyles(); }, []);

  return (
    <div
      ref={setEditorRef}
      className={cn(
        'rte-content',
        'min-h-full whitespace-pre-wrap break-words font-[inherit] text-[inherit] leading-[inherit] outline-none',
        'empty:before:pointer-events-none empty:before:text-[var(--text-muted)] empty:before:content-[attr(data-placeholder)]',
        '[&_[data-entity-ref]]:mx-0.5 [&_[data-entity-ref]]:cursor-pointer [&_[data-entity-ref]]:select-none',
        '[&_[data-entity-ref]]:rounded-md [&_[data-entity-ref]]:border [&_[data-entity-ref]]:border-[var(--border-primary)]',
        '[&_[data-entity-ref]]:bg-[var(--glass-bg-active)] [&_[data-entity-ref]]:px-1.5 [&_[data-entity-ref]]:py-px',
        '[&_[data-entity-ref]]:text-[0.85em] [&_[data-entity-ref]]:text-[var(--text-secondary)]',
        className,
      )}
      suppressContentEditableWarning
      contentEditable={!readOnly}
      onMouseUp={readOnly ? undefined : handleSelectionChange}
      onKeyUp={readOnly ? undefined : handleSelectionChange}
      onInput={readOnly ? undefined : handleInput}
      onKeyDown={readOnly ? undefined : handleKeyDown}
      onBlur={readOnly ? undefined : onBlur}
      style={style}
      data-placeholder={readOnly ? undefined : placeholder}
    />
  );
}
