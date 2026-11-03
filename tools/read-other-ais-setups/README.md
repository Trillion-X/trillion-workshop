# tools/read-other-ais-setups/

Lists, read only, the instruction files, slash commands and skills that other AI apps keep on the person's computer. Each one comes back as an item the person, through their AI, can bring into Trillion as a saved instruction. It runs on the person's own Mac as a `computer` row, over the home folder the person granted for reading. Nothing in those places is created, changed or removed. Moved from Trillion-X/trillion `computer/ai-setups.mjs` (deleted in dc79bb0a87; read at its parent).

## Files

| File | Purpose |
|------|---------|
| `read-data/ai-setups.mjs` | `readAiSetups` (every place in the settings, read through the file-scope reader, text cut and marked) and `read`, the tool function. Moved one to one; the only additions are the named export `read` and the import of the local file reader. |
| `read-data/ai-setups.json` | The places, as rows: single files, or a folder's entries by ending, or folders holding one entry file; with their kind, the most items, the most characters per item and the label length. Moved unchanged but for the paths it names. |
| `read-data/file-arguments.mjs` | `expandFileArguments`, carried unchanged from Trillion-X/trillion `computer/file-arguments.mjs` (alive there for the Mac host's own tool boundary). A file is read only after its real path is inside a root and no segment or ending is protected, within a byte cap. |
| `read-data/file-arguments.json` | Its settings, cut to what this tool uses: the `$file:` text prefix, the roots (`~`, the person's home), the protected names and endings (keys and credentials), the byte cap and the words. |
| `tool-rows.json` | `tool:read-ai-setups`: a `computer` row with `capabilities: ["read-a-folder"]`, run by `tools/records-door`'s `run-an-export.mjs`. The id is the one the Mac host gave it. |
| `part.json` | Nothing here is imported by other code. |
| `test/ai-setups.test.mjs` | The original listing test, repointed: each kind of place read on a made-up home, long text cut, an empty place counted, and a link out of the home folder named as unreadable. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `readAiSetups` | `(input?, { settings?, home?, scope? }) => Promise<{ items, sources }>` | `input.sources` picks place ids; an item is `{ id, source, kind, name, path, text, cut }` or `{ ..., unreadable }`. |
| `read` | `(input) => Promise<{ items, sources }>` | The tool function `tool:read-ai-setups` runs, over the person's home folder. |
| `expandFileArguments` | `(input, settings?, home?) => Promise<{ input, files, bytes }>` | Replaces each `$file:<path>` string with the file's text, or refuses in words. |

## How to run it

```
echo '{"sources":["claude-skills"]}' | node tools/records-door/do-work/run-an-export.mjs \
  tools/read-other-ais-setups/read-data/ai-setups.mjs read
```

## Not yet

- The places are under the person's home folder, so the person grants `read-a-folder` on their home folder. The engine's capabilities list has no narrower grant over several dot-folders at once, and none that names a set of files. Reading still refuses keys and credentials by name (`file-arguments.json` `protected_names`), whatever the grant allows.
- `read` takes the home folder from the system (`os.homedir()`, so `HOME`). It has not been proved on the engine that a `computer` run keeps the person's `HOME` rather than a private folder of the run.
- Saving the items is the account's job, not this folder's: `saved_instructions` with `add_instructions` (Trillion-X/trillion `src/agents.mjs`). Its add-only test was the second test of the old `test/ai-setups-import.test.mjs`. That file was deleted in dc79bb0a87, so the test has no home in either repository yet.

## Tests

```
node --test tools/read-other-ais-setups/test/ai-setups.test.mjs
```

## Dependencies

**Depends on:** `tools/records-door` (the command that runs a function), `tools/content-identity`, Node's standard library.

**Depended on by:** `tool-rows.json`.
