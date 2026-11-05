# tools/find-a-spoken-passage-in-word-times/

Work with a recording's word times. Given the first and last words of a passage someone quotes, it answers the exact second the first word starts and the last word ends, and the words between, so a plan cuts on word edges. It reads a recording's words back as timed sentences. And it writes word times in the one words-file shape (`{source, timing, words: [{text, start, end}]}`) that plans cut from, moving them by an offset when a window was heard alone.

Moved from a film's tools folder: `span.py` (step `span`), `sentences.py` (step `sentences`), and `words_home.py` with the shape half of `wordtime.py` (step `words-file`). The matching, the sentence cut and the printed lines are the old tools'. Hearing a recording is `tools/audio-transcription`'s job; this tool starts from its words.

## Files

| File | Purpose |
|------|---------|
| `do-work/word_times.py` | The command: one JSON request on standard input with `step`; `--base FOLDER` is where relative paths are read and written. Prints the old tools' lines, then `{"result": {...}}` as its last line, or `{"error": ...}`. |
| `tool-rows.json` | `tool:find-a-spoken-passage-in-word-times`, a `computer` row with `change-a-folder`, run under `tools/settings`' `run-with-settings.mjs` so `settings_record` is read through the run's records door. Three sample runs, one reading a settings row. |
| `part.json` | Nothing here is imported by other code. |
| `test/test_word_times.py` | The three word-time shapes, span matching (case, punctuation, apostrophes, `after`, refusals), the sentence cut and its window, the words-file shape, offset and rounding, and the command with a clip read from the `words_folder` setting. |
| `test/find-a-spoken-passage-in-word-times.test.mjs` | Runs those tests and checks the row. |

## The request

| Key | What it holds |
|---|---|
| `step` | `span`, `sentences` or `words-file`. |
| `words` | The word-time file: `words` of `{text, start, end}` or `{t, start, end}`, or Whisper `segments` with `words` of `{word, start, end}`. |
| `clip` | Instead of `words`: `<words_folder>/<clip>.words.json`. |
| `first`, `last`, `after` | `span`: the passage's first words, its last words (searched from the first match on), and a second to start searching from. |
| `from`, `to` | `sentences`: keep words that start in this window. |
| `source`, `out`, `offset` | `words-file`: the recording the words are of, the file to write, seconds added to every time. |
| `settings_record`, `settings` | The person's `list:settings` row for this folder (`record:setting:find-a-spoken-passage-in-word-times~<scope_kind>~<scope_id>`), and settings for this run laid over it: `words_folder`, `timing` (default `word`), `round_to` (default none; times moved by an offset are rounded to 2). |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `words_of` | `doc => [(text, start, end)]` | Reads every word-time shape. |
| `span` | `(words, first, last, after) => {start, end, text, line}` | Words compared lower-case with everything but letters, digits and apostrophes removed. |
| `sentences` | `(words, lo, hi) => [{start, end, text, line}]` | A sentence ends at a word ending in `.`, `?` or `!`; an unfinished last one has no end. |
| `words_file` | `(doc, source, timing, offset, round_to) => {source, timing, words}` | A file already in the shape passes through untouched. |

## Dependencies

**Depends on:** Python 3.10 or later and its standard library; `tools/settings` (`read-data/settings.py`, `do-work/run-with-settings.mjs`) and `tools/records-door`, which its row packs.

**Depended on by:** `tool-rows.json`. Its `words-file` output is the `clips.words_folder` shape `tools/assemble-a-plan-into-a-cut` reads.

## Invariants

- It reads only the word-time file and writes only `out`; it hears nothing.
- Nothing in the code names a person, a film or a place on a disk; a film's words folder is its settings row.
