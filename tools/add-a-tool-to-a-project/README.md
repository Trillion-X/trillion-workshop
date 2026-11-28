# tools/add-a-tool-to-a-project/

`tool:add-a-tool-to-a-project` copies one tool folder, and every folder it needs, into a project at the exact commit a
pointer names, at the place the project's own layout wants it. After the copy the folder is the project's: a person or
an AI reads and edits it like the rest of the project's code. A later sync (`tool:keep-tool-copies-in-step`) merges
three ways from the record this tool writes.

## The folder contract

No folder name is fixed. The project keeps one record, `where-each-tool-comes-from.json`, wherever it wants it; each
copy lives at the place its record line names (`at`). For example, a Next.js project:

```
<project>/
├── package.json
├── src/components/ui/ui/                 a copy added with into src/components/ui (its line's at)
└── lib/tools/
    ├── where-each-tool-comes-from.json   the record: one line per copy, wherever it lives
    └── <folder>/                         a copy added with no into: beside the record
```

- The record is found from git's list of the project's files (tracked, and new ones not ignored: `read-data/record.ts`
  `recordPlace`); the project is a git folder. Two record files in one project are refused (`bad-place`).
- A project with no record gets one at `record_at` (a folder inside it), else at its top.
- `into` names the folder a new copy goes in (`<into>/<folder>`); without it, the copy goes beside the record.
- A needed folder the record already names is found at its recorded `at`, wherever that is.

