# file-editor/show

Browser UI surface for the `file-editor` package.

## Files

| File | Purpose |
|------|---------|
| `FileEditor.tsx` | CodeMirror editor, file loading/saving state, language mode, line/gutter controls, in-file search, and inline selected-text AI prompt wiring. |
| `FileEditorSearchPanel.tsx` | The find/replace widget rendered inside CodeMirror's search-panel slot. Built entirely from `@/packages/ui` primitives (Input, Button, Container, Text, Icon, Tooltip) + screen-look tokens — zero raw HTML, zero className. Data-driven modifier toggles (match case / regex / whole word), live `n/N` match count, navigation, and replace one/all. |
| `create-file-editor-search-panel.ts` | Pure glue: the `(view) => Panel` factory passed to `search({ createPanel })`. Mounts `FileEditorSearchPanel` into the panel's bare mount node via `mountReactSurface` and fans CodeMirror `ViewUpdate`s into it so the match count stays live. |
| `AskAiToEditSelectedFileText.tsx` | Selection-positioned prompt for sending selected code/text to the next agent request. |
| `mount-file-editor.tsx` | Runtime Kit mount that reads the selected file input and renders the editor in a `FloatingMaterialFrame`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `FileEditorSearchPanel` | `({ view, subscribeToUpdates }) => JSX` | The find/replace UI; mirrors a CodeMirror `SearchQuery` into local state and drives all search via CM commands/effects. |
| `createFileEditorSearchPanel` | `(view: EditorView) => Panel` | CodeMirror panel factory; bridges the React widget into the editor's panel slot. |

## Search Contract

Search stays inside CodeMirror — the React widget owns **no** search logic. It
mirrors a `SearchQuery` into local state, pushes it with `setSearchQuery`, and
drives navigation/replacement through CodeMirror commands (`findNext`,
`findPrevious`, `selectMatches`, `replaceNext`, `replaceAll`,
`closeSearchPanel`). Do not build a second regex/match state machine in React,
and do not use browser `window.find`.

The visible panel chrome is **our** UI, not CodeMirror's: `search()` is
configured with `createPanel: createFileEditorSearchPanel`, so CodeMirror never
renders its native `.cm-search` DOM. To change how the panel looks, edit
`FileEditorSearchPanel.tsx` (ui/ components + tokens only). The document-level
match highlights (`.cm-searchMatch*`, `.cm-selectionMatch`) are still styled in
`FILE_EDITOR_THEME` inside `FileEditor.tsx`.

## Dependencies

**Depends on:** `tools/ui` (Button, Container, Icon, Input, Text, Tooltip, `mountReactSurface`), `@codemirror/search`, `@codemirror/view`, `@codemirror/state`, `lucide-react`, `@/packages/file-editor/read-data`, `@/packages/file-editor/do-work`.

**Depended on by:** the `file-editor` package entry / Runtime Kit mount that renders this surface in bitfield-studio.
