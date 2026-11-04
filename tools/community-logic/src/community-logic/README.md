# src/community-logic

Tested community logic vendored from `bitfield-packages/packages` (only import paths changed), so Trillion runs it with no bitfield-packages import; its tests live in `test/community-logic/`.

## Files

| File | Purpose | From |
|------|---------|------|
| `corroboration-gate.ts` | `corroborationGate`: independent signals must agree before an outcome shows | progression-evaluator/read-data |
| `safety-gate.ts` | Safety gate before a progression outcome is visible | progression-evaluator/read-data |
| `calendar-invite-file.ts` | `calendarInviteFile`: an event as an `.ics` file | calendar-booker/do-work |

## Dependencies

**Depends on:** nothing outside this folder.
**Depended on by:** `src/progression.mjs`, `src/community.mjs`, `src/community-activity.mjs`.

## Invariants

A fix to one of these files is a change to logic other places also copied; keep the file identical to its source apart from import paths, and change it forward in both places.
