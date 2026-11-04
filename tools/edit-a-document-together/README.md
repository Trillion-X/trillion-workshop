# Documents

Package-owned authored scene content records and helpers.

Page references use the shared sidebar's caller-owned sections. `pageReferencesToCheck`
preserves stored tokens and groups repeated mentions per containing block. Visible
matching picker records establish resolution; absence from that feed stays “Not
checked”, never “Not found”. The projection supports a confirmed missing result,
but the surface still needs authoritative per-target reads before producing it.
Selecting a reference focuses its existing block without a persistence operation.

The declared `ca-document-index-feed` supplies the sidebar's Saved documents
collection and the same shared catalog used by saved lists. Adding a document to
a list moves its visible row; removing membership restores the library row.
Opening and dragging use the shared surface intent and the index reader's
address, address mode and authoritative revision. The caller fixes the destination
to Documents; an index row cannot redirect this control to another package.

Shared headerItems expose New page, Import a page and All pages. Existing row menus provide Rename, Spacing, Duplicate, Move to top, and Delete; all dispatch existing scene primitives. All pages reuses the existing canvas arrangement/overview operation, preserving page identities. The structured-content import workflow is not a local-file chooser and is not advertised as one.

The page list uses shared `AppSidebar`; page creation changes the scene projection, never main sidebar records. `data/sidebar-config.json` provides the default controls, overridable by `sidebar_capabilities` surface DATA. Screen arrangement supplies `surface_instance_ref` from the durable layout owner and tab id; independent tabs retain independent positions. Standalone mounts lacking that identity keep placement ephemeral rather than sharing a document-wide sidebar setting.

## Rules

- `read-data` is a public source root for packages that need the composition record readers across the package boundary.
- Public source roots describe allowed package source imports before admission. Runtime truth remains admitted log entries, byte addresses, and the log projection.
- Active persistence is `package::documents::authored-scene-content`.
- Scene nodes carry generic children, edges, bindings, triggers, and action references. Product examples stay data records and owner routes, never package backend families.

## In Trillion

Write keeps block controls in the page gutter at every nesting depth. Its shared
portaled menu supports keyboard and touch, duplicate, sibling movement and
deletion. Phone block actions have a 44-pixel touch target beside the text.
Grouped typing and discrete model edits share undo/redo, including scene edges
and reusable-component definitions. History uses the serialized save lane and
preserves newer native drafts during replay. Multiline paste replaces the selected
range, keeps surrounding formatted text, and applies existing shortcut DATA to
new blocks; immediate typing lands before the carried suffix.

HTML import retains HTTP(S) link destinations as existing URL reference chips
and image sources as ordinary Image nodes. These imported references preserve
the destination; shared RecordChip renders them as validated links, preserving provider-owned internal routes and safe legacy URL tokens.

Write splits the live editable at its selected range when Enter creates a block. Both halves are kept in one document transaction, and typing while the new block opens lands before its carried suffix. The shared native editable mechanics in `parts/ui/show/rich-text-editor/editing-selection.ts` leave composition keys with the IME, including WebKit's keyCode 229 commit. The message editor uses the same selection reader for Enter and paste, so selected words are replaced rather than retained. A queued document save snapshots submitted bytes before earlier operations finish.

Trillion's `parts/documents` is this package copied verbatim; `scripts/port-sources.json` lists every file that differs and why (imports pointed at `#workspace-records`, relative `.ts` imports for Node, the composition sender, two Trillion-only fields), and `scripts/check-port-fidelity.mjs` refuses any other difference.

