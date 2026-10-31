# workflows

Shared playbooks that any person's AI can follow step by step. Each playbook is a row of the person's list of workflows (its steps are rows of their list of workflow steps); the public ones are published into `published/` and made into `recipes/workflows.json`; the workflow engine that runs them is arriving here from `crates/workflow-engine` in the main Trillion repository.

## Files

| File | Purpose |
|------|---------|
| `read-data/recipe-problems.mjs` | The recipe validator: `recipeProblems(row)` names every problem with a `workflow-recipe` row at once (id, job, input schema, steps, tool calls and pins, checks, actor policy, or a written `definition`). A recipe with no problems can be run by any account. |
| `recipe-check-kinds.json` | The check vocabulary as DATA: the roots a path may start at, the catalogs `exists` may name, and one row per check kind with its meaning, the fields it takes (shape, required, refusal words) and any one-of rule. Adding a check kind is adding a row here; no code edit. |
| `test/recipes.test.mjs` | Runs `recipeProblems` over every `records[].payload` in every `recipes/*.json` and expects none; also proves a check kind added only as a row in a copy of the vocabulary is accepted, and it refuses a step with no `do`, a repeated step id, a check that reads a later step, a check that reads a field its schema does not declare, and a bad id with no job. |
| `published/workflows.json`, `published/workflow-steps.json` | The public view of each list, written by `tool:publish-a-list-view-as-a-file` and never edited by hand: `{ schema, source: { view, list, blake3 }, fields, rows: [{ id, values }] }`. A recipe row holds its label, id, job, what a run makes, the ids it was made from and its input schema, source and wakes as JSON text; a step row links to its recipe and holds its order, `do` and its schema, checks, tool and actor policy as JSON text, because a row holds no nested value. |
| `recipes/workflows.json` | Every public recipe as `{ about, records: [{ payload }] }`: what the engine's recipe row source `source:workflow-recipes` and the validator read. Generated from the two published files; `test/recipe-rows.test.mjs` fails when it is not exactly what they make. |
| `read-data/recipe-rows.mjs` | `recipeFromRows(recipeRow, stepRows)` and `recipesFromViews(workflowsView, stepsView)`: a recipe's payload read back from its rows, from a published file or from the records door (`values` or `value`). Refuses steps that link to no recipe, a recipe with no steps and text that is not JSON. |
| `do-work/rebuild-recipes.mjs` | Makes `recipes/workflows.json` from the two published files; `--check` exits 1 when the file is not what they make. |
| `read-data/workshop-tool-ids.mjs`, `host-tools.json`, `do-work/tool-gaps.mjs` | The tool gaps: `recipeToolGaps(recipe, { known })` (in `recipe-problems.mjs`) lists the tool ids a recipe names, in `run_tool` and as `tool:<id>` in its steps, that no Workshop tool row (`workshopToolIds`) and no host tool (`host-tools.json`, DATA) offers. A gap is a warning: the recipe stays valid. `tool-gaps.mjs TOOLS_FOLDER` prints the missing tools and the recipes that wait for each. |
| `test/recipe-rows.test.mjs` | A recipe read back from its rows in any step order and from door rows; two views made into recipes, refusing a missing recipe, a recipe with no steps and text that is not JSON; `recipes/workflows.json` equal to what the published files make, every recipe in it valid; a Workshop tool, a host tool and a missing tool told apart; an id with a colon kept whole. |
| `published/tools.json`, `read-data/tool-catalog.mjs`, `do-work/publish-tool-catalog.mjs` | The Workshop's tool catalog as one file a site counts and lists tools from, never from a repository walk: one flat row per tool (title, job, description, status, maker, licence class, placements, listed on, folder, flags), in the list-view file shape with a BLAKE3 key. Generated from the tool folders' `tool-rows.json`, which stay the one source (a tool row is the contract of the code beside it); schemas and how a tool runs are left out. `node tools/workflows/do-work/publish-tool-catalog.mjs tools` (from the repository root) writes it, `--check` fails when it differs; see "Keeping the tool catalog current". |
| `test/tool-catalog.test.mjs` | The committed file equals what the rows make and holds one row per tool; a row holds flat facts only; rows a tool-row-source lists belong to the folder that lists them; the key is the content identity (`tools/content-identity`) and does not depend on read order. |
| `do-work/checklist_gate.py` | The checklist gate's command line: `gate`, `answer`, `answers-from-report`, `sweep`, `run-gates`, `run-files`, `scope`, `audit` and `checklist` (`--check`, `--write`, `--problems`). Every command takes `--library DIR --schema FILE`; all but `sweep`, `run-gates`, `run-files` and `checklist` hold the library lock. |
| `read-data/gate_library.py` | Reads the schema (a `$ref {file, path}` value is replaced by the value at that path in that file, so a setting that has an owner is read from its owner), the lock, BLAKE3 of bytes and files, and the small helpers the others share. |
| `read-data/gate_pieces.py` | A piece and its items: header tags, route expressions, the piece's own config, the files each item is judged on, their BLAKE3 pins (cached by path, size and change time), the flags an item's files prove, per-file media scoping. |
| `read-data/gate_answers.py` | The append-only answers file, who may answer what (a checker's or gate's name is refused to a person), the reviewed pin a machine row must carry, staleness, advisory rows, rebuilds of a picked item, and the gate itself. |
| `read-data/gate_reports.py` | A checker's JSON report recorded check by check (only for a check whose pin is the reviewed one), and the sweep that runs the checker over a folder of items. |
| `read-data/gate_runs.py` | Runs the schema's gate commands over a folder's items or single files and records their rows under each gate's own name and pin. |
| `read-data/gate_audit.py` | Which items a gate must cover (latest round plus live picks), and the audit of watch folders, with optional hold to a held-back folder. |
| `read-data/checklist_rows.py` | The checklist document generated from the person's own text by the schema's `checklist_source`, its comparison with the file on disk, and its problem list. |
| `test/bakery.py`, `test/test_checklist_gate.py`, `test/checklist-gate.test.mjs` | A made-up bakery library (checklist text, rule source, schema, a stand-in checker and gate) and 46 tests of every command through the command line; the `.mjs` runs them under `npm test`. |

