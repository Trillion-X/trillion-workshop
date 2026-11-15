# Generate copy from selected sentences

`do-work/generate-listing-copies.mjs` exports `generateCopies(source, { read, outputs, sourceName })`, a pure renderer returning a `Map` of selected destination names to text. The caller supplies the source object, a file-text reader, an explicit array or Set of allowed outputs, and the source name used in errors and block attribution. An empty output selection writes no copies. A requested destination absent from the source is refused.

`words(source, text, trail = [], sourceName = 'source')` expands text tokens with recursive-reference and missing-text refusals. The renderer preserves nested JSON, fields, text, permission reasons and length limits from the committed original. Existing `how-to-start` block delimiters remain readable; generated attribution names the caller's source without an app script command.

The module owns no product DATA, root folder, filesystem access or destination defaults. The immutable source excerpt and its port contract record a real committed source baseline. Retention is measured against the active renderer alone; archived bytes do not contribute.

Run `node --test tools/generate-copy-from-selected-sentences/test/generate-listing-copies.test.mjs` from the Workshop root.
