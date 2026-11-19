# tools/workflows/crates/workflow-component/

The workflow engine (`workflow-core`, through `workflow-engine`) as one WebAssembly component (`wasm32-wasip2`). The engine runs it as the tool `tool:run-workflow-definition` on any computer it runs on, with no network, no secret and no door. A run is one walk of a definition from its start with the answers held. Every ask it cannot answer is handed back.

## How a run goes

1. A listed workflow row (a `source:workflow-recipes` row) runs with its id as `input.row`. The component reads that row's `payload.definition` from the rows laid out at `/opt/workflows/recipes`. A run may instead carry its own `definition`, but a run by the tool's own name holds no records, so its tool steps start nothing (the engine's `src/tool_runs/tools.rs` `runs_as` and wake's `may_schedule`).
2. The engine walks the definition. A step whose answer is held (`answers`, by step id) is answered with it.
3. An ask whose name is a tool id is handed back as a wake effect `{"wake": {"tool", "input", "reply"}}`. When that run settles, wake tells its result (or why it failed) back as the fact `workflow-step-answered`, carrying the run (the engine's `src/wake.rs` `told_back`). The listed row's wake that hears that fact runs this again with the answer added.
4. Any other ask waits for whoever it names (a step no tool runs names the run's actor). Its `waiting` entry says how its answer is told back (`told_as`).
5. A told failure fails its step, in the words of the run that failed.

## In and out

- Standard input: `{"input": <tool input>, "cause": <task.cause>, "context": <task.context>}`.
- Standard output, one line: `{"result": {"status", "workflow", "run", "steps", "waiting"}, "wake_effects": [...]}`; `{"error"}` with exit 1 when the run cannot be walked.
- `start_at` starts the definition at a later step: the part of it reachable from that step.

## Build

Built and committed by `tools/build-engine-modules-for-web-hosts` (`ENGINE_COMPONENTS`) into `built-stored-bytes/workflow-component/workflow_component.wasm`; never copied by hand.
