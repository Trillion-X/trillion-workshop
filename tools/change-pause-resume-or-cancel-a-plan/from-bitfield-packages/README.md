# plan-lifecycle

Package source proposal for CS-107.

`plan-lifecycle` is implemented as data over generic record work: records,
fields, relationships, projections, rules, actions, owner targets, results, and
proof. The package may carry user-facing labels such as "Change plan", "Pause",
"Resume", and "Cancel" in data. It does not introduce a lifecycle backend
engine, lifecycle action enum, provider bridge, or package-specific runtime
method.

## Source Classification

- Source workshop: `bitfield-packages/packages/plan-lifecycle`
- Boundary file: `things-to-store-and-run.json`
- Live app truth remains the selected root `stored-data/envelope.log` fold after
  approved package import/write. This folder is proposal material until that
  write path makes it current.

## Proof

Focused backend proof:

```bash
cd bitfield-packages
npx vitest run --config ./vitest.config.ts packages/plan-lifecycle/tests/record-work-backend.test.ts
node -e "JSON.parse(require('fs').readFileSync('packages/plan-lifecycle/things-to-store-and-run.json','utf8')); console.log('plan-lifecycle boundary json ok')"
```

Focused iOS JSCore proof:

```bash
cd bitfield-packages
npx vitest run --config ./vitest.config.ts packages/plan-lifecycle/show-ios-jscore/mount-plan-lifecycle-jscore.test.ts
```

The iOS renderer consumes `PlanLifecycleSurfaceDescriptor` from
`show/plan-lifecycle-surface-descriptor.ts`, emits sealed native snapshot
operations, and imports no React.
