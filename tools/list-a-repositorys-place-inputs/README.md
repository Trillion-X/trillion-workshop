# List a repository's place inputs

Lists the named environment and place-report inputs read by tracked Python, shell, and JavaScript code. Moved one to one from the film repository's `tools/place-capabilities/list_inputs.py`; the repository is now an argument. It reports input names and reader files, with run switches listed separately. Environment values are never emitted.

Run `python3 read-data/list_inputs.py --root /path/to/repository` for the original Markdown table, add `--missing` for unset place inputs, or `--json` for structured output. JSON contains `inputs` with `name`, `files`, `run_switch`, and `set`. The original built-in system-variable exclusions and run-switch names remain. Its tracked-code scope and frozen-record/test exclusions remain; this is a source-pattern scanner, so dynamic variable names and unsupported languages are outside its scope.

The Workshop computer tool reads the repository folder granted by the person and returns JSON. It needs Python 3 and Git. It neither executes repository code nor writes files. The folder must belong to a Git checkout; Git failures are reported rather than silently treated as an empty inventory.

Run `node --test tools/list-a-repositorys-place-inputs/test/*.test.mjs`. Four Python tests cover original patterns, tracked-file selection, paths with spaces, output formats, missing filters, and suppression of environment values.
