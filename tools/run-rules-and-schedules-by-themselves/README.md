# tools/run-rules-and-schedules-by-themselves/

What a person's Trillion does by itself: rules and schedules, the tools an AI sets them with, the setting a rule or schedule stands behind, and which of a reading's numbers got worse.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/trillion-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. It is not a tool yet (no `tool-rows.json`): its files are imported by path.

## Files

| File | From |
|------|------|
| `src/automation-guards.json` | `src/automation-guards.json` |
| `src/automation-health-looks.json` | `src/automation-health-looks.json` |
| `src/automation-tools.mjs` | `src/automation-tools.mjs` |
| `src/compare-readings.mjs` | `src/compare-readings.mjs` |
| `test/events-continuity.test.mjs` | `test/events-continuity.test.mjs` |

The job's other moved files are kept once in a shared place, because more than one group imports them:

- `src/automation-health.mjs` is at `tools/shared-code/src/automation-health.mjs`

## Not yet here

- `src/automations.mjs`: it imports PERSON_APP from src/activity.mjs, whose home tools/see-what-my-ais-did/activity.mjs loads only inside its own row's packed run (that row lays src/execution-context.mjs beside it): src/automations.mjs moves once a row packs it, or activity.mjs loads where it is

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.

## Moved from old trillion main (5dc302be)

Byte for byte under their old paths, only import paths changed; `moved-from.json` names each.

| Old path | Here | Status |
|---|---|---|
| `src/keep-running.json` | `src/keep-running.json` | data, read by its module |
| `src/keep-running.mjs` | `src/keep-running.mjs` | loads here |
| `test/keep-running.test.mjs` | `test/keep-running.test.mjs` | runs here: 31/31 pass |
