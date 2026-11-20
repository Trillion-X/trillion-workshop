# tools/check-bundle-package-boundaries/

Stops a build whose finished bundle takes a file from a package that the package has not declared public, so an app can use packages as plain libraries without reaching into their insides. Ported from the package `check-bundle-package-boundaries`.

It judges the bundler's own report (an esbuild-shaped metafile), so what is judged is exactly what ships: aliases, plugins and relative paths are already resolved. A stubbed or virtual module owns no file and is not judged. Each package says what is public in a declaration file in its own folder; the tool has no default for that file, so the person gives `declaration` (the file's name, the dotted path to the list in it, where an entry says what it is and the value that means public source, and where it names the file or folder). The declaration file itself is always public. An unreadable declaration file is a finding, never a pass. The tool names no package, host or bundler plugin.

`publicPathsOf(parsed, declaration)` is the pure declaration reader shared with other consumers. It returns an array of validated, normalized relative paths without implicitly adding the declaration file. For `{ "public": ["show/a.mjs"] }`, use `{ file: "exports.json", entries_at: "public", path_at: "" }`: an empty lens selects the entry itself. An empty `entries_at` selects a root array. Supply `kind_at` and `kind` together only when entries need a kind filter; the existing object-entry API remains valid. A missing or non-array list throws. Invalid path entries declare nothing, including traversal, absolute paths, backslashes, address schemes and control characters. This function proves neither committed authority nor regular-file existence; the consuming host owns those checks. The bundle checker still interprets declared folders as public subtrees, while a consumer requiring exact file exports can compare the returned paths for equality.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-bundle-package-boundaries.mjs` | The check: `checkBundlePackageBoundaries({ metafile, bundleRoot, packagesRoot, declaration })`. Changed from the package in one way: the declaration file's name, its entry list and entry kind were fixed words of the old runtime and are now the `declaration` input. The command-line entry is gone; the row's command replaces it. |
| `do-work/check-my-bundle.mjs` | `tool:check-a-bundle-against-package-boundaries`: the granted folder in argv, the input on standard input, `{ result }` on the last line; every path stays inside the granted folder. |
| `part.json` | The check is public, so another tool may import it. |
| `tool-rows.json` | The row. It runs on the person's computer after they grant `read-a-folder`. |
| `test/check-bundle-package-boundaries.test.mjs` | The package's three tests on made-up packages (public files, same-package and unowned edges, private reaches, namespaced absolute paths, unreadable declarations) and the required declaration. |
| `test/check-my-bundle-row.test.mjs` | The row's shape, and the command run the way the engine runs it over a made-up folder. |
| `scripts/check-bundle-part-boundaries.mjs` | Judges a finished bundle's real import graph and reports every edge where code outside a part reaches a file that part has not declared public (the form the Send to Trillion extension build uses). Moved byte for byte from trillion-apps `web/scripts/`. |
| `scripts/barrel-imports.mjs` | An esbuild plugin that turns a browser bundle's import of a part's index into imports of the files that index names. Moved byte for byte. |
| `scripts/part-side-effects.mjs` | Lets a browser bundle leave out a part's modules nothing uses. Moved byte for byte. |
| `scripts/light-theme.mjs` | The light theme's tokens as a stylesheet, read once from their one source. Moved byte for byte. |
| `test/check-bundle-part-boundaries.test.mjs` | The bundle check on made-up parts: public files, same-part edges, private reaches. Moved byte for byte. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `checkBundlePackageBoundaries` | `({ metafile, bundleRoot, packagesRoot, declaration }) -> { findings, edges_checked, packages_reached }` | Judge one bundle's real import graph |
| `publicPathsOf` | `(parsed, declaration) -> string[]` | Read validated public paths through the same declared lenses, with no I/O or implicit file export |
| `describeFinding` | `(finding, declaration) -> string` | One plain line a person can act on |
| `filePathOfBundleInput` | `(inputPath, bundleRoot) -> string \| null` | Resolve a metafile path (plain relative, or `namespace:/absolute`) to a file |
| Finding rules | `package-private-source-reached`, `package-boundary-unreadable` | An edge to an undeclared file; a package whose declaration cannot be read |

## Dependencies

**Depends on:** Node's `fs` and `path` only.

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) for its owner, with nothing more to allow (installing it or switching its job on is the one yes); the folder it works on is named in its run input at `computer.read-a-folder`.