- **The Write screen** (`show/write-screen.tsx` with its settings `show/write-screen.json`, sidebar list "Things you do as input") is a screen module (`scripts/screen-modules.mjs`): built from this folder into its own bundle that the page imports when Write first opens (`src/workspace/tool-screen.tsx`, kind `module`), so the app never carries it. Its one export `mount(element, { surfaceInput })` mounts `show/mount-documents.tsx` as it is. Its pages are kept in the person's records under `package::documents::documents` (`src/workspace/records.ts`), its feeds are made from `things-to-store-and-run.json` (`src/workspace/part-records.ts`), and every edit is laid out by the composition engine running in the page (`slot::composition-engine`: `crates/composition-engine`, `src/workspace/slot-in-the-page.ts`, `src/workspace/targets.ts`).
- **The Write screen's page**: a new page opens on a large title block that says Untitled until it is named, then a body block (the empty-state record in `things-to-store-and-run.json`); an empty block says "Type / for commands" (the `package::documents::runtime-config` record); the pages list shows pages and their headings, plus indexed Saved documents. Both use the shared saved-list catalog; placement and list controls are supplied by the sidebar owner (`show/write-screen.json`).
- **One document, many screens**: Write opens any document by `scene_address`, including one kept in a space's live room (`space-room:<space>/package::documents::documents::<id>`, `src/workspace/record-places.json`); `show/mount-documents.tsx` reads it again whenever anyone else changes it (`subscribeRecordChanges`), so a board card showing the document (the board's Open as document, `parts/group/show/board-screen.tsx`) and a Write tab follow each other live. `sectionsToContent` (public through `index.ts`) makes a document's pages from plain sections of words.
- **The message box** (`parts/ui/show/composer`) writes with `show/DocumentEditor.tsx`, a Trillion editor of one editable per block built on this package's read-data: the registries in `read-data/documents.ts`, `inline-tokens`, `cursor-commands`, `cursor-nav`, `selection-ops`, `what-enter-does-in-this-block`, `normalize-authored-document` and `composer-key-action`.

| Trillion file | Purpose |
|------|---------|
| `index.ts`, `part.json` | The part's public face and the files other parts may import. |
| `show/write-screen.tsx` | The Write screen as a screen module: `mount(element, { surfaceInput })` feeds the surface its manifest's feeds and mounts `show/mount-documents.tsx` with the Write settings. |
| `show/write-screen.json` | The Write screen's settings: the look class (`parts/screen-look/show/write-page.css`), the surface filling its pane, and the pages rail with per-instance position, collapse, float, hide and resize capabilities. |
| `show/DocumentEditor.tsx` | `DocumentEditor`: one editable per block; shortcuts at a block's start, Enter / Backspace per block kind, arrows across blocks by position, `@` opening the caller's picker, mentions drawn as chips, pasted markdown landing as blocks (a paste from another editor first written as markdown by `read-data/paste-sources.ts`), Select all twice selecting every block. |
| `read-data/paste-sources.ts` | `pastedMarkdown(html)`: where a paste came from (signatures in `paste-sources.json`) and its elements written as markdown by that source's rules falling through to the default ones; null keeps the plain text. `tableRows(html)`: a pasted table as rows of cell words, for a list. |
| `read-data/paste-sources.json` | DATA: paste sources and their clipboard signatures, per-source and default element rules, the most table rows a list takes. |
| `read-data/document-value.ts` | The message box's document (`{ blocks }`) and every change to it as pure functions, plus reading it out as markdown, plain words and mentions, and in from markdown, through the registries of `read-data/documents.ts`. |
| `read-data/editing-rules.json` | The message box's shipped rows: shortcuts with their look, what Enter does and how each writes as markdown; inline marks; caret commands; selection ops; empty state. |
| `read-data/inline-chip-dom.ts` (Trillion-only) | Chips coloured per kind, the chip look class, `isDrawnAs`, and the caret's flat offset over chips and marks (`caretFlatOffset`, `placeCaretAtFlatOffset`); a superset of the package's API. |
| `read-data/documents.ts` (one Trillion-only field) | An input-shortcut row keeps its `markdown` field, so the message box writes what a row made as markdown. |
| `do-work/send-composition-transaction.ts` (Trillion-only sender) | Sends scene changes to `slot::composition-engine` through `#workspace-records`, answered in the page. |

Trillion tests: `test/documents/*.test.ts` (node), `test/documents/inline-chip-dom-browser.test.mjs`, `test/write-screen-browser.test.mjs` (New page, write, reload, the words are back). Markdown section placement is the separate part `parts/document-sections`. The look of the message box editor is `parts/screen-look/show/document-editor.css`.


