# tools/check-every-claim-against-its-facts-and-sources/

Checks every claim a narrator makes, spoken or on screen, against the person's own facts (their world rows) and the sources they cite, before the line is voiced or rendered. A claim that fails is cut or rewritten with real support; nothing is fixed by adding a hedge or an attribution. Everything that belongs to a person (their world, their sources, their rule words, the subject's and narrator's names, their hedge phrases) is input or their settings; nothing about anyone is in this folder.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | Two rows, both `on-your-computer`: `tool:check-every-claim-against-its-facts-and-sources` and `tool:make-plain-text-extracts-of-claim-sources`. |
| `do-work/check_claims.py` | The check: one JSON request on stdin, one JSON answer as the last line (Request below). |
| `do-work/make_source_extracts.py` | `{"sources": file}` on stdin: writes each source's plain-text extract from its raw file (html, fdc-json, new-order, copy). |
| `read-data/claim_gate.py` | `Config`, `Gate` (every rule below) and `check(config, shot id)`. |
| `read-data/world_rows.py` | `World` (the world rows), `quote_problem` (a fact's words at its transcript second or file line), `verify` (the world's own check), `resolve` (paths, with `path_map`). |
| `test/test_claim_check.py` | 32 tests on a made-up world: the old fact gate's 7 regression tests one for one, every other rule, the world check, both commands, refusals (a row for another tool, a retired row), settings over the row, the settings wrapper. |
| `test/fixture_world.py` | The made-up world, sources, scripts, shots and claims the tests build in a temporary folder. |
| `test/check-every-claim.test.mjs` | Runs the Python tests under `npm test` and checks the rows name scripts that exist. |

## Request

```json
{"shots": ["open-1", "open-2"],
 "lane_dir": "<folder with shots/, claims/ and the voice scripts the shots name>",
 "sources": "<the sources file>",
 "frames_root": "<the folder a claim's frame path is relative to>",
 "world_dir": "<the world rows: lists.json, rows/<list>.json, relations.json>",
 "hedge_phrases": ["the words of the person's no-hedge check row"],
 "settings_record": {"id": "record:setting:check-every-claim-against-its-facts-and-sources~film~<film>", "type": "record:setting", "value": {...}},
 "settings": {"narrator_name": "an object laid over the row's settings (optional)"},
 "path_map": {"<a path prefix written on another computer>": "<the same folder here>"},
 "check_world": true, "quiet": false}
```

- A shot is `{"voice": {"script": path}, "events": [...]}`; every event's `text` and `caption`, and each `figure`'s label, formatted value and sub line, are on-screen texts.
- A claims file is `{"voice": [entry per spoken sentence], "screen": [entry per on-screen text]}`. An entry has `words` (or `text`), `kind` (`claim`, `quote`, `label`, `no-claim`), and for a claim: `facts`, `sources` (`{source, quote}`, `{transcript, at_s, quote}` or `{frame, observed, shown}`), `considered` (`{fact id: why}`), `topics`, `numbers` (`{spoken, value | expr + inputs | role, why}`), `compare` (`{says, left, op, right, inputs}`) and `strength` (`{phrase: the support key that says it as strongly, or "wording: why"}`).
- The world's own check runs first (`check_world: false` skips it); when it fails, every shot fails with its problems.
- A missing script, claims or source file is a failure of that shot, not a crash.

Answer: `{"result": {"ok", "shots": [{"id", "ok", "fails", "notes", "lines"}], "world": {"ok", "lines"}}}`, exit 0 when every shot passes and 1 when one fails; `{"error": "what to change"}`, exit 2. Each shot's report lines also go to standard error.

## Rules

The person's settings row (`list:settings`, `record:setting:check-every-claim-against-its-facts-and-sources~<scope_kind>~<scope_id>`) holds:

- `rules`: `strength` (scales of words by level), `bind_from_level`, `qualifiers` (how far a spoken number may sit from its value, and which words set a bound), `subject_words` (words that make a line about the subject), `support_said_by_not` (who does not count as support: the narrator), `no_claim.imperative_verbs`, `labels`, `accounting_skips`, `auto_topic_kinds`, `fillers`, `tense_markers`, `claim_fact_kinds`, `claim_said_by`, `compounds`, `quantity_units`, `same_quantity_unit` and `unit_clause_breaks`. `test/fixture_world.py` `RULES` is a complete made-up example.
- `subject_name` and `narrator_name`: the words the reports use for them.
- `hedge_row`: how the reports name the no-hedge check row.

The row is read with the one shared reader, `tools/settings/read-data/settings.py` `request_settings`: `settings_record` is the row as `records:read` gives it (its `settings` as JSON text or an object), its value, or a file of it, and the request's own `settings` object lays over it. A row written for another tool, or `retired`, is refused. A request that names only the row's id is run under `tools/settings/do-work/run-with-settings.mjs --folder check-every-claim-against-its-facts-and-sources`, which reads it through the records door; without the wrapper an id is refused, so a named row is never silently ignored.

## Where it came from

Ported one to one from a film repository's `narrator/tools/fact_gate.py` (its tests are `test_fact_gate.py`'s seven, on made-up data) and `fact_sources.py`, with the parts of its world graph (`World`, `quote_problem`, `verify`) the gate used. The folders it read from where it sat are request fields, its rules file is the person's settings, the subject's and narrator's names are settings words and the hedge phrases come in the request. New: `path_map`, and a missing file is a failed shot instead of a crash. On every shot of the film's six lanes, the old gate and this check gave the same answer.

## Dependencies

**Depends on:** Python 3 standard library; `tools/settings` (`read-data/settings.py`, and `do-work/run-with-settings.mjs` with Node when the request names a row's id).

**Depended on by:** nothing in this repository; the rows run the two commands.
