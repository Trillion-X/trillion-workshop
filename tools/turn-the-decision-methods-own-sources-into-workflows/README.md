# Turn retained sources into steps

This owner qualifies exact source pins and explicit workflow steps before measuring a supplied source inventory. It imports the existing public `sweepAtoms` from `check-against-a-persons-rules-and-verdicts`, whose original source port and callers already exist. It uses the current workflow step validator and content identity owner. The held originals in `from-an-older-version/` remain evidence.

The coverage input is a JSON object with three independent current readbacks:

- `sources`: source rows with `id` and `identity` (the original source bytes' BLAKE3 `1f:` identity).
- `pieces`: rows with unique `id`, `source_id`, `source_identity`, exact `text`, `identity` (BLAKE3 of exact UTF-8 `text`), and `location` (file and line, video and second, or page). A piece may carry `no_check: {reason, piece_identity, covered_by?: [step ids]}`. A reason must explain why no instruction is required and pin the exact piece identity it was judged against; whitespace alone and stale pins are refused.
- `steps`: canonical explicit step rows, with `came_from` listing piece IDs and `source_versions` mapping those IDs to their exact piece identities. `source_versions` pins derivation evidence; it does not replace `came_from` or create another source store.

The step anatomy validator checks structure, not whether a teaching was understood. A second AI must judge derived instructions against the actual source quote, using the existing workflow judgement owner. A coverage pass means every supplied piece has a structurally explicit linked step or a recorded reason; it does not prove the supplied piece list includes every page of a book or every video in a channel. Readers must supply the complete source inventory and preserve their own completeness evidence.

When adapting `documents-as-list-rows` `atomsOf`, preserve its upstream identity separately and calculate the coverage piece identity from exact `atom.text`: the existing atom identity deliberately normalizes whitespace. Do not relabel that normalized identity as exact bytes. Keep the original source byte identity on the source and `source_identity` on every piece.

Private source text stays in the caller's account. Public tests use synthetic material. No account, connector, private source, or list is written by a measurement.

## Run and read the result

```sh
node tools/turn-the-decision-methods-own-sources-into-workflows/do-work/measure-source-coverage.mjs < manifest.json
```

The command prints one JSON object and exits 1 for any gap or invalid input, 0 when no structural gaps are found in the supplied inventory. `gaps` names exact source/piece/step IDs and causes; `sources` retains per-source counts. `scope: "supplied_inventory"` and `inventory_completeness: "not_established"` explicitly leave whole-source extraction/completeness unproven; arbitrary locations and caller-provided pins do not establish that evidence. A step with any missing, stale or invalid cited piece qualifies none of its links. The tool descriptor is `tool:measure-source-coverage` and takes the same JSON object without account or network access. `qualification: "structural"` and `semantic_verification: "not_established"` prevent interpreting an anatomy pass as semantic correctness or actual execution.

The canonical recipe is `tools/workflows/recipes/turn-a-source-into-steps.json`, identity `workflow:turn-a-source-into-steps`. The existing starter reads it from its canonical folder and saves its steps as a task. Those instructions call for a discovered authorized `reader: {tool_id, input}`, complete reader inventory, source-linked steps, current branch placement, independent authenticated judgement, saved-row readback and coverage measurement. The starter queues these instructions; it does not invoke the reader or coverage command, enforce distinct actors or prove any step ran. Reader access, semantic judgement and actual native registration/execution remain separate from recipe admission and the synthetic starter proof.

`test/source-coverage.test.mjs` covers rejected blank/stale reasons, broken links, modified bytes, empty inventories, valid many-to-many links, cross-step machine checks, normalized upstream atom identities, CLI exit status and canonical starter readback/retry. It uses synthetic source text only and verifies the exported sweep is the same imported function as its public owner. A mismatched source byte readback qualifies neither steps nor reasons. Native registration, real source completeness and semantic execution remain separate delivery checks.