## Keeping the tool catalog current

`published/tools.json` is derived from every folder's `tool-rows.json`, so any tool that lands makes it stale. It is therefore regenerated as part of the push, not by each tool's author: on the exact tip it is about to push, the pusher runs, from the repository root,

```
node tools/workflows/do-work/publish-tool-catalog.mjs tools
```

and, when `git status` shows `tools/workflows/published/tools.json` changed, commits that file alone as the last commit of the push. `test/tool-catalog.test.mjs` then holds that tip to the file (it fails when the committed file is not what the rows make), so a lane's own commits never need to touch it. The same holds for `recipes/workflows.json`, which comes from the two published workflow files (`node tools/workflows/do-work/rebuild-recipes.mjs`, `--check` to verify).

## Recipe shape

A recipe in `recipes/workflows.json` is `{ payload }` in `records`. The payload is a `workflow-recipe` row: `kind`, `id` (`workflow:` then lowercase words and dashes), `label`, `job`, `source` (where the playbook came from and which of its parts were not adopted, and why), `input_schema` (a JSON Schema with `"type": "object"`), and `steps`. Each step has `id`, `title`, `do` (what to do, naming the exact tool, address or screen and the exact input), `submit` (a JSON Schema for what the step hands back) and `checks` (rules that must hold before the step counts as done; the kinds are the rows of `recipe-check-kinds.json`).

A recipe names no person, product, keyword or subreddit of its own: those are inputs.

## When a recipe runs by itself

A recipe may carry `wakes`: the causes that start a run of it, each exactly the engine's wake declaration `{ id, on, budget, input }`, the field the engine reads from every Workshop row (a listed recipe row included), and `produces`, one line saying what a run makes that could be shared. A Workshop row's wake is off for every account until the person switches it on (`wake:switch`); a person may also declare their own wake, with their own input and time zone, as a `wake-declaration` record in their own records naming the recipe id as its tool. One malformed item refuses every Workshop row's wakes, so every wake is checked here before it ships. `on` names one cause: `record` (a record of a kind, or under an id prefix, changes in `own-records`), `time` (`at_ms` once, or `every_ms` from `from_ms`, optionally in an IANA `zone` that keeps the wall-clock time; without a zone, epoch 0 was a Thursday 00:00 UTC, so a Monday 09:00 UTC weekly wake is `from_ms` 378000000), `arrival` (from a `source`) or `host_event` (a kind the computer reports, with `match` on its fields). `budget` is drawn from the person's ledger per firing. `input.start_at` is the step a woken run starts at; a later start step reads the earlier steps' outputs of the person's last run of the recipe.

| File | Purpose |
|------|---------|
| `recipe-wake-causes.json` | What the engine's wake primitive takes, as DATA: one row per cause with its fields and shapes, the resources a record wake may watch, the host event kinds and their fields, the least budget a run needs and the ledgers, each read from the engine file it names at the commit it names. A new cause is a new row. |
| `read-data/wake-problems.mjs` | `wakeProblems(wakes, { stepIds, inputFields })`: every problem with a recipe's wakes list, judged only by the rows of `recipe-wake-causes.json`; `recipeProblems` calls it and also refuses a wake without `produces`. |
| `test/recipe-wakes.test.mjs` | Every cause accepted when well formed; a start step that is not a step, an input field the recipe does not take, a time with both or neither of `at_ms`/`every_ms`, `from_ms` or `zone` without `every_ms`, a zone the time zone database does not know, an unknown cause, field or key, an unwatched resource, a host event field its kind does not report, a budget below a run's least or above its ledger, a repeated id and a missing `produces` are refused; a cause added only as a DATA row is accepted; every shipped wake together fits the engine's cap. |

