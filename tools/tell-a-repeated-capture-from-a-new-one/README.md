# tools/tell-a-repeated-capture-from-a-new-one/

Says whether a captured text (screen words, a transcript) was already seen, exactly or nearly, before it is kept or uploaded, so reading the same thing twice costs nothing. Erasing a span of time also forgets what was seen in it, so an erased capture can never hide a later real one. It runs on the person's own computer as a `computer` row that asks for no capability: it reads no file, no screen and no network, only the text and the memory it is given.

## Files

| File | Purpose |
|------|---------|
| `read-data/capture-dedupe.mjs` | `normalise`, `exactOf` (BLAKE3 of the normalised text), `simhash` (64-bit SimHash from BLAKE3 words), `distance`, `createDedupe` (the bounded two-tier memory), and `dedupe(input)`, the row's function. |
| `read-data/capture-dedupe.json` | Normalisation, shingle size, `near_bits`, `least_words_for_near`, `most_entries` and `remember_seconds`. |
| `tool-rows.json` | `tool:capture-dedupe`: a `computer` row with `capabilities: []`, run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/capture-dedupe.test.mjs` | The original Trillion tests (exact, near, short texts, erase, age, bound, SimHash distance, the memory surviving a restart as JSON). |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `createDedupe` | `(settings, start = []) => { seen(text, at), erase(from, to), size(), entries() }` | Exact tier first; the near tier only for texts of at least `least_words_for_near` words. Pruned by age and count on each `seen`. |
| `dedupe` | `({ action: 'seen' \| 'erase', text?, at?, from?, to?, entries? }) => { duplicate, of } \| { forgotten }` plus `entries` | The row's function: builds the memory from `entries`, answers, and gives the memory back as `entries`. |

## Moved from Trillion

`computer/capture-dedupe.mjs` and `computer/capture-dedupe.json` (deleted in Trillion-X/trillion dc79bb0a87), with their tests from `test/capture-categories.test.mjs`. The code is the same, except that the Mac app kept the memory in a file under the person's home folder (`memory_file`); here the memory is the caller's, given as `entries` and answered as `entries`, so the run writes nothing.

## Not yet

- Nothing. The row asks for no capability the engine does not list.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), `@noble/hashes` (BLAKE3), Node's standard library.

**Depended on by:** `tool-rows.json`. Nothing imports this folder.
