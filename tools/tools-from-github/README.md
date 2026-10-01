# tools/tools-from-github/

Open-source repositories on GitHub offered as tools: when an AI asks Trillion for a job (captions, transcription, a cutout), it finds the repository here, and Trillion hands back how to get it and run it on the person's own computer. Trillion runs none of this code.

## Files

| File | Purpose |
|------|---------|
| `sources.json` | One row per repository: `repo`, the `job` it does, `install` and `run` commands (`{input}` and `{output}` stand for the person's files), what it `needs`, and, when GitHub names no licence, which licence file to read and what it must say. Edit this to add a repository. |
| `index-github-tools.mjs` | Reads each repository's licence, description and activity from GitHub and writes `tool-rows.json`. `--check` says whether the kept rows still match GitHub. |
| `tool-rows.json` | Made by `index-github-tools.mjs`, never by hand: one row per repository, on `placement:caller-sandbox`, with where and when each fact was read. |
| `test/index-github-tools.test.mjs` | Every source became one row whose licence a class lists for the person's computer; a licence is read, never guessed. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `indexRow` | `(source, github, { classes, licence, read_on }) => row` | The row one repository makes. |
| `licenceOf` | `(source, github, get) => Promise<{ spdx, read_from }>` | GitHub's licence id, or the licence file's, after reading it. |
| `indexRows` | `({ sources?, get?, now? }) => Promise<row[]>` | Reads GitHub for every source. |
| `asRecords` | `(rows) => { records: [{ payload }] }` | The shape `tool-rows.json` keeps. |

## Usage

```sh
# after adding a row to sources.json
node tools/tools-from-github/index-github-tools.mjs
node tools/tools-from-github/index-github-tools.mjs --check
```

## Dependencies

**Depends on:** GitHub's public API, and `licence-classes.json` at the top of this repository.

**Depended on by:** Trillion, which reads `tool-rows.json` like every other folder's rows.
