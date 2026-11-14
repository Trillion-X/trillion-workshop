# Source-rule evaluation and disk runner

The package boundary and declared checks are in the parent manifest and README.
`check-source-files-against-declared-rules.mjs` evaluates rule DATA against supplied
subjects. `run-check-source-files-against-declared-rules.mjs` discovers Git paths,
reads working-tree inputs, reports findings and decides its shell exit status.
It exports `checkRepository({repoRoot, rulesPath, under, recordedPath})`, which returns
`{summary, failed}` (`summary` is the `--json` document) and throws `RunRefusal` where the
CLI exits 2, so a consumer in another node process calls it in place instead of launching
the CLI. Paths come from one `git ls-files -t --cached --others --exclude-standard`
launch (`repositoryPaths`); `--under` narrows that listing in process. On 2026-10-27 each
launch on this Mac waited 0.35-2 s for exec admission while git itself worked about 2 ms.
`read-source-file-in-repository.mjs` exports `readSourceFileInRepository`: a
snapshot reader that refuses aliases/special files for content or regular-file
custody. Pure name inspection does not open asset payloads. Unstable inputs
return no source body.

`write-control-bytes-as-escapes.mjs` and its runner repair literal control bytes.
`lift-reader-notes-out-of-package-data.mjs` moves reader notes out of machine DATA.
These tools do not authorize source relocation, package imports or publication.
Dependencies are Node built-ins; the pure rule engine is this package's existing
source. Source path custody regressions live in `../tests/source-path-custody.test.mjs`.
