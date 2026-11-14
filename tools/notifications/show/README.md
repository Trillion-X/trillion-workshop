# Notifications Show (Web Surface)

This folder owns the browser surface for the notification setting screen: one
stateful web envelope plus the pure, blind renderer and the two molecules it
composes. The renderer is structurally incapable of naming a notification mode —
it consumes only a `HumanSettingView` (human strings + opaque option ids).

## Files

| File | Purpose |
|------|---------|
| `notification-setting-screen.tsx` | Stateful web envelope: the ONLY place holding runtime state (pending choice, write phase, connectivity) and the ONLY place touching the data layer (`useBitfieldData`) and write authority (`saveSetting`). Resolves the policy + view and hands them to the pure renderer. Exports `mount({el,props})`. |
| `blind-setting-renderer.tsx` | Pure, stateless component that renders the full reference anatomy (header + radiogroup of option cards + save/revert bar) from one `HumanSettingView`. Handles every render state from the single `status` field. |
| `setting-option-card.tsx` | One selectable option row (icon + label + description + "Active now" badge + check). Reports the opaque `option.id` verbatim; role=radio with keyboard support. |
| `setting-save-bar.tsx` | The persistent footer: status dot + status copy + Revert/Save buttons, all driven by the view's `save`/`revert`/`statusTone` fields. |
| `__tests__/` | React Testing Library specs for the renderer and molecules. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `NotificationSettingScreen` | `({ props }) → JSX` | Reads surface input (records + descriptor), picks live vs default-only path. |
| `mount` (default) | `({ el, props }) → unmount` | Runtime entry; mounts the React surface via `mountReactSurface`. |
| `BlindSettingRenderer` | `({ view, onSelect, onSave, onRevert }) → JSX` | The pure blind renderer. Same `view` → same DOM. |
| `BlindSettingRendererProps` | `{ view: HumanSettingView; onSelect; onSave; onRevert }` | Renderer contract. |
| `SettingOptionCard` | `({ option, disabled, onSelect }) → JSX` | A single radio option row. |
| `SettingSaveBar` | `({ view, onSave, onRevert }) → JSX` | The save/status footer. |

## Dependencies

**Depends on:**
- `@/packages/ui` — `Card`, `Container`, `Text`, `Badge`, `NamedIcon`, `Button`, `StatusDot`, `mountReactSurface` (all visual structure composes shared primitives — no raw `div/span/p`, no inline styling per L065).
- `@/packages/notifications/read-data/project-setting-view` — `HumanSettingView`, `WritePhase`, `projectSettingView`.
- `@/packages/notifications/read-data/read-notifications-policy` — `readNotificationsPolicy`, `PublishedRecordRow`.
- `@/packages/notifications/read-data/setting-live-source` — `buildCurrentValueSelector`, `currentRecordsFromEntry`.
- `@/packages/notifications/do-work/save-setting` — `saveSetting`.
- `@bitfield/runtime-kit/react` — `useBitfieldData`.

**Depended on by:** the package runtime surface mount; `proof/harness/mount.tsx` (renders `BlindSettingRenderer` for visual proof); `show-ios-jscore/` mirrors this contract for the JSCore surface.

## Invariants

1. Zero domain literals in source — every visible word comes from the view. Acceptance: the CS-145 UI plan's banned-term grep (the four mode names, the heading string, the mode-id key, the settings prop/action, and the workflow slot address) returns 0 matches over `show/` + `show-ios-jscore/` code (case-sensitive, excluding tests and this README). The exact token list lives in the plan, deliberately not echoed here so this file never trips its own gate.
2. The renderer is pure (no `useState`/`useEffect`, no DOM/`window`) — safe to run identically in the browser and iOS JSCore envelopes.
3. The engine is the saved-value authority: after a successful write the envelope clears its pending selection and lets the live value drive the current option.

## Proof

```bash
npx vitest run --config dev/bitfield-packages/vitest.config.ts dev/bitfield-packages/packages/notifications/show/__tests__
```
