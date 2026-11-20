# tools/workflows/crates/workflow-component/

The workflow engine (`workflow-core`, through `workflow-engine`) as one WebAssembly component (`wasm32-wasip2`). The engine runs it as the tool `tool:run-workflow-definition` on any computer it runs on, with no network, no secret and no door. A run is one walk of a definition from its start with the answers held. Every ask it cannot answer is handed back.

## How a run goes

1. A run is handed its `definition` (or `definitions`) by whatever started it, from where the person keeps their workflows (their own database). The component reads no file and no store, so no person's workflows depend on a shared folder of workflow files.
2. The engine walks the definition. A step whose answer is held (`answers`, by step id) is answered with it.
3. An ask whose name is a tool id is handed back as a wake effect `{"wake": {"tool", "input", "reply"}}`; when the step's input is exactly `{"call": {"name", "arguments"}}`, as the door's tools:run takes it, the effect carries that `call` instead and wake sends it to the tool's session. When that run settles, wake tells its result (or why it failed) back as the fact `workflow-step-answered`, carrying the run (the engine's `src/wake.rs` `told_back`). The listed row's wake that hears that fact runs this again with the answer added.
4. Any other ask (a step no tool runs names the run's actor) is told as the fact `workflow-step-waiting`: the step, what it asks, whom, and `told_as`, the envelope its answer is told back in. The component keeps nothing and names no store or tool: the person's own wakes decide what a waiting step becomes (none, one or many of them may hear it), and whatever they do ends by telling `workflow-step-answered` with that envelope and the answer, which runs this again.
5. An ask named `wake:arrive` (the engine's own operation) is answered at once with `{told: true, kind, event_id}` and told as the fact it gives, `{kind, event_id?, payload}`, when the run ends (`event_id` left out is `<run>:<step>`). Its answer is held with the run, so a later pass replays it and tells nothing again.
6. A step inside a loop or a used workflow is waited on, and answered, under its place in the run (the engine's `_runtime_identity`, e.g. `each_iter_1/tell`): each item is a step of its own.
7. A told failure fails its step, in the words of the run that failed.

## In and out

- Standard input: `{"input": <tool input>, "cause": <task.cause>, "context": <task.context>}`.
- Standard output, one line: `{"result": {"status", "workflow", "run", "steps", "waiting"}, "wake_effects": [...]}`; `{"error"}` with exit 1 when the run cannot be walked, and `{"error", "result"}` with exit 1 when the walk failed (the engine's words), so the wake that started it is marked failed, never ran.
- `start_at` starts the definition at a later step: the part of it reachable from that step.

## Build

Built and committed by `tools/build-engine-modules-for-web-hosts` (`ENGINE_COMPONENTS`) into `built-stored-bytes/workflow-component/workflow_component.wasm`; never copied by hand.
