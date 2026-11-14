# Notifications Do Work (Write Authority)

This folder owns the package-local write path for the setting screen: it turns an
opaque option id into the owner's invoke envelope and routes it to the named
target. It owns NO route truth — the policy reader (`read-data/`) is the single
source that decides the route; this file only assembles the envelope and sends.

## Files

| File | Purpose |
|------|---------|
| `save-setting.ts` | The write authority. Builds the target invoke envelope from a `SettingActionRouteView` (DATA), inserts the opaque option id at the route's value path, and sends via the canonical runtime-kit target invoke. Returns a structured result — never throws across the boundary for an expected write failure. |
| `save-setting.test.ts` | Unit tests: path insertion (clone, never mutate), envelope assembly, read-only/missing-route handling, and that a rejected send returns a generic error result. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `SaveSettingResult` | `{ ok: boolean; optionId: string; reply?: unknown; error?: string }` | Machine-readable write outcome. |
| `insertValueAtPath` | `(template, valuePath: readonly string[], value) → unknown` | Pure: clones `template`, writes `value` at the path (empty path ⇒ value IS the payload). Never mutates. |
| `buildActionPayload` | `(route: SettingActionRouteView, optionId: string) → unknown` | Inserts the opaque id into a clone of the route's `payloadTemplate` at `route.valuePath`. |
| `saveSetting` | `(route, optionId) → Promise<SaveSettingResult>` | Assembles the envelope from route DATA and sends to `route.target`; returns the structured result. |

## Dependencies

**Depends on:**
- `@bitfield/runtime-kit` — `sendRequestToBitfieldTarget` (the canonical target invoke; notifications never owns a sender).
- `@/packages/notifications/read-data/read-notifications-policy` — `SettingActionRouteView` (type only).

**Depended on by:** `show/notification-setting-screen.tsx` (web envelope `onSave`); mirrored in ES5 by `show-ios-jscore/mount-notifications-jscore.js` (`buildActionPayload` + `runtime.target.invoke`).

## Invariants

1. Zero domain vocabulary — no mode keys, target name, `action:...`, or method literal. Every routing value is read from the `SettingActionRouteView` at runtime (L090: self-describing data, generic handler).
2. The route object is never mutated; the option id is inserted into a fresh clone.
3. Idempotency and the action receipt are owned by the target authority itself — this send path never injects either.

## Proof

```bash
npx vitest run --config dev/bitfield-packages/vitest.config.ts dev/bitfield-packages/packages/notifications/do-work/save-setting.test.ts
```
