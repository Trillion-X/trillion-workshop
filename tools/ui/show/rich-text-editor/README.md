# RichTextEditor

Canonical contentEditable-based editor surface for caller-owned structured content with selection and trigger-key callbacks.

## Purpose

Provides a caller-styled contentEditable div for capturing keyboard input and text editing. Used by NoteEditor and other components that need a text input surface without external dependencies.

## Files

| File | Purpose |
|------|---------|
| `RichTextEditor.tsx` | Component definition with contentEditable div and selection tracking |
| `editing-selection.ts` | Native composition tracking and selection splitting for caller-owned block text |
| `editing-history.ts` | Grouped typing and discrete edits through the shared command-history owner; failed restores retain their step for retry |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `RichTextEditorProps` | `{ editorHtml: string; className?: string; placeholder?: string; onSelectionChange?: () => void; onKeyDown?: (event) => void; style?: React.CSSProperties }` | Props for configuring the editor |

## Architecture

- **contentEditable div:** The Physics necessity for keyboard input. Visual styling is caller-owned `className` data, normally screen-look token classes; the component ships no local `<style>` tag and no built-in color system.
- **Generic mechanics classes:** The editor supplies only generic text-flow, placeholder, and entity-reference selectors using token classes so callers can project the same primitive into different looks.
- **Selection tracking:** Caller responsible for capturing selection via `onSelectionChange` callback.
- **Keydown passthrough:** Built-in trigger keys still run, then caller `onKeyDown` receives the same event for submit/menu behavior.
- **Caller-owned document model:** Parent components project their machine-readable document into `editorHtml` and parse the live DOM back on input.
- **Selected text:** `splitEditableSelection` serializes cloned fragments on each side of a range. Enter and paste can replace the selected words while preserving surrounding marks and atomic chips. A range outside the editable stays with its owning surface.
- **Composition:** `trackTextComposition` and `isTextCompositionKey` keep native IME keys out of editor shortcuts, including WebKit's commit key with `keyCode=229`.
- **Placeholder:** Shows when content is empty (via data-placeholder attribute).

## Dependencies

- React (hooks)
- No external editor libraries

Reference studied for this repair: 21st.dev Editor component 21193, found through `rich text block editor`. No upstream implementation was copied. These mechanics repair the existing native editable owners used by Write and the message composer. REA statically inspected the installed Notion package with partial bundle coverage; that analysis does not establish Notion editor behavior.

## Related

- `NoteEditor` component: Wraps RichTextEditor with structured note-document serialization, inline entity references, and overlay menus
