# tools/print-here/

Prints a file from the person's files on a printer their Mac already has, and says which printers it has. It runs on the person's own Mac as a `computer` row. The row holds one capability, the Mac's print system, and only while the person has granted it. `tool:print` is given the chosen file's bytes in `stored.files`, read by the caller from the person's own files. The bytes go to the print system on standard input, and nothing is written to a folder.

## Files

| File | Purpose |
|------|---------|
| `read-data/print-here.mjs` | `printers()`: the printers and the default, from `lpstat`. `print(input, effects)`: takes the file from `input.stored.files` and sends one job with `lp`, with the options the input gives. |
| `read-data/print-here.json` | The print commands, the option names, the largest file sent and every word said. |
| `tool-rows.json` | `tool:printers` and `tool:print`. Both are `computer` rows with `capabilities: ["use-the-print-system"]`, run by `tools/workflows`'s `run-a-function.mjs`. `tool:print` takes `stored.files` as input and reads no door. |
| `part.json` | Nothing here is imported by other code. |
| `test/print-here.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `makePrintTools` | `({ settings?, list?, send? }) => { printers(), print(input, effects?) }` | Lists printers, checks the printer named, reads the file, sends one job. Each refusal says what to do. With no printer named and no default, it asks which printer instead of guessing. With `effects` (`handoff_id`, `recordEffect`), the job is journaled before it is sent: a finished one answers its receipt, one that may have started is refused and never sent again. |
| `fileGiven` | `({ file, stored }, settings) => { title, size, bytes } \| null` | The file `file` names, from the bytes the caller handed in `stored.files` (text or base64). A file over `most_bytes` has `bytes: null`; a file not handed in is `null`. |

## Merged from Trillion

Trillion's Mac kept its own copy of these two tools (`computer/print-here.mjs`, same ids). This folder's code was kept: it calls the print commands by absolute path, asks which printer when there is no default, and reads the file in capped steps. Trillion's copy alone journaled each job by its hand-off (`recordEffect`), so that was folded in here, with its two tests.

## Dependencies

**Depends on:** `tools/workflows` (`run-a-function.mjs`), Node's standard library, and the Mac's `lpstat` and `lp`.

**Depended on by:** `tool-rows.json`; the Trillion Mac app's tool host (`computer/mac-tools.json` in Trillion-X/trillion), which runs `printers` and `print` on placement:your-computer and hands `print` the file's bytes and its effect journal. The local engine runs the rows on the person's computer (`computer` kind) after the person grants `use-the-print-system`.
