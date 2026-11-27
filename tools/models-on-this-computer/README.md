# tools/models-on-this-computer/

Asks a model served on the person's own computer a conversation or a yes-or-no question, so work that needs a model costs nobody anything, and says which free models fit this computer (its chip, memory and free space) and has its model server download them. Two `computer` rows, run through `tools/workflows/do-work/run-a-function.mjs`: `tool:ask-a-model` (`ask`) and `tool:get-free-models` (`fit`). Moved from old trillion `computer/local-models.mjs`, its settings `computer/local-models.json`, its model rows `records/local-model-records.json` and the `wired` judges of `src/decision-evals.json`.

## What it does

- `ask` with `messages` sends the conversation to the first `chat` row of the input's `job` (or the `default` job) whose server answers, in the OpenAI chat-completions shape, with the job's token limit, time limit and answer format; `tools` are passed through and the model's tool calls returned for the caller to run. `parts: true` streams the answer and also returns it as keyed text parts.
- `ask` with `state` and `questions` asks the first `classify` row that answers: a classifier taking `{ state, questions }`, or a chat model asked each question as yes or no and answered with the probability of yes read from its own word probabilities (`yesShare`). A decision listed in `wired` is asked of its measured judge alone.
- A server that is not running is skipped; a model that refused only this request's shape (400 to 499) is not rested. When none answers, the answer is `{ error, tried: [{ id, why }] }`.
- `fit` answers `{ mac: { chip, memory_gb, free_disk_gb }, server: { running }, models: [{ id, model, job, size_gb, min_memory_gb, fits, have }] }`; with `get` (`"fitting"` or a list of offer ids) it has the running server download each that fits, and adds `got`.

Which servers, models, jobs and offers there are is DATA: `read-data/models-on-this-computer.json`. The code names none.

## What differs from old trillion

- The model rows are this folder's own read-data JSON. Old trillion read them afresh from the account (`POST /mcp/api/resources/own/command content:default`) and kept a copy under `~/.trillion/computer-sources/`; that route and that copy are gone (`refreshModelRecords`, `currentModelRecords`).
- Chip and memory are read in process (`os.cpus()`, `os.totalmem()`, the same sysctl values), because a `computer` run may start programs only from `/bin` and `/usr/bin` and `sysctl` is `/usr/sbin/sysctl`. Free space is that of the volume the run's home is on.
- The fast-path meter (`computer/fast-path-meter.mjs`) is not carried: it reported a storm after 20 asks in 60 seconds within one process, and a run on the engine is one process answering one ask. A failed model's rest likewise lasts only within one run.
- Not carried: `askHere` and the Mac runner's `context.priority` (computer/mac-tools.mjs), the models other computers offered (`computer/offered-endpoints.mjs`), the managed-profile check (`computer/managed-settings.mjs`) and putting the model server on the computer (`computer/helper-runtimes.mjs`). See Not yet.

## Not yet

- **Reaching the model server.** A `computer` run reaches no loopback port except the local doors its row names in `invoke.local_doors`, each a name the computer reports a port for (trillion-rust `src/tool_runs/tools/network.rs` `local_ports_of`, the computer's `report.local_ports`, `src/tool_runs/this_computer.rs`). Both rows name `local-model-server`; a Mac reports it as 11434, the person's own Ollama (trillion-apps `macos/computer-reader.json`). A computer that reports no such port refuses the run as having no local port. No row writes a port: each settings row names its server's door (`door`, with `path`), and the rows hand the run this computer's reported ports (`stdin.local_ports`, `{"fill": {"from": "computer", "field": "local_ports"}}`), so the number lives only in the computer's report. The rows list `local-judge-server` and `local-classifier-server` as optional doors (`{"name", "required": false}`, trillion-rust cc5aac631 `network.rs` `local_ports_of`): a computer that does not report them still runs the tool, and their model rows are passed over in the `not_reported` words; only `local-model-server` is required.
- **Organisation policy.** Old trillion refused both tools when a managed profile set `local_models` to false, reading `/Library/Managed Preferences/<domain>.plist` and `~/Library/Managed Preferences/<domain>.plist` with `/usr/bin/plutil`. The `computer` base rules (`src/runtime/workshop/computer-capabilities.json:10-21`) read neither file, so the check would always find nothing; it is not carried rather than silently off. Needed: the engine refusing a row its place's managed policy turns off, or the rule `(allow file-read* (literal "/Library/Managed Preferences/{domain}.plist") (literal "{home}/Library/Managed Preferences/{domain}.plist"))`.
- **Putting the model server on the computer.** Old trillion fetched the Ollama app, checked its signature with `codesign`, kept it under `~/.trillion/helpers/` and opened it with `open -a`. A `computer` run has no internet, no folder outside its own and no capability that installs or opens an app; the engine's own program fetch (`src/runtime/workshop/program_fetch.rs`) unpacks a tar archive's program, not an app bundle. `fit` with `get` now says the server is not running and how to get it.
- **Other computers' servers.** Old trillion also tried model servers the person's other computers offered (`computer/offered-endpoints.mjs`). A run reaches no other host on the network.

## Files

| File | Purpose |
|------|---------|
| `read-data/models-on-this-computer.mjs` | `ask` and `fit`, and what they are made of: `askLocal`, `firstAnswer`, `yesShare`, `thisMac`, `modelsForThisMac`, `localModelSettings`. |
| `read-data/models-on-this-computer.json` | The model rows (`chat`, `jobs`, `classify`, `offer`, `wired`), the server's addresses, the limits and the words. |
| `what-this-tool-does-and-how-to-run-it.json` | The two `computer` rows. |
| `test/models-on-this-computer.test.mjs` | Old trillion's `test/local-models.test.mjs` cases and the streaming case of `test/keyed-parts.test.mjs`, against stand-in servers, plus the rows and the shipped settings. |

## Dependencies

**Depends on:** `tools/workflows` (the command that runs a function); Node 22 or later; a model server on the computer (Ollama).

**Depended on by:** nothing is imported from here.
