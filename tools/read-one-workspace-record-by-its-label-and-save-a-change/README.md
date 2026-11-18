# tools/read-one-workspace-record-by-its-label-and-save-a-change/

The document operations engine of a document edited as a sequence of operations: a pure computation over values, which the page and the person's own store both run. Its rules are `src/workspace/document-operations.json`, and the engine is `src/workspace/document-operations.mjs`. Nothing here reads or writes a store.

Reading one record by its label, and saving a change only on the version it was read at (with the versions kept), is no longer a tool. It is the recipe `workflow:read-one-workspace-record-by-its-label-and-save-a-change` (`tools/workflows/recipes/read-one-workspace-record-by-its-label-and-save-a-change.json`): the person's AI renders those objects once in the person's own store and proves them on the kit's examples. The files of the old store owner were removed in the landing commit; `moved-from.json` keeps the identities of the files that remain.

The engine is also carried, byte for byte, by the workspace screens (`tools/workspace-screens/web/src/workspace/document-operations.mjs`), which is the page's copy.
