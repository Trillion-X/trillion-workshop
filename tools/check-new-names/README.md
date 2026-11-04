# tools/check-new-names/

Refuses a commit or a push that brings in a folder or file name a new reader cannot point at: a codename (`s2h`), a status (`legacy_kept`), a time, or a technical metaphor (`native_boot`, `body_custody`). A plain name (`record_store`) and the name of an outside thing (`postgres`, a file format) pass. Which words and patterns fail, which outside names pass and which repositories are judged are the caller's rules, never this tool's: the person keeps them in the check row that runs it.

Only names a change brings in are judged: each file it adds or renames, and each folder of that path its base tree did not hold. A name already in the repository is not judged again until a change moves it, so renaming old names is its own work and never blocks other commits.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-new-names.mjs` | `judgeNames({ root, span, rules })` and its command line: `--root CHECKOUT (--staged \| --range FROM..TO \| --for-command COMMAND) --rules-json RULES`. `--for-command` judges what the command would publish (a `git commit` the staged index, a `git push` the commits since HEAD left origin/main; anything else nothing). Exit 0 passes, 2 refuses with the names, words and reasons on stderr, 1 could not judge. |
| `test/check-new-names.test.mjs` | Throwaway repositories: the four failing kinds and the passing names, a folder already there left alone, a rename judged, a repository the rules do not name left alone, and the command line refusing a commit and staying silent for any other command. |
| `ports/check-new-names.json` | The claim that no older owner did this job, with the searches that found none. |

## Rules

```json
{
  "repositories": ["owner/name"],
  "words": [{ "why": "a status, which changes while the name stays", "words": ["legacy", "kept"] }],
  "patterns": [{ "why": "a codename: letters and digits run together", "pattern": "^(?=[a-z0-9]*[a-z])(?=[a-z0-9]*[0-9])[a-z0-9]+$" }],
  "passes": ["blake3", "postgres"]
}
```

A name is read as words: split at `-`, `_`, `.` and spaces and where lower case meets upper case, lower-cased, a file's extension left out. A word in `passes` is never refused; otherwise the first word listed in `words`, or matching a `patterns` row, fails the name with that row's `why`.

## Run by a check row

The person's check list holds a row of type `record:hook-guard` whose `workshop_run` starts this tool for every `git commit` and `git push` an AI is about to run (`tools/check-every-tool-call` picks and runs it), with the rules inline:

```json
["node", "{tools}/check-new-names/do-work/check-new-names.mjs", "--root", "{repository}", "--for-command", "{tool_input.command}", "--rules-json", "..."]
```

## Dependencies

**Depends on:** Node.js and git.

**Depended on by:** the person's check row, through `tools/check-every-tool-call`.
