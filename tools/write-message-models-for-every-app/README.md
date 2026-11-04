# tools/write-message-models-for-every-app/

Writes the message models a Mac app, an iPhone app and the web read from ONE models file: a Swift file per Swift target and a TypeScript declaration. Hand-copied structs in each app drift apart; one list of rows and a regenerate keep them the same. Nothing here names a model or a field: they are the rows. Moved from Trillion-X/trillion `scripts/device-bridge-models.mjs` (record:library:rea:F-0073); the renderers are unchanged, and the models file and the output root, fixed paths of the old repository there, are now the caller's (`--models`, `--root`).

## Files

| File | Purpose |
|------|---------|
| `do-work/write-message-models.mjs` | `renderSwift(spec, target)`, `renderTypescript(spec)`, `outputs(spec)`; run as `node do-work/write-message-models.mjs --models <file> [--root <folder>] [--check\|--write]`. `--check` exits 1 naming each file behind its models file; `--write` (the default) writes them. |
| `read-data/sample-models.json` | A sample models file: `models` ({ name, doc, fields }; a field { name, type, optional?, mutable? }; type String, Int, Bool, a model name or a one-element list) and `targets` (`mac`, `ios`: Swift names, protocols, `identifiable`, file; `typescript`: file). |
| `test/write-message-models.test.mjs` | Renders the sample and compares the TypeScript with the declaration the old generator wrote (`test/fixtures/models.d.ts`), checks the Swift names, protocols and left-out models, and runs `--write` then `--check` and a changed row. |
| `tool-rows.json` | `tool:write-message-models-for-every-app` (`on-your-computer`). |
| `part.json` | Nothing here is imported by other code. |
