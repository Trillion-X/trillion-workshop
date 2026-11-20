# tools/connect-the-original-repository-behind-an-app-edit/

Connect the original repository behind an app, edit its source with revision checks and preview the rebuilt app.

This folder has no tool row yet. The other old files (the saved-connection host, 950 lines, and its tool list) are in the private copy repository, listed in `moved-from.json`; they wait for the pieces named below. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## What is here

- `src/source-project-edit.mjs` (from the old repository, commit b6ae0ebf81, `src/source-project-edit.mjs`; only the marker attribute is now the caller's, passed as `marker_attribute`): the pure steps. `resolveSourceSelection` maps a chosen element of the running page to one source location at an exact commit (HTML markers, JSX, Vue, Svelte, JSON-backed text; ambiguity and a changed commit refuse). `applySourceEdit` changes only the quoted span (literal text, an existing inline style value, a safe link, a local image path or a class). `sourceCandidateFiles` lists bounded files to inspect when ownership is not proved. `sourceSelectionFingerprint` names a selection. They read only bytes the caller gives them, from a pinned repository read.
- `test/source-project-edit.test.mjs`: the old 12 tests, run with `node --test`.

Not here yet (the repository reads and writes, the saved connection and the routes the Sites screen calls): see the research row `verify-every-port/connect-the-original-repository-behind-an-app-edit`.
