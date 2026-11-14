# Notifications iOS JSCore

This folder owns the iOS JavaScriptCore surface envelope for the notifications
setting screen. It is an adapter over the same data contract used by the browser
surface: package records, the setting descriptor, current value rows, the blind
`HumanSettingView` projection, and the descriptor-derived action route.

## Files

- `mount-notifications-jscore.js` is the ES5 JSCore mount. It reads package
  records/current value through `package.input.read`, emits sealed native
  snapshot operations, and commits the selected opaque option through
  `runtime.target.invoke`.
- `mount-notifications-jscore.test.ts` loads the ES5 source in `node:vm`,
  compares it against the TypeScript reader/projection/write helpers, and drives
  the bridge through render, select, save, offline, malformed-route, error, and
  dispose.

## Invariants

- No React, DOM, browser globals, provider sender, push-token owner, or mobile
  delivery queue.
- Option labels, option ids, current-value keys, targets, and action routes come
  from package data.
- The JSCore mirror stays equivalent to `read-data/read-notifications-policy.ts`,
  `read-data/project-setting-view.ts`, and `do-work/save-setting.ts`; the test is
  the drift guard.
- Malformed write route templates fail the same way as the TypeScript write
  authority.
- Offline write replies preserve the selected draft option and render generic
  offline copy from adapter state.

## Proof

```bash
npx vitest run --config ~/dev/bitfield-packages/vitest.config.ts ~/dev/bitfield-packages/packages/notifications/show-ios-jscore/mount-notifications-jscore.test.ts
```

The simulator proof and exact activation blocker are recorded in
`../proof/2026-06-21-notifications-ios-jscore-proof.md`.