A record line (keyed by the folder's name):

| Field | Meaning |
|---|---|
| `at` | where the copy lives: its folder relative to the project's top, never climbing out, never absolute; every line has one |
| `from` | `{registry, tool}`, `{repo, path, commit}`, or `"made-here"`; `registry` and `repo` are addresses every computer can reach (an https, ssh or git address), never a file path |
| `synced` | `true` for a copy a sync keeps in step; `false` is a deliberate fork |
| `copied_at_commit` | the source commit the files came from |
| `copied_at_files_blake3` | the manifest identity of the files (`tools/content-identity/read-data/manifest.mjs`): BLAKE3 of the JSON text of `{path: BLAKE3 hex}`, keys in byte order, bare 64 hex |
| `needs_tools` | the folders this folder needs, each found at its own line's `at` |
| `closure_blake3` | the manifest identity of `{folder: copied_at_files_blake3}` over this folder and every folder it reaches through `needs_tools` |
| `files` | path (relative to the folder) to BLAKE3 hex, for every file that came from the pointer |

## How it runs

1. The pointer is read: from a registry (`tools-in-this-registry.json`: `repo`, `path`, `commit`, `files_blake3`,
   `needs_tools`, and `paths` when only some files of a large folder are taken), or given directly as `{repo, path, commit}`.
   Without `from`, the registry the record names (`registry`, set on the first registry add) is read.
   `from` may be a local folder or file (read here), a git repository address (`.git`, ssh or `user@host:path`: its
   default branch's `tools-in-this-registry.json`, read by a depth-1 fetch), or an https address of the file. What the
   record keeps is always an address: a local folder is recorded as its git `origin` address (`read-data/registry.ts`
   `addressOf`), and a local registry or direct repo with no origin is refused `bad-from`, as is an https address
   carrying a user or password. A registry address that a folder in `clones` has as its origin is read from that folder.
2. Each folder of the set is taken once per (repo, commit). When a folder named in `clones` (a local git clone inside the
   granted folder) already holds the commit (`git cat-file -e`), the run's own repository borrows that clone's objects
   (git alternates) and nothing goes over the network; the clone is only read. Otherwise, or when the clone lacks some
   of the folder's contents, it is a depth-1, blob-less fetch. Then a sparse checkout of only the folder and `git archive`
   of its files, read by the content-identity owner. The identity must equal the pointer's `files_blake3`; a commit id
   names every file in it, so the files and the record are the same bytes whichever way they came.
3. The needs of a folder are DATA: the registry pointer's `needs_tools` and the card's `needs_tools`. A direct pointer's
   needs are the sibling folders of the same commit. Needs that loop copy each folder once.
4. The folders are written to a staging folder beside the record, then, holding the record's lock, moved to their `at`
   and the record is written by rename (compare-and-set on the record's BLAKE3).
5. Each new folder's card `prepare` (a list of words: a program and its arguments) runs in the folder, needs first.
   What it makes is never in `files`.
6. The answer's `import_map` is the TypeScript `paths` entries that reach every recorded copy by its import name:
   `"trillion-workshop/tools/<folder>/*": ["./<at>/*"]` (`read-data/record.ts` `importMapOf`). A bundler (Next.js,
   tsc) resolves a copy anywhere through them. Node itself resolves a bare import only through a package's `exports`,
   whose targets must stay inside that package's folder, so a copy that Node loads natively (not bundled) stays inside
   the folder of the package that maps it.

The card is `what-this-tool-does-and-how-to-run-it.json` and nothing else; its top-level `prepare` and `needs_tools` are
the two facts read. A folder whose card still has the old name `tool-rows.json` is refused (`old-card-name`), naming the
folder.

## Invariants

- The run holds `use-git-in-a-folder` on the granted folder: the same folder for change, plus starting the system git that reads
  a clone or fetches the pinned commit. Under `change-a-folder` alone the sandbox grants no git, so every add was refused
  at its first git call (the same cause `tool:keep-tool-copies-in-step` was fixed for in Workshop 72d6aeb8f).

- All or nothing: one refusal in the set writes nothing.
- Nothing is overwritten: the same pointer is `already`; an edited copy is refused with a unified diff
  (`edited-copy`); another version from the same source is refused (`other-version-present`: that is a sync);
  another source's folder of the same name is refused (`name-clash`) unless `as` names the new folder.
- Writes stay inside the project, at each line's `at` and in the record's folder; the project must be inside the granted
  folder; names and places never climb, are never absolute and never pass through a link (`bad-place`).
- The record holds no path of the computer that wrote it: it travels in the project's git, so registries and repos are
  named by reachable addresses and each copy by its `at`, relative to the project's top; the absolute anchor of the
  project lives only in each computer's own settings (`test/project-record-has-no-absolute-path.test.mjs`).
- The code names no package ecosystem: making a folder ready is its card's `prepare`.

## Refusals

`edited-copy`, `other-version-present`, `name-clash`, `not-in-registry`, `tool-not-found-at-commit`,
`identity-mismatch`, `record-changed-meanwhile`, `bad-from`, `bad-card`, `old-card-name`, `fetch-refused`, `bad-place`. Each carries `said`, the plain
reason; `edited-copy` also carries `diff`.

## Files

| File | Purpose |
|---|---|
| `do-work/add.ts` | `add(input)`, the CLI `node do-work/add.ts add GRANTED-FOLDER < input.json` |
| `read-data/registry.ts` | `readRegistry(from, clones)`, `checkPointer`: the pointer shape; `addressOf`, `isReachableAddress`: the address a record keeps |
| `read-data/fetch-folder.ts` | `FetchedCommit`: one commit per (repo, commit), borrowed from a local clone that holds it or fetched; `folder(path, paths)`; `objectsHolding(clone, commit)` |
| `read-data/record.ts` | `readProjectRecord`, `writeProjectRecord` (lock, compare-and-set, rename); `recordPlace`, `recordPlaceIn` (the project's one record); `placeOf` (a place inside the project); `importMapOf` |
| `read-data/card.ts` | `cardFacts`: `needs_tools` and `prepare` from the card |
| `read-data/diff-text.ts` | `unifiedDiff` for the edited-copy refusal |
| `test/*.test.ts` | `node --import ./test-helpers/own-tmpdir.mjs --test tools/add-a-tool-to-a-project/test/*.test.ts` |
