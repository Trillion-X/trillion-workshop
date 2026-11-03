# tools/models-on-this-computer/

Asks a model served on the person's own computer a conversation or a yes-or-no question, so work that needs a model costs nobody anything, and says which free models fit this computer (its chip, memory and free space) and has its model server download them. Two `computer` rows, run through `tools/records-door/do-work/run-an-export.mjs`: `tool:ask-a-model` (`ask`) and `tool:get-free-models` (`fit`). Moved from old trillion `computer/local-models.mjs`, its settings `computer/local-models.json`, its model rows `records/local-model-records.json` and the `wired` judges of `src/decision-evals.json`.

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

- **Reaching the model server.** A `computer` run reaches no loopback port except the local doors its row names (trillion-rust `src/runtime/workshop/network.rs:20-22`), and the only door is `model-pool` (`src/runtime/workshop/local-doors.json:4`, `network.rs:708-710` `PlaceDoor::ModelPool`), the hosting app's pooled server on port 8092 (`src/account/places/settings.json:43`). The model rows here are the person's own Ollama on `127.0.0.1:11434` and `11435` and a classifier on `8099`, so until the engine has a door for them every ask answers "is not running". Needed: a `local-doors.json` door for the person's own model server whose port the place reports (a new `PlaceDoor` reading a new `PlaceReport` field, `src/account/places.rs:393`), giving the sandbox rule `(allow network-outbound (remote ip "localhost:11434"))` (and `:11435`, `:8099`) as `src/runtime.rs:105-110` builds it. The run is also not told a door's port (`src/runtime/workshop/container.rs:255` binds it; the environment at `container.rs:283` carries only PATH, HOME and TMPDIR), so a row that names a door must also carry the address in its own data.
- **Organisation policy.** Old trillion refused both tools when a managed profile set `local_models` to false, reading `/Library/Managed Preferences/<domain>.plist` and `~/Library/Managed Preferences/<domain>.plist` with `/usr/bin/plutil`. The `computer` base rules (`src/runtime/workshop/computer-capabilities.json:10-21`) read neither file, so the check would always find nothing; it is not carried rather than silently off. Needed: the engine refusing a row its place's managed policy turns off, or the rule `(allow file-read* (literal "/Library/Managed Preferences/{domain}.plist") (literal "{home}/Library/Managed Preferences/{domain}.plist"))`.
- **Putting the model server on the computer.** Old trillion fetched the Ollama app, checked its signature with `codesign`, kept it under `~/.trillion/helpers/` and opened it with `open -a`. A `computer` run has no internet, no folder outside its own and no capability that installs or opens an app; the engine's own program fetch (`src/runtime/workshop/program_fetch.rs`) unpacks a tar archive's program, not an app bundle. `fit` with `get` now says the server is not running and how to get it.
- **Other computers' servers.** Old trillion also tried model servers the person's other computers offered (`computer/offered-endpoints.mjs`). A run reaches no other host on the network.

## Files

| File | Purpose |
|------|---------|
| `read-data/models-on-this-computer.mjs` | `ask` and `fit`, and what they are made of: `askLocal`, `firstAnswer`, `yesShare`, `thisMac`, `modelsForThisMac`, `localModelSettings`. |
| `read-data/models-on-this-computer.json` | The model rows (`chat`, `jobs`, `classify`, `offer`, `wired`), the server's addresses, the limits and the words. |
| `tool-rows.json` | The two `computer` rows. |
| `test/models-on-this-computer.test.mjs` | Old trillion's `test/local-models.test.mjs` cases and the streaming case of `test/keyed-parts.test.mjs`, against stand-in servers, plus the rows and the shipped settings. |

## Dependencies

**Depends on:** `tools/records-door` (the command that runs a function); Node 22 or later; a model server on the computer (Ollama).

**Depended on by:** nothing is imported from here.
