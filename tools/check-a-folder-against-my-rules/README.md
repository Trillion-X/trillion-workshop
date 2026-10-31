# tools/check-a-folder-against-my-rules/

Checks the source files of a project folder against rules a person wrote down, and says which files break which rule, where and why. The rule is DATA: the checker names no rule, no product and no path, it is given rules and files and returns findings. Whether a finding fails a build is the caller's decision. Ported from the package `check-source-files-against-declared-rules`; the engine and the custody reader are unchanged.

This is a different job from `tools/judge-words`. That tool judges the words a person reads and any JSON, item by item, against rows of its own grammar. This one judges files: a rule covers files by path, applies when the text holds or lacks something, divides the text by a pattern the rule gives (a line, a paragraph, a block), forbids and requires patterns together, exempts by values collected from the same text, and may judge the file's NAME against the names of every file in the folder. None of that is a word row, and a rule here compares a whole folder with a written baseline in both directions.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-source-files-against-declared-rules.mjs` | The engine: pure functions over `(rules, files)`. No disk, no discovery. Copied unchanged. |
| `do-work/read-source-file-in-repository.mjs` | The reader: a file is read only when no part of its path is a link and it is a regular file that did not change while it was read. Copied unchanged. |
| `do-work/run-check-source-files-against-declared-rules.mjs` | The disk half: lists the folder's files (git's listing when the folder is a repository, every file otherwise, skipping `.git` and `node_modules`), reads what a rule covers, and answers with findings, coverage, the recorded-set comparison and the zero-baseline state. `checkRepository` is the one call. Changed from the package: no package-set identity, no collection of rules from a tree of manifests, rules given as a list or a file, and a folder-walk when git cannot list. |
| `do-work/check-my-folder.mjs` | `tool:check-a-folder-against-my-rules`: the granted folder in argv, `{ rules, under?, recorded? }` on standard input, `{ result }` on the last line. |
| `do-work/write-control-bytes-as-escapes.mjs` | Writes a raw control byte as the escape that means the same character, only when putting the escapes back reproduces the file and Node still parses it. Copied unchanged. |
| `do-work/run-write-control-bytes-as-escapes.mjs` | The same repair over paths named on the command line. Changed only in its help text. |
| `do-work/repair-control-bytes-in-my-folder.mjs` | `tool:rewrite-control-bytes-as-escapes`: names files inside the granted folder, refuses links and paths that leave it. |
| `part.json` | `do-work/check-source-files-against-declared-rules.mjs` is public, so another tool may import the same engine. |
| `tool-rows.json` | The two rows. Both run on the person's computer: reading the folder needs the `read-a-folder` grant, the repair needs `change-a-folder`. |
| `test/*.test.mjs` | The package's tests for the engine, the reader, the folder run and the repair, on made-up rules and folders; `check-my-folder-rows.test.mjs` runs both commands the way the engine does. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Rule | `{ id, why, scope: { path_matches, path_excludes }, applies_when, subject: { named }, violation: { unit: { split }, forbidden, required, exempt }, message }` | One rule. `forbidden` and `required` mean AND across a list; `exempt` means OR. A pattern is a string, `{ pattern, flags }` or `{ collected: { pattern, capture } }`. |
| Finding | `{ rule_id, path, line, evidence }` | `line` is 1-based, or `null` for a whole-file finding. |
| `violationsInFile` / `violationsAcrossFiles` | `(rule(s), path, text, alsoGiven?) -> Finding[]` | The judgement, with extra named subjects the caller holds. |
| `reportByRule` | `(rules, findings) -> [{ rule_id, why, violations }]` | Findings grouped under each rule's `why`. |
| `differenceFromRecorded` | `(found, recorded, scannedPaths?) -> { appeared, fixed, unverified }` | A recorded set is a ratchet: something new and something repaired but still written down both fail. |
| `checkRepository` | `({ repoRoot, rules \| rulesPath, under?, recorded \| recordedPath? }) -> { summary, failed }` | The whole folder check. Throws `RunRefusal` where it cannot report honestly. |

## Dependencies

**Depends on:** nothing (Node 24 in the engine's run; git is used when it is there).

**Depended on by:** `tool-rows.json`. The local engine runs the rows on the person's computer (`computer` kind) after the person grants `read-a-folder` (and `change-a-folder` for the repair).
