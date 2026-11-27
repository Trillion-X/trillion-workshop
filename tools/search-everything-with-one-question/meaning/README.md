# tools/search-everything-with-one-question/meaning/

The internal meaning and spoken-word readers of `tool:search-everything-with-one-question`. The four former search tool descriptors are removed; their exports are called by the one account-wide search. It finds the items of a person's vector set that are closest in meaning to a query, and names the file and time span each item points to. The items can be frames of their recordings, pictures or spoken lines. The ranking is the package's own code: preparation, an LSH index that narrows the candidates, exact cosine, `min_score` and the limits. The seam sends vector-bearing plans through the original scripts in bounded batches (4 MiB of plan JSON, or one larger item), applying each batch to one ANN state in source order and querying that state once. It reads bounded fact batches after the query and hands only the selected candidates to the original exact ranker. This avoids one whole-index vector JSON string without changing ANN bucket or candidate order. The descriptor's optional `search_mode` selects `approximate` (the existing default) or `exact`. Exact mode feeds every stored .npy vector through that same scorer without making an LSH index or encoding a whole vector plan; text without stored vectors uses the existing bounded embedding/fact batches and then the same iterable scorer. Scores, canonical qualification, floor and total order remain the package's. The new code is only the Workshop seam. The seam reads the person's index descriptor and vector set at run time, from the records and files the caller hands in (no store is read).

| Internal export | Package action | Query |
|---|---|---|
| `findSimilarVector` | `action:find-similar-vector` | `query_vector_base64`: base64 of JSON `{"vector": [...]}`, made by the model the descriptor names. For a set of picture vectors, `tool:words-as-picture-vector` turns words into one. |
| `findSimilar` | `action:find-similar` | `query_text`, embedded by the descriptor's model at its `model_endpoint` (the package's Ollama embedder) |

Both take an optional `spread: { per_file, seconds_apart }` so many neighbouring frames of one take do not fill the answer: the package ranks up to the descriptor's `result_limit`, then, best first, an item is set aside when its file already has `per_file` items in the answer or one closer than `seconds_apart` to it (an item with no time counts once per file), and the rest is cut to `limit`. Scores and order stay the package's; `result.spread` says how many were set aside.

`tool:make-a-picture-vector-set-of-my-videos` makes such a set on the person's own computer (`do-work/make_picture_vector_set.py`, below).