A recipe row has no `invoke` of its own: `source:workflow-recipes` names `invoke_with: "tool:start-a-recipe-run"`, so the engine runs every recipe row as that tool, with `input.row` set to the recipe's id and the switch's grant being that tool's rights. A recipe's steps are work for the person's AI, so the starter does none of them: it writes one record of kind `ai-job`, id `ai-job:<recipe id>:<request key>`, holding `status: "waiting"`, the recipe id and label, its steps, the input it was started with and the wake cause. The AI that next connects to the person's records lists waiting `ai-job` records, does the oldest and writes `status: "done"` with its result. A wake's request key is its cause key, so a firing that comes again finds its job and writes nothing.

| File | Purpose |
|------|---------|
| `read-data/start-a-recipe-run.mjs` | `startARecipeRun({ input, task }, { door })`: reads the recipe named by `input.row` from the person's own list of workflows and the rows of its steps (read back by `recipe-rows.mjs`), else from `recipes/` (the person's own row wins when both hold the id), and writes its one `ai-job` record, unless that id is already there; no step loop, schedule or state of its own. |
| `tool-rows.json` `tool:start-a-recipe-run` | The container row: `run-an-export.mjs` with stdin `{ input, task }`, packing this module, `recipes/` and `records-door`; rights `records:read` and `records:write` on kind `ai-job` only, one record per write. |
| `test/start-a-recipe-run.test.mjs` | Runs the row against the records door stand-in with exactly its rights: the source names the starter, one firing writes one waiting job with the recipe's steps, input and cause, the same firing again writes nothing even after the job is done, and an unknown recipe writes nothing. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `recipeProblems` | `(row, vocabulary = CHECK_VOCABULARY) -> [string]` | Every plain-words problem with a recipe row; an empty list means the recipe is valid. A row with `definition` (engine steps and edges) is checked as a definition; otherwise its `steps` are checked one by one. |
| Step | `{ id, title, do, submit, run_tool?, checks?, actor_policy? }` | `id` is lowercase letters, numbers, dashes or underscores and unique; `do` is required; `submit` is a JSON Schema with `"type": "object"`. |
| Check | `{ kind, says, path, of?, in?, values?, words?, count?, catalog? }` | `kind` is a row of `recipe-check-kinds.json`, and the row names the other fields; paths start at `this`, `input` or `steps` and may read only earlier steps. |

## The checklist gate

A person's checklist is a JSON document `{ delivery_stages, default_delivery_stage, publish_phase, after_phase, stages: [{ id, checks: [{ id, check, routes, verify, must, per_option?, rule_id?, advisory_passes_at? }] }] }`. A piece is a folder with a header block of `key: value` tags; its items are the files the piece's globs find. The gate lists every required check of the chosen stages that applies to the piece (by route against the header tags, per-file media and the flags an item's own files prove) and has no current passing row, per item for a per-item check. Output is JSON; exit 0 passed, 1 open or failed, 2 unreadable.

Rows are lines in the piece's answers file: `{ check_id, option_id, answer, evidence, by, at, file_pins, check_pin }`. `file_pins` is the BLAKE3 of the files judged; a row on other bytes is stale. A check a checker or gate answers counts only on that checker's own row with the reviewed `check_pin`, never on a person's row. An `advisory` answer passes only at the delivery stages its check lists. A failed judgment rule on an item that rebuilds a picked item waits for the person's ruling and does not block.

The schema (JSON, `--schema`) names everything: `checklist`, `lock`, `piece` (header file and tag fields, answers file, record file, `on_first_gate` command, per-piece `config` and its defaults), `answers` (words, minimum evidence), `items` (folder patterns, media suffixes, lanes, rounds and moments, rebuild key, ruling words, proven flags, watch folders), `checkers` (answerer name, report keys and check-to-rule mapping, reviewed pins, `current_pins_command`, the sweep), `gates` (answerer name and the files that pin each), `runs` (the command per run mode; it prints as its last line `{ rows: [{ gate, answer, evidence }] }`, `{ problem }` or `{ not_measured }`), `audit` and `checklist_source` (the regular expressions that read the person's checklist text). Any value may be a `$ref`. A section a command needs and the schema lacks is refused by name.

## Dependencies

**Depends on:** `recipe-check-kinds.json` (read once when the validator loads) and the Node standard library. Kept as code: the five field shapes a row may name (`path`, `list`, `words`, `count`, `catalog`), because a new shape is a new test on a JSON value; the recipe and definition structure (`PIN`, step id patterns, actor-policy keys, `ask` and `check` step kinds), which is the engine's own closed format, not something a person extends; the recipes' steps name the tools the steps name (`tool:read-a-page-in-my-browser`, `tool:tell-the-person`), which the host offers.

**Depended on by:** nothing yet; the workflow engine will read `recipes/workflows.json` once it moves here. The list of workflows and the list of workflow steps are the person's rows in their account; the published files here are their public view, so every account gets the public workflows through the Workshop.

**The gate depends on:** python3 (standard library only) and BLAKE3 (the `blake3` python module, else the `b3sum` command; without either a file identity is refused). It imports only from this folder. It runs the commands the person's schema names (`current_pins_command`, the sweep's `batch_command`, `runs.*.command`, `on_first_gate`) and nothing else; wiring a person's own checker or gate is writing that command, not editing this code. **Depended on by:** the person's own checklist, schema and pieces, which stay with the person; the Workshop holds none.
