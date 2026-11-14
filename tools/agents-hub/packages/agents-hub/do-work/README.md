# agents-hub / do-work

Mutations and side-effecting work for the agents hub: writing agent records, dispatching agent messages, and the autonomous decision-session cadence (single-flight clock-driven AI session spawn).

## Files

| File | Purpose |
|---|---|
| `agent-record-writes.ts` | THE agent mutation: full `ai-agent-profile` record via engine write-batch at the record's source address (create/edit/duplicate/archive/restore/delete are configurations of this one write) |
| `agent-record-writes.test.ts` | Write-batch unit tests |
| `dispatch-agent-message.ts` | Blind message dispatch: workflow `execute_definition` with the definition id read from this package's own config record |
| `dispatch-agent-message.test.ts` | Dispatch unit tests |
| `decide-spawn-session.py` | Single-flight cadence GATE (pure): given the last-spawn marker + min interval, decide whether to spawn an AI session this clock tick. Decision rides the EXIT CODE (0 = spawn, 3 = no-op, 2 = usage); stdout carries `now_ms` for the marker write |
| `decide-spawn-session.test.py` | Gate unit + CLI tests (29 cases): pure `decide_spawn` boundary/fail-open/clock-skew cases + CLI exit-code contract |
| `spawn-decision-wrapper.mjs` | The readable `node -e` wrapper source the deliver script minifies into `action:spawn-decision-session`'s spawn argv. Reads the LIVE protocol `ai-instruction-block:trading-agent-protocol` from the carrier at runtime (SSOT) and runs `claude -p` (Opus 4.8) for one decision cycle |

## Key Functions

| Function | Signature / Shape | Role |
|---|---|---|
| `decide_spawn` (py) | `decide_spawn(last_marker_raw: str, min_interval_ms: int, now_ms: int) -> dict` | Pure single-flight decision. `now_ms` injected for testability. Returns `{should_spawn, now_ms, last_ms, elapsed_ms, min_interval_ms}`. Absent/garbage marker fails OPEN to never-spawned; bad threshold exits 2 (no-op, fail-closed) |
| `main` (py) | exit codes: `0`=spawn, `3`=no-op, `2`=usage | The exit code is the channel the workflow `on_result` edges read (`input.output.exit_code == 0`), because a compute.process step's stdout is a byte side-channel the EDGE resolver cannot materialize |
| `bootBasis` / `readCurrent` (wrapper) | bare-process carrier reads (`/boot` basis + `engine.operation.label-addressed` read-current) | The wrapper has no runtime-kit imports (it is a `node -e` string); it reads the carrier with plain `fetch` + the running-command-list-basis header |
| `agentRecordWrites` (ts) | engine write-batch of `ai-agent-profile` | The single agent mutation; preserves profile-owned `process_launch` when present |
| `dispatchAgentMessage` (ts) | workflow `execute_definition` | Blind message dispatch via a data-declared definition id |

## The decision cadence (how it fits together)

`trigger:spawn-decision-on-clock-tick` (clock-tick delta) → dispatches `slot::workflow` `execute_definition action:spawn-decision-session` → DAG:

```
read_last_spawn (read marker) ─always→ read_gate_script ─always→ gate (decide-spawn-session.py)
                                                                    │ on_result: output.exit_code == 0
                                                          ┌─────────┴─────────┐
                                                    write_marker            spawn
                                                    (now_ms)         (compute.process_session:
                                                                      node -e <wrapper> → claude -p)
```

When `gate` exits non-zero (interval not elapsed), BOTH `write_marker` and `spawn` are Skipped and the action completes cleanly — a no-op tick. This is the single-flight guard: the clock ticks ~30s, an Opus cycle takes ~2-5 min, so `MIN_INTERVAL_MS=300000` keeps exactly one session in flight per interval.

Decision != execution: the spawned AI session AUTHORS the trading policy + cycle fact + decision; the generic executor (`trade-order action:apply-trading-policy`) applies the policy to real broker orders.

## Dependencies

**Depends on:** the live carrier (`engine.operation.label-addressed` reads/writes), `compute.process` + `compute.process_session` engine targets, `slot::workflow` (executes the def), the live record `ai-instruction-block:trading-agent-protocol` (the wrapper's SSOT objective), `decide-spawn-session.py` stored-bytes (mounted into the gate step), the `claude` CLI (Opus 4.8).

**Depended on by:** `decision-cadence.things.json` (declares the def + trigger + stored-bytes) and `deliver-decision-cadence.mjs` (minifies the wrapper into the def's argv and delivers all three records via write-batch).
