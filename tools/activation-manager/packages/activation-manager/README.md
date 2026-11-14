# activation-manager

Package source for generic capability readiness and device permission surfaces.

This folder is source/proposal material until admitted through the package
implementation path. Live authority comes from log-owned package state.

## 2026-06-22 Logic/Backend Rebase Implementation

- The source workshop existed when backend implementation began; the June 20
  plan's "path does not exist today" fact is now superseded by current source
  evidence.
- Backend logic now uses open capability-state records, maintained projections,
  descriptor-driven owner-action invocation, caller-context descriptors, and
  workflow request descriptors.
- Retired backend source files were deleted: `do-work/authorize-device-grant.ts`,
  `do-work/authorize-device-grant-target.ts`, and
  `do-work/revoke-activation.ts`.
- Built stored bytes were refreshed for active entries and the obsolete
  `entry-bytes-authorize-device-grant-target` artifact was removed.
- Focused proof:

```bash
cd /workspace/the-owner/dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/activation-manager
jq -e . packages/activation-manager/things-to-store-and-run.json
rg -n "signed-event|VALID_STATUSES|effect\\.kind|event_type|activation\\.granted|activation\\.revoked|authorize-device-grant-target|revoke-activation|browser-session-browser-id|BROWSER_SESSION_TARGET" packages/activation-manager/read-data packages/activation-manager/do-work packages/activation-manager/things-to-store-and-run.json packages/activation-manager/index.ts packages/activation-manager/built-stored-bytes
```

## iOS JSCore

`show-ios-jscore/mount-activation-manager-jscore.js` is the package-owned
JavaScriptCore/native screen-command entry. It consumes the same
capability-state projection returned by `read-data/read-activations.ts`
(`views[]`, state descriptors, action descriptors, and evidence refs) and emits
only sealed native operations: `native.view.snapshot.replace`,
`native.view.snapshot.dispose`, and descriptor-sourced `runtime.target.invoke`
press payloads.

Proof:

```bash
cd /workspace/the-owner/dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/activation-manager/show-ios-jscore/mount-activation-manager-jscore.test.ts
jq -e '.package == "activation-manager" and (.things | length > 0)' packages/activation-manager/things-to-store-and-run.json
```

Simulator proof and exact shell blocker evidence live in
`packages/activation-manager/proofs/activation-manager-ios-jscore-proof.md`.
