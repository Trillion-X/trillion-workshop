# tools/answer-questions-about-many-states/

Asks one fixed set of questions about many states (lines, records, messages), in bulk, with a questions-first classifier on the person's own Mac. The questions are run once as a cached prefix, and the states are batched against that cache on Apple's GPU through MLX. Each state gets, for each question, the classifier's probabilities over the question's options.

The model is data, handed in with each request. A model's value names the classifier family (`classifier`) and where the weights are (`weights`: a local folder, or a Hugging Face repo at a pinned revision). The question set, the settings and the states are handed in too: the person's AI reads them from the person's lists and passes them in, and puts the answers it gets back wherever it wants them. The tool reads and writes none of the person's records and keeps nothing in a folder. This folder holds only code: it names no model, person, book or voice.

The first family is `questions-first-decider`: a Qwen3.5 hybrid (gated delta-net layers plus gated full attention) trained to answer a prefix of questions (`decider.schema(questions).batch(states)`). The active batched forward in `read-data/mlx_decider_core.py` is ported from the captured `MlxDecider` source at `ports/source-baselines/answer-questions-about-many-states/decide_in_batches_on_mlx.py.held`. It uses the package's raw-weight loader and prompt/tokenizer owners, with facades for the source's zero-centred norm, attention cache, gated-delta mix, indexed Metal scan and residual forward. The controller supplies the batch callbacks.

The decider's own engine is CUDA-only (CUDA graphs, flash-linear-attention), and its PyTorch fallback is a Python loop over chunks.

Current source qualification remains incomplete. The full source-first contract names the captured AICC owner and its committed byte-copy baseline. The active targets retain 136 of that source's 222 meaningful lines, meeting the repository's required 60%; the full baseline and threshold are unchanged. This line metric includes prose and does not measure executable coverage. Original-owner retirement remains unproved. The maintained consumer, `node --test test/python-profile-consumers.test.mjs`, passed all four wrappers with zero skips on frozen tree `9ea85c7ee99a0cb41855b00dbf93d3673611be3b`. Those wrappers check that all 20 numerical tests, one generated tiny-model subprocess test, five source-model tests and 11 controller tests execute without skips, through the declared `classifier` and `classifier-framework` Python profiles. The source-model tests include actual assembled answers and explicit zero-fit results. This supersedes the earlier ambient-Python result with its skipped model case. No real model-weight agreement, performance benchmark, publication or installed-runtime qualification is claimed. The earlier measurements below remain historical results from their stated builds.

## The rows

| Row | Runs on | What it does |
|-----|---------|--------------|
| `tool:get-a-classifier-ready-on-this-mac` | the person's Mac | Takes the model's value, fetches its weights (once), checks them, and names every file and the whole set by BLAKE3. The tool's bounded tree output keeps the verified model bytes in Files; the answer returns the source manifest and the exact stored file identities under `files.snapshot`. |
| `tool:answer-questions-about-many-states` | the person's Mac | Takes the model's value, the question set, the settings and the states, answers them all, and returns every state's answers in its answer. |

Both rows run `node /opt/workflows/do-work/run-a-function.mjs /opt/answer-questions-about-many-states/read-data/bulk-answer.mjs <export>`, which calls the function with the run's input and no door. On the Mac, `bulk-answer.mjs` delegates process creation to `read-data/run-classifier.mjs`, which starts `python3 -I -B do-work/run_classifier.py work` and sends it the values on standard input. The adapter preserves the established CLI actions and JSON line contract; `-B` keeps Python from writing compiled modules into the tool folder. The program answers on standard output, one JSON line per batch, and never touches the records or the disk. A stop is SIGTERM to that program, which ends after its batch; the answer then holds what finished with `status: cancelled`.

The start call answers when its run has ended, within the row's longest run of four hours.

### Inputs

```json
{
  "model":     { "classifier": "<family>", "weights": { "folder": "<folder>" } },
  "questions": { "<question id>": { "type": "choice|score|noul", "instructions": "...", "criteria": ["..."] } },
  "settings":  { "layout": "...", "dtype": "...", "tokens_per_batch": 4096, "max_state_tokens": 512 },
  "states":    [ { "id": "<the caller's name for it>", "state": "<text or JSON>" } ]
}
```

