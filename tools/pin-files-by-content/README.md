# tools/pin-files-by-content/

Keeps a folder's pin file in step with its files. For each file a program reads from the folder (an engine's product data files, for example), the pin file records the byte count and the BLAKE3 hash, so the program can refuse a file whose bytes changed after it was pinned. `check` says which pins are stale, missing or left over. `write` brings the pins up to date with the files.

The same folder holds the two other checks that bind evidence to exact bytes:

- `do-work/verify-source-spans.mjs` checks that each quote is still the literal text at the UTF-8 byte range recorded for it, in a source whose BLAKE3 is the one pinned.
- `do-work/verify-writing-profile.mjs` checks prose against the person's own writing rules and against review evidence bound to its current bytes.

## Running it

```
node tools/pin-files-by-content/do-work/pin-files.mjs (check | write) --root DIR --pin-file PATH --folder PATH [--match GLOB] [--unpinned-ok PATH ...] [--shape FILE]
```

- `--pin-file` and `--folder` are paths under `--root`. `--root` is the repository, or the folder the person granted.
- Every file under the folder is pinned. Folders whose names start with `.` are skipped.
- `--match` keeps only the files whose path under the folder matches a glob. In the glob, `*` stays inside one folder and `**` crosses folders.
- `--unpinned-ok` names a file under the folder that is never pinned (a `package.json` that only marks a module root, for example). Repeat it for more files.
- The command prints `{ ok, pinned, added, changed, gone, unchanged, written }`.
  - `added`: files that have no pin.
  - `changed`: files whose path, byte count or hash differs from their pin.
  - `gone`: pins whose file no longer exists.
- Exit codes:
  - 0: the pins match the files, or `write` updated them.
  - 1: `check` found a difference.
  - 2: a path or the pin file could not be read. The reason is on standard error.

## The pin file

Its shape is DATA: `read-data/pin-shape.json`, or the file that `--shape` names. When no shape is given:

```json
{ "files": { "<path without extension>": { "path": "<path under the folder>", "pin": { "bytes": 1234, "blake3": "<64 hex>" } } } }
```

| Shape key | Holds |
|---|---|
| `entries_at` | The key the entries are under. |
| `path_key`, `pin_key`, `bytes_key`, `hash_key` | The keys inside an entry. |
| `strip_extension` | Whether the entry's name is the path without its extension. |
| `hash_form` | `hex` writes the bare hex that `b3sum` prints. `identity` writes the content-identity form, `1f:` followed by the hex. |
| `indent` | The spaces the JSON is indented with. The file always ends with a newline. |

When `write` updates the pins:
- Every other key in the pin file stays as it was.
- Entries keep their order, and new entries follow in name order, so only the lines of what changed differ.
- It writes nothing when `check` would pass.

Measured 2026-10-30 on an engine repository's 55 product data files:
- `check` agreed with `b3sum` and with the committed pins.
- A pin that was changed and then rewritten came out byte for byte the same as the committed file.

## Checking quotes against their sources

```
node tools/pin-files-by-content/do-work/verify-source-spans.mjs --data bindings.json --out readback.json
```

The bindings manifest:

```json
{ "schema": "source-span-bindings-v1",
  "sources": [{ "id": "s1", "path": "/absolute/path/source.txt", "blake3": "<64 hex>" }],
  "quotes": [{ "id": "q1", "source_id": "s1", "text": "the quoted words", "byte_start": 120, "byte_end": 136 }] }
```

- Each source is read once and hashed. A source that is missing, whose hash differs, or that is not valid UTF-8 fails, and so does every quote from it.
- Each quote must equal the literal slice of its range: no normalisation and no offset repair. A mismatch reports `literal_present_elsewhere` when the text occurs elsewhere in the source. A range that splits a UTF-8 character fails as `quote_splits_utf8`. A byte order mark is kept as a character.
- The readback names sources and quotes by their zero-based positions only, never their paths, ids or bodies. It records `input_blake3`, the BLAKE3 of the manifest bytes read. It is created with mode 600 and never replaces an existing file.
- Exit codes: 0 passed, 1 failed, 2 invalid manifest or unreadable input.
- `literalPieces(text, sourceBytes)` (exported) finds the longest runs of a text's words that occur in the source in the source's order, with their byte ranges, and lists the words it cannot find.

This is literal evidence only. It does not authenticate a speaker, a fact or a meaning.

## Checking prose against its writing rules

```
node tools/pin-files-by-content/do-work/verify-writing-profile.mjs --document prose.md --profile rules.json [--reviews reviews.json] --out report.json
```

The profile (`writing-profile-v1`) is the person's own DATA:

| Key | Holds |
|---|---|
| `rejections`, `superseded_terms` | `{ id, text, authority: any non-empty provenance label, scope?: document \| heading }`. Matching ignores case, width, punctuation, soft hyphens and inline emphasis, and it matches whole words only. A refused row is reported as `invalid_rule` with its `list`, `rule_index` and `field` (`row`, `id`, `text`, `authority` or `scope`), never its words. |
| `protected_literals` | Text that must appear unchanged in the visible prose. HTML comments are not visible. |
| `required_section_order` | ATX headings that must each occur exactly once, in this order. |
| `required_components`, `component_coverage_mode`, `component_coverage_components`, `component_requirements` | Source components a review must tie to literal source and destination quotes. With `explicit_disposition_v1`, each named component needs a `represented`, `partial` or `not_represented` disposition. Anything other than `represented` is a failure. |
| `original_sources` | `{ blake3, authority }` for the sources a component may cite. |

The review manifest (`writing-review-v1`) is bound to `document_blake3` and to each paragraph's BLAKE3. A paragraph whose bytes changed needs a new review. Component evidence is checked with the span verifier above.

The report status is one of:
- `checks_satisfied`: no findings.
- `review_required`: only unreviewed paragraphs or components.
- `known_failure`: a rejected wording, a changed literal, a section fault or failed evidence.
- `invalid`: the input has a fault, and the report names its kind.

The report omits bodies and caller names, records the BLAKE3 of the profile and of the reviews, and never replaces an existing file. Exit codes: 0 `checks_satisfied`, 1 `review_required` or `known_failure`, 2 `invalid`. Zero findings is not proof of meaning, voice, completeness or approval.

## Files

| File | Purpose |
|---|---|
| `read-data/pins.mjs` | `pinFiles(...)`: the check and the write. |
| `read-data/pin-shape.json` | The default shape of a pin file. |
| `do-work/pin-files.mjs` | The pin command line. |
| `do-work/verify-source-spans.mjs` | `verifySourceSpans(manifest)`, `literalPieces(text, bytes)`, `hashBuffers(buffers)` (BLAKE3 through `tools/content-identity`), and the span command. |
| `do-work/verify-writing-profile.mjs` | `verifyWritingProfile(bytes, profile, reviews)`, `normalizeWriting`, `writingBlocks`, and the writing command. |
| `test/pin-files-by-content.test.mjs` | Added, changed and gone pins, the kept keys and order, a shape as DATA, the root check and the exit codes, on a made-up app's settings. |
| `test/verify-source-spans.test.mjs`, `test/verify-writing-profile.test.mjs`, `test/hash-buffers-and-commands.test.mjs` | Spans, writing rules, review and component evidence, the commands' reports and refusals, and the BLAKE3 checked against Python's `blake3` when it is installed, on made-up text. |

## Dependencies

**Depends on:** Node and `tools/content-identity` (BLAKE3, with `@noble/hashes`).

**Depended on by:** `tools/workflows/recipes/set-up-a-checked-repository.json`; the writing check uses the span check.