| Entry | Seam export | What it does |
|---|---|---|
| `findSimilarAcross` | `findSimilarAcross` | The same query vector over several descriptors (`index_ids`), merged best first. Approximate mode keeps its existing descriptor candidate pool. Exact mode supplies all qualified canonical candidates to the shared merge before its direct-search result cap, so even a cluster larger than that cap cannot hide the next distinct file. The merge applies `spread` and the requested final `limit` to the global ranked list. Descriptors of different models are refused. |
| `findWordsSaid` | `findWordsSaid` | The lines of the descriptors' sets whose `points_to.text` field says every word of `query_text` longer than two letters (case ignored), in the order the sets hold them, at most `limit` (8). No model. |
| `tool:make-a-vector-set-from-picture-vectors-my-apps-kept` | `do-work/make_vector_set_from_kept_vectors.py` | On the person's computer: an asset index of CLIP matrices (with readable names), a folder of timed frames, and an app's results store of timed frames (with each video's namespace id) each become `items.jsonl`, `vectors.npy` and `vector-set.json`. |

A descriptor's `result_limit` still caps a direct search and supplies its default aggregate result size when no limit is asked. It is not a candidate-pool cap for exact aggregation: the explicitly requested aggregate limit applies after global ranking and spread. Approximate mode retains its existing pool limits. Only qualified score/provenance metadata and file/time points pass into the exact collector; vectors stay in the reader.

A descriptor's `points_to` may name `carry`: item fields (a readable name, an id in another app) that an answer's `points_to` and a words answer pass through as the item holds them.

## Files

| File | Purpose |
|------|---------|
| `do-work/process-scripts/` | The package's process scripts: `prepare-semantic-index-process-input.mjs`, `ann-index.mjs`, `nearest-embedding-facts.mjs`, `embed-text-ollama.mjs`, `pyjson.mjs`, `make-embedding-facts-from-command-output.py`, and their tests `canonical-multihash.test.mjs` and `test_make_embedding_facts.py`. `ann-index.mjs` adds `apply-batches`, a bounded-input driver over the same ordered mutation function that clones and writes the compact state once. Its mutation loop reuses the private subject dictionary and transient membership sets for the persisted ordered bucket arrays, avoiding repeated full-map enumeration and growing bucket scans; `applyPlan` still clones caller input before mutation. `canonical_multihash.mjs` has one change: it takes BLAKE3 from `tools/content-identity` and checks the canonical `1f:<64 lowercase hex>` form directly. |
| `read-data/meaning-search.mjs` | The seam: `findSimilarVector` and `findSimilar`. It runs the scripts in the order the package's actions ran them, then applies a `spread` when one is asked for (`spreadItems`). |
| `do-work/search-kept-vector-sets.mjs` | The existing CLI's local compatibility entry. Given ordered converted-set metadata, saved query vectors and optional transcript lines on standard input, it calls `findSimilarAcross` and `findWordsSaid`, returning the earlier seen/said JSON envelope. Store readers and ranking stay in their owners. |
| `do-work/process-scripts/float32-dot-products.py` | One optional NumPy arithmetic primitive for already-normalized source vectors. Receives a dimensions/row-count header and float32 binary vectors; returns float32 binary scores. Reads no store and performs no ranking. Explicit descriptor `similarity: "float32-dot"` retains the source arithmetic and unrounded scores, and `tie_order: "source"` retains source order for ties. The default remains cosine with six-decimal scores and canonical tie order. |
| `do-work/make_picture_vector_set.py` | Builds a picture vector set from a folder of videos: one frame every `--every` seconds (2), key frames only, small, an optional `--lut` (log footage) and `--proxy` (a smaller copy on the same timeline, a pattern with `{dir}` and `{stem}`), CLIP ViT-B-32 openai (`--model`, `--pretrained`). Writes `frames.npy` (float16, normalised), `frames.jsonl` (`video`, `path`, `t`, `decoded`), `done.json` (resumable: a run goes on where the last stopped, a new folder adds only its videos) and `vector-set.json` (the descriptor's `vector_set` member and the model). Needs ffmpeg, numpy, torch, open_clip_torch and Pillow. |
| `do-work/make_vector_set_from_kept_vectors.py` | Ported from a film repository's `tools/clip-search/q.py` (5a9ba39), the part that read its stores (`ports/make-vector-set-from-kept-vectors.json`): `--out DIR [--asset-index DIR] [--ssd-index DIR] [--expansion-results FILE] [--namespace FILE] [--kind video\|image\|all]`. Opens sources read-only; writes one set per store: `items.jsonl` (`path`, `kind`, `t` or null, and `name`, or `id` and `b2`), `vectors.npy` (float32, preserving the source-compute values) and `vector-set.json` with `points_to.carry`. Assets and results are normalized once in float32 as the source did; timed frames pass through as float32 without another normalization. No lower-precision cast is added. Its `vector-set.json` also carries `search_mode: "exact"`, which callers must keep with `vector_set` when writing the descriptor, because the source searched every vector. Needs numpy. |
| `read-data/meaning-search.json` | The record kind of the descriptors, the read span, the indexing batch byte bound, and the names the package writes facts under. |
| `what-this-tool-does-and-how-to-run-it.json` | Two builder rows. The search exports take the descriptor records and read the vector set files from the values the account-wide search is handed, and change nothing. `tool:make-a-picture-vector-set-of-my-videos` and `tool:make-a-vector-set-from-picture-vectors-my-apps-kept` run the builders on the person's computer. |
| `test/meaning-search.test.mjs` | Synthetic vector sets through a stand-in set of handed-in values. Covers ranking, half-precision vectors, `min_score`, the package's refusals, spoken lines embedded by a stand-in model, the spread, the builder on solid-colour videos with a stand-in picture model (frames and times, resuming, the proxy) and its set searched by the seam, the package's Python test and the rows. |
| `test/kept_vectors_check.py` | The converter run as the person runs it on a made-up asset index, timed frames, results store and namespace store: normalising, the names, `--kind`, a short frames file cut, the wrong-sized vector skipped, the `b2` id, the stores only read, no store refused, exact source-compute vector values, and a near-ranking precision regression through the existing scorer. |
| `test/synthetic_picture_set.py` | Makes the solid-colour videos and runs the builder with a stand-in model (a frame's mean colour). |

| `test/nearest-embedding-facts.test.mjs` and `test/fixtures/nearest-facts-baseline.json` | Captured synthetic old-CLI output bytes and stdout; the refactored CLI and iterable/direct-row scorer must retain qualification, floor, tie order and caller immutability. |

## Key Types / Functions

| Name | Shape | Role |
|---|---|---|
| descriptor record | kind `semantic-index-descriptor`: `{ index_id, model_id, model_version, model_endpoint, descriptor_revision, model_provenance_ref, min_score, result_limit, ann_params: { hyperplane_count, table_count, seed, candidate_limit }, vector_set }` | The package's descriptor, kept in the person's own records. `vector_set` supplies the files; optional `search_mode: "exact" | "approximate"` chooses full-vector scoring or the existing LSH candidate search. |
| `vector_set` | `{ items: { file }, vectors?: { file }, points_to: { file, start?, end?, text?, carry?: [field] } }` | `items` is JSON lines, one item per line. `vectors` is a 2-D little-endian float `.npy` matrix (16, 32 or 64 bit); row i is the vector of line i. `points_to` names the item fields. Without `vectors`, each item's text is embedded by the descriptor's model. |
| item address | `<items file>#<line>` | The package's content and canonical address. Payload hash is the BLAKE3 identity of the line. Revision is the identity of the line plus its vector bytes. Source snapshot is the identity of both files. |
| answer | `{ index_id, result: { items: [{ address, score, revision, payload_hash, ... }], considered, skipped, min_score }, model_id, model_version, points_to: { [address]: { file, start, end, text, ...carried } } }` | What the package's actions answered, plus `points_to`. An answer across indexes has `index_ids` and the merged items. |

## Invariants

- Every ranking decision is the package's. The seam only reads the descriptor and the files it is handed, builds the package's index plan, filters the embedding facts to the ANN candidates (the record-store query the package's workflow made) and maps each answer address back to its item.
- Scores compare only vectors from the model the descriptor names. A query vector of another length scores -1 and never passes `min_score`.
- In approximate mode the index is built from the vector set on every run and is not kept afterwards; exact mode skips it and scores the full vector set with the same ranker. The vector set is read every run anyway, so the index is always current, and the package's readiness check has nothing to check.
- The seam names no person, drive, model or index. All of these are the descriptor's DATA. The internal search exports read descriptor records and files and write nothing. The builder names only its default model (CLIP ViT-B-32 openai, changed with `--model` and `--pretrained`) and writes only into the `--out` folder; the videos, the LUT and the proxy pattern are arguments.

## Not ported

These parts of the package only commit to or read from the retired record store. The seam does their job, or nothing needs them here. Since the package's repository was retired (bitfield-packages d926b7adb8), its originals are kept here byte for byte (`from-bitfield-packages/moved-from.json`, `ports/from-bitfield-packages-*.json`), run by no row; a file ending `.held` is kept as it was and not run as a test:

- `apply-semantic-index-plan.py` and `envelope_write_set.py`: the atomic Envelope write. Here the index lives for the run. `make-embedding-facts-from-command-output.py` plus `ann-index.mjs --mode apply-plan` is the same composition.
- `assert-semantic-index-readiness` (`.mjs` and `.py`), `plan-capability-index-convergence.py`, `resolve-ranked-current-items.py` and `hydrate-ranked-current-item.py`.
- The Python twins of the ported `.mjs` scripts (`ann-index.py`, `canonical_multihash.py`, `embed-text-ollama.py`, `nearest-embedding-facts.py`, `prepare-semantic-index-process-input.py`) and their parity tests (`test-*-parity.mjs`), which prove the `.mjs` scripts give the Python ones' bytes.
- `show/` (the media search screen, now `tools/show-the-media-library-and-search-what-was/packages/meaning-search/show/`) and the package's workflow file.

Until 2026-11-15 these originals sat in a second folder, `tools/meaning-search`, restored there from the package with an older copy of this folder's seam and four rows (`tool:find-similar-to-a-vector`, `tool:find-similar-by-meaning`, `tool:find-closest-across-my-indexes`, `tool:find-words-said-in-my-recordings`) that this folder had already folded into `tool:search-everything-with-one-question`. That folder is gone; its originals are here.

## Dependencies

**Depends on:**
- `tools/workflows` (`do-work/run-a-function.mjs`, the runner of the parent's rows that run no other tool) and `tools/records-door` (`run-an-export.mjs`, for the two rows whose host runs the picture query encoder);
- `tools/content-identity` (BLAKE3);
- Node, and Python 3 for `make-embedding-facts-from-command-output.py` (standard library only);
- for `findSimilar`, an Ollama-compatible endpoint the run can reach;
- for `do-work/make_vector_set_from_kept_vectors.py`, Python 3 with numpy on the person's computer;
- for `do-work/make_picture_vector_set.py`, ffmpeg, numpy, torch, open_clip_torch and Pillow on the person's computer.

**Depended on by:** the account-wide search in the parent owner; the builder rows in `what-this-tool-does-and-how-to-run-it.json`.