- `states[].id` is optional; when given it comes back beside that state's answers.
- Every field is required; no setting has a default.

### What a run answers

`{ status, states_done, states, classifier_answers_as, seconds, answers: [{ index, id?, answers: { question id: answer } }] }`, answers in state order. Nothing is written to the person's records, and the classifier program writes no file.

## Settings the person gives (no default in code)

| Setting | What it decides |
|---------|-----------------|
| `layout` | `independent`: each question in its own row, so no question can change another's answer; a state costs one row per question. `packed`: every question in one prefix; a state costs one row of state plus one slot per question, several times fewer tokens, but later questions see earlier ones. |
| `dtype` | `bfloat16` (the model's own) or `float32`. |
| `tokens_per_batch` | How many tokens one GPU pass holds. Larger is faster until memory runs out. |
| `max_state_tokens` | The most tokens of one state the model reads; a longer state is cut there, as the decider does. |

## What is fixed in code, and why

- **The prompt is the decider's own, token for token.** It runs `Question k: ... Options: (A) ...`, then `\n\nContext:\n<state>`, then the answer slots. The opening `\n\nContext:\n` is tokenized on its own, as the decider does. It is run once at the end of each prefix, so a state's row carries only its own tokens and slots.
- **Answer shapes and temperature come from the decider and the model folder.**
  - Labels are A..J, then single-token two-letter labels up to 255 options, read from the tied embedding.
  - Isolated score levels are on when the folder's `decider_config.json` says so.
  - The temperature is the folder's `temperature_schema_first`.
- **Batches cross questions.** Prefixes are run in left-padded batches: a pad's input to every delta-net layer is zeroed and attention masks it, so every prefix ends with the state it would have had alone.
  - A suffix batch holds rows of many questions. Each row's mask hides its own prefix's padding, and its positions continue from that prefix's length.
  - Its delta-net layers start from its question's conv and recurrent state, read by index.
  - On Apple's GPU, the index is read inside one Metal kernel, the decider lane's scan with an indexed start, so no state is copied per row.
  - Rows are grouped by state length, so a batch is little padding. One batch is queued while the previous one is read back.
- **The chunked gated-delta rule has a matmul-only solve.** It is ported from transformers' `torch_chunk_gated_delta_rule` and used for prefixes and off Apple's GPU. It solves each chunk's unit lower-triangular system by recursive block inversion: exact, and only matmuls. A Neumann series in powers of the strictly lower part would overflow in float32 when keys are correlated.
- **Norms run in float32.** The source-derived core computes the captured zero-centred normalization using the raw checkpoint scale as `1 + weight` in float32, then rounds once. The earlier 0.007 comparison was measured on a different build and is historical evidence, not a result for this port.

## Files

| File | Purpose |
|------|---------|
| `read-data/bulk-answer.mjs` | The two row functions: check the request, start the classifier program, collect its answers. |
| `read-data/run-classifier.mjs` | Starts the isolated classifier process with the existing action, request, `-I -B` and private snapshot output contract. |
| `do-work/run_classifier.py` | Fresh CLI adapter for the existing `get-ready`, `get-ready-with-snapshot` and `work` actions and JSON line responses. |
| `do-work/answer_many_states.py` | The classifier controller and family registry. It validates inputs and streams completed state answers without touching records or writing files. |
| `read-data/mlx_decider_core.py` | The active source-derived hybrid forward, centered norms, immutable key cache, gated-delta mix and indexed Metal recurrence, plus independent/packed prefix preparation and bounded suffix scoring. |
| `do-work/questions_first/backbone.py` | Raw config and safetensors loader plus thin weight container. Its `forward` delegates the hybrid computation to the core. |
| `do-work/questions_first/gated_delta.py` | The chunked gated-delta rule in MLX, and the token-by-token form the tests hold it to. |
| `do-work/questions_first/metal_scan.py` | Compatibility import and test seam for the active indexed scan in the core. |
| `do-work/questions_first/engine.py` | `QuestionsFirst`: `prepare(rows, independent)` once, `score(prepared, states)` in batches, with progress, stop, and `on_done` handing on each state's answers as soon as its batch is read. |
| `do-work/questions_first/prompt.py` | The decider's questions-first prompt and its choice, score and noul answers, ported. |
| `do-work/questions_first/tokenizer.py` | The model folder's `tokenizer.json`, read with `tokenizers`, with no special tokens added. |
| `test/test_questions_first.py` | The MLX forward on a tiny made-up config: chunked = recurrent kernel, the triangular inverse, the cache equal to the plain uncached sequence (independent and packed), grouped key/value heads, per-row cache continuation, float32 norm scale, batch size changes nothing, stop, progress and `on_done`, and the Metal path's wiring. On a Mac it also runs the Metal kernel itself. |
| `test/test_lifecycle.py` | The classifier program with a made-up family: get-ready, work printing every answer once and writing no file, a stop and SIGTERM keeping what finished, and every refusal. |
| `test/test_end_to_end.py` | The whole classifier program, as its own process, on a made-up model folder (tiny random weights, a word-level tokenizer built in the test). |
| `test/made_up_worker.py` | The classifier program with a made-up family in place of a model, for the lifecycle tests. |
| `test/answer-questions-about-many-states.test.mjs` | The rows and their functions with no records door: answers returned in the answer, a stopped run's finished answers, refusals before a worker starts, get-ready's answer, the Python tests, and the start row run as the engine runs it on a made-up model. |
| `test/agree_with_reference.py` | Agreement with the decider's own PyTorch code (`Decider.schema` → `SchemaEngine` → `CompiledSchema.batch`), two steps. |
| `test/benchmark.py` | Wall time of 303 questions × 132 states, both layouts. |
| `test/synthetic.py` | The made-up tokenizer, questions and states (with the decider lane's speed set). No real text. |

## Measured

All data below is synthetic.

- **The decider's own PyTorch code, CPU, float32, random weights, 200 made-up question × state pairs.**
  - Tiny config: the MLX answers agree within 1.9e-7, independent and packed, and every choice is the same.
  - The full 2B `config.json` (random weights rounded to bfloat16, computed in float32): agree within 9.2e-6 over the 200 pairs (290 rows), every choice the same. On that CPU-only box the large projections ran through NumPy (`--numpy-projections`), because MLX's Linux CPU build multiplies matrices at about 3 GFLOPS.
- **Still to run on the M5 Max after merge:**
  - `python3 tools/answer-questions-about-many-states/test/benchmark.py --model <decider snapshot folder>` for the 303 × 132 wall time. The target is 60 s. The decider lane's earlier MLX build took 121.0 s on the same set: one question per pass, 5,684 suffix tokens/s.
  - `python3 tools/answer-questions-about-many-states/test/agree_with_reference.py reference --decider-source <snapshot> --model <snapshot> --dtype bfloat16 --out /tmp/agree`, then `... mlx --out /tmp/agree` for agreement on the real weights. The tolerance is 0.01.

## Not here yet

- **Only one classifier family.** `questions-first-decider` is the only one. Another family is a new entry in `FAMILIES` with its own `check` and `answer`.
- **Long states run token by token on the Metal path.** The scan is a recurrence over the state's tokens: right for short lines. A long state (thousands of tokens) would be faster with the chunked rule on the GPU. That needs a chunked kernel that reads its start by index.
- **The classifier program is started by `python3` on the Mac's path.** Fetching the program and its packages for a run is the engine's (another lane), not this folder's.

## Dependencies

**Depends on:**
- `tools/workflows` (`do-work/run-a-function.mjs`), which the rows pack.
- On the Mac: `mlx`, `numpy`, `tokenizers`, `blake3`, and `huggingface_hub` (for `get-ready` from a repo), all from the rows' `get_it`. Python's standard library otherwise.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json` and the tests here.

**Replaces:** the earlier per-question MLX helper and its batch-measurement companion, to be retired on landing; the immutable port contract keeps exact source citations.

## Licence

The ported decider code is Apache-2.0 (Mapika/decider-2b, snapshot b37f7e1ba3fbc9238004cf531fabbee2619973fd), as is this repository. The model's weights carry their own licence.
