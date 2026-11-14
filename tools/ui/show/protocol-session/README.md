# protocol-session

Guided step-through session primitive: a start affordance runs an ordered list of data-defined steps (paced, timed, prompted, or input-collecting), advances them by declarative rules, and reports a measured completion summary.

## Files

| File | Purpose |
|------|---------|
| `protocol-session-machine.ts` | Pure session reducer (injected time): idle → running → completed/abandoned, per-step transcript with measured `actualSeconds` and ordered captures |
| `protocol-session-machine.test.ts` | Machine tests incl. gauntlet cases (zero-step, 500-step, terminal latch, abandon, repeat captures) |
| `advance-registry.ts` | Declarative step-advance rules `{op,args}` via the shared blind registry: `timeout` / `tap-next` / `input-given` / `all-of` / `any-of`; unknown op never auto-advances |
| `advance-registry.test.ts` | Rule + composition + open-registration tests |
| `step-content-registry.tsx` | Step content renderers by open key: `prompt` / `pacer` (wraps BreathingPacer) / `timer` (countdown ring) / `choice` (one-tap capture tiles); fallback = prompt |
| `ProtocolSession.tsx` | The session component: owns the clock, visibility evidence, progress dots, start/next controls, lifecycle reporting |
| `ProtocolSession.test.tsx` | Component tests: full run, choice capture, default tap-advance, unknown content fallback, fake-timer timeout |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `ProtocolStep` | `{id, plannedSeconds?, advance?, captureField?}` | Machine-level step |
| `ProtocolSessionStep` | `ProtocolStep & {content?, data}` | Component-level step (open data bag for the renderer) |
| `SessionState` | `{phase, stepIndex, transcript, pendingCaptures, visibilityLost, …}` | Reducer state; terminal phases latch |
| `SessionSummary` | `{sessionId, stepsTotal, stepsCompleted, plannedSeconds, actualSeconds, captures, visibilityLost, completed}` | Measured payload for lifecycle dispatch — every number measured, never asserted |
| `AdvanceCondition` | `{op, args?}` | Declarative advance rule (open op) |
| `StepContentRenderer` | `(StepContentProps) => ReactElement \| null` | Content capability |

## Dependencies

**Depends on:** `blind-registry`, `breathing-pacer`, `cn`.
**Depended on by:** `@/packages/ui` barrel and guided-session feature surfaces such as `apeak`.

## Invariants

- The reducer never reads a clock — time arrives in events (deterministic tests).
- Terminal phases latch: no event after completed/abandoned mutates state, so lifecycle dispatch can never double-fire.
- A step with no advance rule defaults to tap-advance — data can never trap the user.
- Unknown content kind → prompt card; unknown advance op → no auto-advance (tap still works). Fail-open for the user, fail-closed for fabricated progress.
- Captures are ordered `{stepId, fieldId, value, atMs}` entries — repeats never overwrite.
