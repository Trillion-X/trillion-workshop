# tools/place-a-sign-up-form-or-a-published-recipe-on-a-site/

Place a sign-up form or a published recipe on a site page and show visitors a safe view of it.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `web/parts/ui/show/public-app-editor/placed-capability-runtime.mjs` | The runtime a public page loads to draw a placed capability: its form, its result and its failure, served from the current Trillion host. Moved byte for byte from the web client (`moved-from.json`). |
| `web/parts/ui/show/public-app-editor/public-app-run-form.mjs` | The schema-driven controls of a capability a public page can run. |
| `web/test/public-app-capability-runtime.test.mjs` | The runtime's form, result and refusals. |
| `web/test/public-app-visitor-form.test.mjs` | The visitor's form built from a capability's input schema. |
| `web/test/public-app-workflow-card-runtime.test.mjs` | A workflow card drawn by the runtime. |
| `moved-from.json` | The receipt of the move: each moved file's source path and commit and the identity of its bytes there and here. |
