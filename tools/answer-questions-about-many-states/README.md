# tools/answer-questions-about-many-states/

Asks one set of questions about many states (lines, records, messages) in bulk, with a questions-first classifier on the person's own Mac. The questions are run once as a cached prefix, and the states are batched against that cache on Apple's GPU through MLX. Each state gets, for each question, the classifier's probability for each option.

The engine runs every row: all four are `computer` rows of one standard-library script. Their inputs and results are rows in the person's own lists, reached through the run's records door:
- **Read from lists:** the classifier, the question set, the state set and the settings.
- **Written to lists:** every answer, and the run's own row with its measurements.

The only thing kept on the computer is a model's weights, in the tool's kept folder. This folder holds code and list definitions only. It names no model, person, book or voice.

The first classifier family is `questions-first-decider`. It is a Qwen3.5 hybrid (gated delta-net layers plus gated full attention) trained to answer a prefix of questions (`decider.schema(questions).batch(states)`). This folder ports to MLX:
- the backbone;
- the decider's own prompt layout and answer shapes;
- its schema engine: one prefix per question (`independent`, the decider's default), or all questions in one prefix (`packed`).

## The rows

| Row | Action | What it does |
|-----|--------|--------------|
| `tool:get-a-classifier-ready-on-this-mac` | `get-ready` | Fetches the weights a Question classifiers row names (a Hugging Face repository at a pinned revision) into the kept folder. It fetches once, and checks each file against the size and SHA-256 the repository lists. It writes the BLAKE3 identity of the set back to the row. This is the only row with `internet: true`. |
| `tool:answer-questions-about-many-states` | `answer` | `{classifier, questions, states, settings}`: a classifier row, a question set name, a state set name and a settings row. It asks every question of the set about every state of the set. Each state's answers become a Classifier answers row as its batch finishes, and the run's row in Classifier runs keeps how far it is and what it measured. |
| `tool:read-a-bulk-answer-run` | `read` | Gives the run's row and, with `answers: true`, a page of its answer rows in state order (`after` / `next_after`). |
| `tool:stop-a-bulk-answer-run` | `stop` | Sets Stop on the run's row. The running run reads that row after every batch, stops its worker and keeps every answer it wrote. |

**How a run is named.** Its id is the BLAKE3 identity of everything it asks: the classifier's weights identity, the questions, the states and the settings. The same rows therefore name the same run, and a finished run answers again without running. A stopped or interrupted run, asked again, goes on from the states that have no answer row yet.

**How a run is split.** `do-work/run_in_engine.py` runs under the engine's `python3` (standard library only) and does every records call (`do-work/records_door.py`). It starts `do-work/worker.py` under the Python the person granted to `start-a-program`: one that imports mlx, numpy and tokenizers. The worker reads one job on standard input and streams its answers back a batch at a time. It touches no records and no network.

## The person's lists (`read-data/answer-many-states.json`)

| List | Row type | Holds |
|------|----------|-------|
| Question classifiers | `classifier` | Family, Hugging Face repository, pinned revision. The tool writes back the weights identity, the file count and when it was made ready. |
| Classifier questions | `classifier-question` | Set, order, type (choice, score, noul), the question, its options as JSON. |
| States to classify | `classifier-state` | Set, order, the state (text, or JSON). |
| Classifier settings | `classifier-setting` | Layout, dtype, tokens per GPU pass, most tokens of a state. Every field is required, and none has a default in code. |
| Classifier runs | `classifier-run` | What the run asked, status, Stop, states answered, decisions, load / prepare / answer / wall seconds, decisions per second, tokens run, the machine, its identity, and why it failed. |
| Classifier answers | `classifier-answer` | Run, state, and the answers as JSON: `{question id: {type, probabilities, choice \| score \| noul, confidence, …}}`. |

Each list is made the first time a row needs it. An existing list is never rewritten.

## Engine change this needs (trillion-rust)

The answer row runs only once the engine can start an MLX Python with the Apple GPU. Today `start-a-program` picks only from the `programs` rows of `src/runtime/workshop/computer-capabilities.json` (`ai-command`, `headless-browser`, `record-and-hear`). A `computer` run may otherwise start only `/bin` and `/usr/bin`, and `/usr/bin/python3` has no MLX. The engine needs three things:

1. **A program row** in that file:
   ```json
   {"id": "run-an-mlx-python", "parameters": {"program": "program"},
    "sandbox": ["(allow process-exec* file-read* (literal \"{program}\"))",
                "(allow file-read* (subpath \"{program_folder}\"))",
                "(allow iokit-open (iokit-user-client-class \"AGXDeviceUserClient\"))",
                "(allow mach-lookup (global-name \"com.apple.MTLCompilerService\"))"]}
   ```
   - `{program_folder}` must be the Python's whole installation: its `sys.prefix` and `sys.base_prefix`, with symlinks resolved, so a venv's site-packages and its base interpreter are both readable.
   - MLX also writes Metal's shader cache under the user's cache folder (`DARWIN_USER_CACHE_DIR`). The exact Metal rules are unmeasured, as `tools/generate-speech` notes for the same GPU.
2. **A grant that finds the Python.** When the person grants `start-a-program` for this row, the engine offers the `python3`s on the Mac for which `python3 -I -c "import mlx.core, numpy, tokenizers"` succeeds:
   - the login shell's `command -v python3`;
   - `/opt/homebrew/bin/python3` and `/usr/local/bin/python3`;
   - the person's venvs.

   The chosen path reaches the run as `grants.start-a-program.program`, the row's last argv fill.
3. **Time and memory.** A run of `max_run_ms` 7,200,000 and about 32 GB is enough for 303 × 132 (184.6 s and 20.3 GB peak measured for the independent layout). The row declares both.

Until then the answer row's `verify` is `needs-a-machine` with exactly that requirement, and a run without the grant answers `no_program` in words. `get-ready`, `read` and `stop` need no engine change. `read` and `stop` prove themselves in sample runs against the repository's stand-in door.

## What is fixed in code, and why

- **The prompt is the decider's own, token for token.**
  - It runs `Question k: ... Options: (A) ...`, then `\n\nContext:\n<state>`, then the answer slots.
  - The `\n\nContext:\n` opening is tokenized on its own, as the decider does. It is run once at the end of each prefix.
  - Labels are A..J, then single-token two-letter labels up to 255 options.
  - Isolated score levels and the temperature come from the model folder's `decider_config.json`.
- **Prefixes and batches.** Prefixes run in left-padded batches whose pads are zeroed and masked. A suffix batch holds rows of many questions, each starting from its own question's state, read by index. On Apple's GPU that happens inside one Metal kernel: the decider lane's gated-delta scan with an indexed start. Any shape the scan cannot take (key heads not a multiple of 32) runs the chunked rule.
- **The chunked gated-delta rule** is a port of transformers' `torch_chunk_gated_delta_rule`. It solves each chunk's unit lower-triangular system by recursive block inversion: exact, and only matmuls.
- **Norms run in float32.** Zero-centred norms compute with `(1 + weight)` in float32, rounded once.
- **Every write is bounded.** A records write carries at most `most_writes` (128) rows, and its request key is made from what it writes, so a write sent again answers its first receipt. The run's row is merged, conditional on what was read, so a Stop set meanwhile is never overwritten.
- **Weights are checked.** Each file must match the size and SHA-256 the repository lists. The identity is BLAKE3 over the sorted list of (name, bytes, SHA-256): the engine's `python3` has no blake3 module, and the pure-Python BLAKE3 packed from `tools/conversations` would take hours over 4.5 GB.

## Files

| File | Purpose |
|------|---------|
| `do-work/run_in_engine.py` | The entry for every row (`get-ready`, `answer`, `read`, `stop`), standard library only: the lists, the run, the worker's events, the measurements. |
| `do-work/records_door.py` | The records door from Python's standard library: the protocol of `tools/records-door/read-data/records-door.mjs` (descriptor 3, `run_resource_operation`, busy retries with the same key, byte pages checked by BLAKE3). |
| `do-work/worker.py` | The GPU half, under the granted Python: one job in, one JSON line per event out. |
| `do-work/questions_first/backbone.py` | The Qwen3.5 hybrid text backbone in MLX, read from `config.json` and safetensors. |
| `do-work/questions_first/gated_delta.py` | The chunked gated-delta rule in MLX, and the token-by-token form the tests hold it to. |
| `do-work/questions_first/metal_scan.py` | The Metal gated-delta scan with one start state per row, read by index. |
| `do-work/questions_first/engine.py` | `QuestionsFirst`: `prepare(rows, independent)` once, then `score(prepared, states)` in batches, with progress and stop. |
| `do-work/questions_first/prompt.py` | The decider's questions-first prompt and its choice, score and noul answers, ported. |
| `do-work/questions_first/tokenizer.py` | The model folder's `tokenizer.json`, read with `tokenizers`. |
| `read-data/answer-many-states.json` | DATA: the six list definitions, each family's files, where weights are fetched from, the records per write, every word. |
| `test/test_engine_rows.py` | The rows' program over a stand-in records door (`test/door_stand_in.py`) and a stand-in worker. It covers: lists made once; inputs from rows; answers and measurements as rows; a run named by what it asks, not run twice, stopped and resumed; read pages; get-ready fetching once and checking each file; byte pages and a busy door; every refusal. Standard library only. |
| `test/test_worker_end_to_end.py` | A whole run through the real worker under this Python, on a made-up model folder: tiny random weights, and a word-level tokenizer built in the test. |
| `test/test_questions_first.py` | The MLX forward on a tiny made-up config. It covers: the kernels, the triangular inverse, the cache against the uncached sequence in both layouts, batch size changing nothing, stop and progress, and the Metal path (on a Mac, the kernel itself). On Apple's GPU every bound is 5e-3, half the 0.01 agreement bar. |
| `test/agree_with_reference.py` | Agreement with the decider's own PyTorch code, two steps (`--numpy-projections` for a CPU-only box). |
| `test/benchmark.py` | Wall time of 303 questions × 132 states, both layouts. |
| `test/synthetic.py` | The made-up tokenizer, questions and states. No real text. |
| `test/answer-questions-about-many-states.test.mjs` | Runs the Python tests under `npm test` and checks every row is one the engine runs. |

## Measured

All data below is synthetic.

- **The decider's own PyTorch code on 200 made-up pairs.** The MLX answers agree within 1.9e-7 for the tiny config (both layouts), and within 9.2e-6 for the full 2B config (CPU, float32, random weights). Every choice is the same.
- **Speed.** M5 Max, bf16, real decider-2b weights, 303 questions × 132 lines, Nov 5:

| Layout | Wall | Prepare | Score | Decisions/s | Peak memory |
|---|---|---|---|---|---|
| packed | 134.47 s | 16.39 s | 118.08 s | 297.4 | 8.8 GB |
| independent | 184.63 s | 10.92 s | 173.71 s | 216.6 | 20.3 GB |

The target was 60 s. Brian accepted this speed on Nov 5.

## Not here yet

- **The answer row waits on trillion-rust's program row** (above).
- **Gated weights.** No Hugging Face account is sent, so a gated model's weights cannot be fetched (`gated` in words). That needs a credential mount for `huggingface.co`.
- **Long states on the Metal path.** The scan is a recurrence over each state's tokens: right for short lines. A long state (thousands of tokens) would be faster with a chunked kernel that reads its start by index.
- **Only one classifier family.** Another family is a new entry in the data's `families` and in the worker.

## Dependencies

**Depends on:**
- `tools/conversations` `read-data/content_identity.py` (BLAKE3, packed by every row);
- the engine's `python3`;
- for `answer`, the granted Python with `mlx`, `numpy` and `tokenizers`.

**Depended on by:** `tool-rows.json` and the tests here.

## Licence

The ported decider code is Apache-2.0 (Mapika/decider-2b, snapshot b37f7e1ba3fbc9238004cf531fabbee2619973fd), as is this repository. The model's weights carry their own licence.
