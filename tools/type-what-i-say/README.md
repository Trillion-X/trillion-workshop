# tools/type-what-i-say/

Dictation on the person's own computer. The words a hearing program returns for a spoken sentence become clean text for the app the person is in: spoken commands, the app's style, and their own dictionary and snippets, applied in the order the data names. Recognition is biased by their dictionary and by what surrounds the cursor. The text is put at the cursor as one clipboard transaction (save, write, paste, restore, verify), and the edits the person makes afterwards teach their dictionary. The person's rows and a bounded history of dictations are kept in a folder they grant. It runs as two `computer` rows.

## Files

| File | Purpose |
|------|---------|
| `read-data/dictation.mjs` | The cleaning steps and `clean`, `biasPrompt`, `wordChanges` and `learnChanges`, `insertText`, `keyMachine`, `recordDictation`, `modelStep`, and `dictationTools.dictate`. The named exports `dictate` and `typeDictatedText` are what `run-an-export.mjs` calls. |
| `read-data/dictation.json` | The pipeline, spoken commands, styles, learning limits, the bias prompt, the clipboard commands, the key table, the history limits, the model steps' words and every sentence said. |
| `tool-rows.json` | `tool:dictate` (`change-a-folder`): every action except insert. `tool:type-dictated-text` (`change-a-folder`, `type-into-the-front-app`): the clipboard transaction. Both read `{ input, folder }` on standard input. |
| `part.json` | Nothing here is imported by other code. |
| `test/dictation.test.mjs` | The old app's tests, repointed to this folder. |
| `test/tool-rows.test.mjs` | The rows' capabilities and the two exports over a granted folder. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `clean` | `(text, { settings, rows, context }) => { text, applied, skipped }` | Runs the pipeline in data order. An unknown step is skipped and named. |
| `insertText` | `(text, { settings, run, pause, entryId }) => outcome` | Save, write, paste, restore (in `finally`), verify. A clipboard that holds something other than text is left alone, and nothing is pasted. |
| `learnChanges` | `(rows, changes, settings, now) => rows` | A change seen `promote_after` times becomes active. A row the person taught is never overwritten. |
| `keyMachine` | `(keys, handlers, { now, stillDown }) => { event, tick, running }` | Push-to-talk holds, hands-free toggles, and a lost key-up or a too-long run is stopped. |
| `dictate` / `typeDictatedText` | `({ input, folder }) => answer` | The rows' entries. Both refuse without a granted folder. |

## Moved from Trillion

`computer/dictation.mjs`, `computer/dictation.json` and `test/dictation.test.mjs` of Trillion-X/trillion (deleted there in `dc79bb0a`), moved one to one. What changed:
- The rows file and the history were under `~/.trillion/dictation`. They are now in the folder the person grants: `state` is filled in by the run.
- When no model was handed in, `polish` and `command` used to import the Mac app's local model (`computer/local-models.mjs`). That import is not carried. Without a model, both leave the text as it was and say so, which is `modelStep`'s own rule.
- The two named exports were added for `run-an-export.mjs`.

## Not yet

- The `type-into-the-front-app` capability is not in the engine's `product/computer-capabilities.json`. Until the engine's owner adds it, `tool:type-dictated-text` is refused. Its sandbox rules for `pbcopy`, `pbpaste` and `osascript`, and the macOS Accessibility permission for System Events keystrokes, are measured there, not here.
- The push-to-talk and hands-free key events come from the Mac app's native layer (its Swift helper). `keyMachine` is here, but the key events are not: the Mac app stays their caller.
- `polish` and `command` have no model until one is handed in.
- Neither row has been proved end to end on the engine.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), `@noble/hashes` (BLAKE3) and Node's standard library. On a Mac, `/usr/bin/pbcopy`, `/usr/bin/pbpaste` and `/usr/bin/osascript` for typing at the cursor.

**Depended on by:** `tool-rows.json`.
