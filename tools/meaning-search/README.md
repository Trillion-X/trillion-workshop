# tools/meaning-search/

meaning-search, packaged as Workshop tools. It finds the items of a person's vector set that are closest in meaning to a query, and names the file and time span each item points to. The items can be frames of their recordings, pictures or spoken lines. The ranking is the package's own code, copied unchanged: preparation, an LSH index that narrows the candidates, exact cosine, `min_score` and the limits. The new code is only the Workshop seam. The seam reads the person's index descriptor and vector set at run time, through the door the run is handed.

| Row | Package action | Query |
|---|---|---|
| `tool:find-similar-to-a-vector` | `action:find-similar-vector` | `query_vector_base64`: base64 of JSON `{"vector": [...]}`, made by the model the descriptor names. For a set of picture vectors, `tool:words-as-picture-vector` turns words into one. |
| `tool:find-similar-by-meaning` | `action:find-similar` | `query_text`, embedded by the descriptor's model at its `model_endpoint` (the package's Ollama embedder) |

## Files

| File | Purpose |
|------|---------|
| `do-work/process-scripts/` | The package's process scripts, copied unchanged: `prepare-semantic-index-process-input.mjs`, `ann-index.mjs`, `nearest-embedding-facts.mjs`, `embed-text-ollama.mjs`, `pyjson.mjs`, `make-embedding-facts-from-command-output.py`, and their tests `canonical-multihash.test.mjs` and `test_make_embedding_facts.py`. `canonical_multihash.mjs` has one change: it takes BLAKE3 from `tools/content-identity` and checks the canonical `1f:<64 lowercase hex>` form directly. |
| `read-data/meaning-search.mjs` | The seam: `findSimilarVector` and `findSimilar`. It runs the scripts in the order the package's actions ran them. |
| `read-data/meaning-search.json` | The record kind of the descriptors, the files door read operation, the read span, and the names the package writes facts under. |
| `tool-rows.json` | The two rows. They run through `tools/records-door`'s `run-an-export.mjs`, list descriptor records and read the person's files, and change nothing. |
| `part.json` | Nothing here is imported by other code. |
| `test/meaning-search.test.mjs` | Synthetic vector sets through a stand-in door. Covers ranking, half-precision vectors, `min_score`, the package's refusals, spoken lines embedded by a stand-in model, the package's Python test and the rows. |

## Key Types / Functions

| Name | Shape | Role |
|---|---|---|
| descriptor record | kind `semantic-index-descriptor`: `{ index_id, model_id, model_version, model_endpoint, descriptor_revision, model_provenance_ref, min_score, result_limit, ann_params: { hyperplane_count, table_count, seed, candidate_limit }, vector_set }` | The package's descriptor, kept in the person's own records. `vector_set` is the only new field. |
| `vector_set` | `{ items: { file }, vectors?: { file }, points_to: { file, start?, end?, text? } }` | `items` is JSON lines, one item per line. `vectors` is a 2-D little-endian float `.npy` matrix (16, 32 or 64 bit); row i is the vector of line i. `points_to` names the item fields. Without `vectors`, each item's text is embedded by the descriptor's model. |
| item address | `<items file>#<line>` | The package's content and canonical address. Payload hash is the BLAKE3 identity of the line. Revision is the identity of the line plus its vector bytes. Source snapshot is the identity of both files. |
| answer | `{ index_id, result: { items: [{ address, score, revision, payload_hash, ... }], considered, skipped, min_score }, model_id, model_version, points_to: { [address]: { file, start, end, text } } }` | What the package's actions answered, plus `points_to`. |

## Invariants

- Every ranking decision is the package's. The seam only reads the descriptor and the files, builds the package's index plan, filters the embedding facts to the ANN candidates (the record-store query the package's workflow made) and maps each answer address back to its item.
- Scores compare only vectors from the model the descriptor names. A query vector of another length scores -1 and never passes `min_score`.
- The index is built from the vector set on every run and is not kept afterwards. The vector set is read every run anyway, so the index is always current, and the package's readiness check has nothing to check.
- Nothing here names a person, drive, model or index. All of these are the descriptor's DATA. The rows read descriptor records and files and write nothing.

## Not ported

These parts of the package only commit to or read from the retired record store. The seam does their job, or nothing needs them here:

- `apply-semantic-index-plan.py` and `envelope_write_set.py`: the atomic Envelope write. Here the index lives for the run. `make-embedding-facts-from-command-output.py` plus `ann-index.mjs --mode apply-plan` is the same composition.
- `assert-semantic-index-readiness`, `plan-capability-index-convergence.py`, `resolve-ranked-current-items.py` and `hydrate-ranked-current-item.py`.
- The Python twins of the ported `.mjs` scripts and their parity tests. These stay in the package, and they prove the `.mjs` scripts byte-identical to the Python ones.
- `show/` (the media search screen) and the package's workflow file.

## Dependencies

**Depends on:**
- `tools/records-door` (`run-an-export.mjs`, and `door.files` for the files door);
- `tools/content-identity` (BLAKE3);
- Node, and Python 3 for `make-embedding-facts-from-command-output.py` (standard library only);
- for `tool:find-similar-by-meaning`, an Ollama-compatible endpoint the run can reach.

**Depended on by:** the rows in `tool-rows.json`.
