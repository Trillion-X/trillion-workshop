# tools/print-here/

Prints a file from the person's files on a printer their Mac already has, and says which printers it has. It runs on the person's own Mac as a `computer` row. The row holds one capability, the Mac's print system, and only while the person has granted it. `tool:print` also reads the chosen file through the local door with the run's own capability. The bytes go to the print system on standard input, and nothing is written to a folder.

## Files

| File | Purpose |
|------|---------|
| `read-data/print-here.mjs` | `printers()`: the printers and the default, from `lpstat`. `print(input, { door })`: reads the file through the door in steps and sends one job with `lp`, with the options the input gives. |
| `read-data/print-here.json` | The print commands, the option names, the door address of the files, the read step, the largest file sent and every word said. |
| `tool-rows.json` | `tool:printers` and `tool:print`. Both are `computer` rows with `capabilities: ["use-the-print-system"]`, run by `tools/records-door`'s `run-an-export.mjs`. `tool:print` also declares `records` rights: `find_file` and `read_file` over the person's files. |
| `part.json` | Nothing here is imported by other code. |
| `test/print-here.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `makePrintTools` | `({ settings?, list?, send? }) => { printers(), print(input, read) }` | Lists printers, checks the printer named, reads the file, sends one job. Each refusal says what to do. With no printer named and no default, it asks which printer instead of guessing. |
| `readWhole` | `(call, settings, file) => Promise<{ title, size, bytes }>` | Finds the file and reads every byte through the door in `read_bytes` steps. A file over `most_bytes` is not read. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs` and `door.files`), Node's standard library, and the Mac's `lpstat` and `lp`.

**Depended on by:** `tool-rows.json`. The local engine runs the rows on the person's computer (`computer` kind) after the person grants `use-the-print-system`.
