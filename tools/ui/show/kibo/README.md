# Kibo

MIT source from shadcnblocks/kibo; the Dropzone is pinned in `dropzone-provenance.json`. The copy button that
used to live here (an adaptation of Kibo's SnippetCopyButton) is now the one shared copy part,
`../copy-button/CopyButton.tsx`, used by every screen that copies.

`file-dropzone.tsx` adapts the pinned MIT Kibo Dropzone for file picking and
batch import. A page-local dropzone takes precedence over the workspace-wide
file overlay, so the overlay cannot cover an empty collection's own add target.
`mountWorkspaceFileDropzone` covers only its own workspace (not the whole
window), shows the drop highlight while a file from the computer is over the
workspace and not over something else on top of it (the message box), and
hands a drop that lands anywhere else in the workspace (a row, the toolbar, the
highlight's margin) to the workspace's Dropzone as the same drop, so choosing,
dropping on the drop area and dropping anywhere on the screen take one path.
`test/files-drop-browser.test.mjs` proves it with real drops in Chromium.
The Expansion Library uses that local target only when it has no recordings and
no active filters. See the [dropzone adaptation contract](./dropzone-reference-adaptation-contract.json).

`LazyDropzone.tsx` exports `LazyDropzone` and `LazyDropzoneEmptyState`, the same Dropzone and empty state fetched the first time one is drawn, so a screen that offers a drop area does not carry the file-selector and react-dropzone libraries in its own chunk.
