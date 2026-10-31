# tools/check-bundle-package-boundaries/

Stops a build whose finished bundle takes a file from a package that the package has not declared public, so an app can use packages as plain libraries without reaching into their insides. Ported from the package `check-bundle-package-boundaries`.

It judges the bundler's own report (an esbuild-shaped metafile), so what is judged is exactly what ships: aliases, plugins and relative paths are already resolved. A stubbed or virtual module owns no file and is not judged. Each package says what is public in a declaration file in its own folder; the tool has no default for that file, so the person gives `declaration` (the file's name, the dotted path to the list in it, where an entry says what it is and the value that means public source, and where it names the file or folder). The declaration file itself is always public. An unreadable declaration file is a finding, never a pass. The tool names no package, host or bundler plugin.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-bundle-package-boundaries.mjs` | The check: `checkBundlePackageBoundaries({ metafile, bundleRoot, packagesRoot, declaration })`. Changed from the package in one way: the declaration file's name, its entry list and entry kind were fixed words of the old runtime and are now the `declaration` input. The command-line entry is gone; the row's command replaces it. |
| `do-work/check-my-bundle.mjs` | `tool:check-a-bundle-against-package-boundaries`: the granted folder in argv, the input on standard input, `{ result }` on the last line; every path stays inside the granted folder. |
| `part.json` | The check is public, so another tool may import it. |
| `tool-rows.json` | The row. It runs on the person's computer after they grant `read-a-folder`. |
| `test/check-bundle-package-boundaries.test.mjs` | The package's three tests on made-up packages (public files, same-package and unowned edges, private reaches, namespaced absolute paths, unreadable declarations) and the required declaration. |
| `test/check-my-bundle-row.test.mjs` | The row's shape, and the command run the way the engine runs it over a made-up folder. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `checkBundlePackageBoundaries` | `({ metafile, bundleRoot, packagesRoot, declaration }) -> { findings, edges_checked, packages_reached }` | Judge one bundle's real import graph |
| `describeFinding` | `(finding, declaration) -> string` | One plain line a person can act on |
| `filePathOfBundleInput` | `(inputPath, bundleRoot) -> string \| null` | Resolve a metafile path (plain relative, or `namespace:/absolute`) to a file |
| Finding rules | `package-private-source-reached`, `package-boundary-unreadable` | An edge to an undeclared file; a package whose declaration cannot be read |

## Dependencies

**Depends on:** Node's `fs` and `path` only.

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) after the person grants `read-a-folder`.
