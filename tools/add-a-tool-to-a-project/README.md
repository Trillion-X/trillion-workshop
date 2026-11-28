# tools/add-a-tool-to-a-project/

`tool:add-a-tool-to-a-project` copies one tool folder, and every folder it needs beside it, into a project's own
`trillion/` folder, at the exact commit a pointer names. After the copy the folder is the project's: a person or an AI
reads and edits it like the rest of the project's code. A later sync (`tool:keep-tool-copies-in-step`) merges three ways
from the record this tool writes.

## The folder contract

```
<project>/
├── package.json
└── trillion/
    ├── where-each-tool-comes-from.json   the record: one line per folder below
    └── <folder>/                         one copied tool folder, exactly the pointer's files
```

A record line (keyed by the folder's name):

| Field | Meaning |
|---|---|
| `from` | `{registry, tool}`, `{repo, path, commit}`, or `"made-here"`; `registry` and `repo` are addresses every computer can reach (an https, ssh or git address), never a file path |
| `synced` | `true` for a copy a sync keeps in step; `false` is a deliberate fork |
| `copied_at_commit` | the source commit the files came from |
| `copied_at_files_blake3` | the manifest identity of the files (`tools/content-identity/read-data/manifest.mjs`): BLAKE3 of the JSON text of `{path: BLAKE3 hex}`, keys in byte order, bare 64 hex |
| `needs_tools` | the folders this folder needs beside it under `trillion/` |
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
4. The folders are written to a staging folder under `trillion/`, then, holding the record's lock, moved into place and
   the record is written by rename (compare-and-set on the record's BLAKE3).
5. Each new folder's card `prepare` (a list of words: a program and its arguments) runs in the folder, needs first.
   What it makes is never in `files`.

The card is `what-this-tool-does-and-how-to-run-it.json` and nothing else; its top-level `prepare` and `needs_tools` are
the two facts read. A folder whose card still has the old name `tool-rows.json` is refused (`old-card-name`), naming the
folder. (This tool's own card is still `tool-rows.json` until the Workshop renames every card in one change.)

## Invariants

- The run holds `use-git-in-a-folder` on the granted folder: the same folder for change, plus starting the system git that reads
  a clone or fetches the pinned commit. Under `change-a-folder` alone the sandbox grants no git, so every add was refused
  at its first git call (the same cause `tool:keep-tool-copies-in-step` was fixed for in Workshop 72d6aeb8f).

- All or nothing: one refusal in the set writes nothing.
- Nothing is overwritten: the same pointer is `already`; an edited copy is refused with a unified diff
  (`edited-copy`); another version from the same source is refused (`other-version-present`: that is a sync);
  another source's folder of the same name is refused (`name-clash`) unless `as` names the new folder.
- Writes stay under `<project>/trillion/`; the project must be inside the granted folder; names and paths never climb.
- The record holds no path of the computer that wrote it: it travels in the project's git, so registries and repos are
  named by reachable addresses and each folder by its name under the project's tools folder; the absolute anchor of that
  folder lives only in each computer's own settings (`test/project-record-has-no-absolute-path.test.mjs`).
- The code names no package ecosystem: making a folder ready is its card's `prepare`.

## Refusals

`edited-copy`, `other-version-present`, `name-clash`, `not-in-registry`, `tool-not-found-at-commit`,
`identity-mismatch`, `record-changed-meanwhile`, `bad-from`, `bad-card`, `old-card-name`, `fetch-refused`. Each carries `said`, the plain
reason; `edited-copy` also carries `diff`.

## Files

| File | Purpose |
|---|---|
| `do-work/add.ts` | `add(input)`, the CLI `node do-work/add.ts add GRANTED-FOLDER < input.json` |
| `read-data/registry.ts` | `readRegistry(from, clones)`, `checkPointer`: the pointer shape; `addressOf`, `isReachableAddress`: the address a record keeps |
| `read-data/fetch-folder.ts` | `FetchedCommit`: one commit per (repo, commit), borrowed from a local clone that holds it or fetched; `folder(path, paths)`; `objectsHolding(clone, commit)` |
| `read-data/record.ts` | `readProjectRecord`, `writeProjectRecord` (lock, compare-and-set, rename) |
| `read-data/card.ts` | `cardFacts`: `needs_tools` and `prepare` from the card |
| `read-data/diff-text.ts` | `unifiedDiff` for the edited-copy refusal |
| `test/*.test.ts` | `node --import ./test-helpers/own-tmpdir.mjs --test tools/add-a-tool-to-a-project/test/*.test.ts` |