List shortcuts opt into Tab and Shift+Tab through `indentable` DATA. Both editors keep `indent_level` in the document; continued items inherit it and nested Markdown uses two spaces per level. Saved depths are bounded to eight and the look caps the inset to preserve narrow-screen reading width. This is block indentation, not full Notion rich-clipboard or nested-block parity.

The composition AST preserves opaque authored properties through full snapshots,
incremental updates and blueprint conversion; the kernel does not own editor rule
names. Reopening a rule-authored block keeps its identity and metadata instead of
parsing its visible marker again. Permanent outbox refusals carry the actual CAS
condition through the existing document store, so Retry also works after save
coalescing. Concurrent remote changes still require comparison.

Reference inspection: installed Notion's disposable editor supplied keyboard and
list behavior observations. 21st.dev Draggable List (component 1859) was inspected;
no code was copied. Write continues to use shared gutter controls and Dropdown,
with Coss controls in the shared UI owner. Mobbin was unavailable in this session.

Current broader editor work: selection controls consume
shared Button geometry and appearance; surface CSS is owned by Screen Look. The grip
menu supports nested caller-owned choices, and conversion labels on the existing
shortcut rows expose Turn into without another block-type catalogue. The conversion
regression exercises text, heading semantics, undo and durable reload. Material conversions preserve their other authored text and media. Toggle material primary content is now its editable heading; its body remains
separate. Desktop and phone selection-formatting and material-conversion browser checks passed, including undo and durable reload. Hosted publication and customer readback remain separate.


Selected inline formatting applies the shared FormatDescriptor rules only to the
selected visible text or atomic reference units. Typed scene-style spans preserve
nested marks through the existing codec, with discrete format history entries.
The shared toolbar anchors to the current DOM selection and the Screen Look owner
supplies its appearance and popup bounds.

Material interaction DATA supplies the semantic checkbox/disclosure control and
its structural primary/body roles. Accepted state changes and body entry use the
existing authored composition transaction, history, conditional save and recovery
owners. The engine replies with both its rendered and authored trees so persistence
retains visibility expressions. Enter opens and enters a declared body; sibling
continuation, nesting and outdent remain available from the same structural DATA.
These operations retain the existing records interface while addressed-resource
routing and storage implementations migrate underneath it.

Literal text editing is declared by each producing shortcut's `text_input` DATA.
Both editors preserve code characters and multiline paste, use Enter inside the
same block, carry leading indentation, and apply the declared `indent_unit` for
Tab and Shift+Tab. Multiline indentation retains the selected words. Literal
blocks exclude inline formatting and link encoding; they still use the shared
selection-response action. Write supplies scene and block identities to the
existing response owner, including its existing shared-room audience and rights.
The formatting bar reads selection response actions from JSON and opens the
existing shared thread; document comments add no separate store or popup owner.
Reference: 21st.dev Selection Bubble Menu26926, already used by the shared
response surface. Mobbin tooling was unavailable in this session. Current new
browser qualification and hosted readback are recorded separately from source. Both menu-inserted Code and typed fences carry the same block look into shared Screen Look CSS; the runtime shortcut DATA does not keep a second code style. Literal input turns off autocorrection and automatic capitalization.

The complete material owns only its exact DATA-designated primary text grip;
body blocks and nested materials retain independent controls. Pointer hover
reveals that block's controls, with keyboard focus as the fallback. Layout
wrappers without controls cannot conceal an owning handle.

Standalone record compatibility maps saves to the current resource owner.
Undo/redo is editor-session history. Saves no longer emit documents-exhaust
version notes; the standalone adapter still filters historical notes. These
hash/time notes never established a customer-visible revision archive. Saved
current content, conflict branches and encrypted device recovery remain
distinct guarantees.

## Files

| File | Purpose |
|------|---------|
| `do-work/open-a-shared-document.mjs` | `openASharedDocument({ pages })`: which document each page of Write opens, by `show/write-screen-input.mjs` (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:open-the-document-a-pursuit-edits-together`, with a sample where two members of one pursuit open the same room and a personal page keeps its own |
