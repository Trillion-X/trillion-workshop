# Bitfield Package Store Offer Exchange

This folder is source proposal material for `bitfield-package-store-offer-exchange`.
Live behavior belongs to the selected log fold after the package live writer writes
records through `engine.operation.write-batch`.

The active backend primitive is:

```text
Record Exchange Projection
```

Records, fields, relationships, rules, owner actions, proof rows, and process
session references are data. The TypeScript logic reads open descriptors and
builds owner-action intents. It does not execute signing, account, service,
secret, file, or process work; those effects stay with their owning packages and
runtime primitives.

## Active Files

- `data/record-exchange-descriptors.json` declares the open descriptor families.
- `data/record-exchange-fixtures.json` carries example facts, including one
  package-store example and one unrelated exchange example.
- `tools/browse-and-publish-what-my-ai-can-use/packages/bitfield-package-store-offer-exchange/read-data/read-record-exchange-projection.ts` builds a generic projection from
  descriptors and facts.
- `do-work/build-owner-action-intent.ts` builds owner-action intent payloads from
  action descriptors and explicit inputs.
- `do-work/invoke-record-exchange-action.ts` gates action invocation with rule
  results and returns an owner-target request.
- `do-work/record-owner-action-result.ts` turns owner result payloads into generic
  proof records.
- `show/` owns the shared `OfferSetupSurfaceDescriptor` contract and the pure
  mapper from `RecordExchangeProjection` to descriptor sections.
- `show-ios-jscore/` owns the browserless JavaScriptCore renderer that consumes
  that descriptor and emits sealed native view snapshot operations.
- `tests/` proves descriptor parsing, action intent shape, blocked actions, result
  recording, and generic fixture coverage.

Visible section headings, rule state labels, tones, action copy, and proof labels
are descriptor/read-model data. The JSCore renderer may dispatch on
`section.kind` only; it must not author fallback UI copy or derive readiness from
package-state vocabulary.

## Proof Path

```bash
cd /workspace/the-owner/dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/bitfield-package-store-offer-exchange/tests
npx vitest run --config ./vitest.config.ts packages/bitfield-package-store-offer-exchange/show-ios-jscore/mount-offer-setup-jscore.test.ts
node -e "JSON.parse(require('node:fs').readFileSync('packages/bitfield-package-store-offer-exchange/things-to-store-and-run.json','utf8'))"
```

Activate in the selected log only through the scoped package-delta owner:

```bash
BITFIELD_SHELL_URL=<carrier-url> node /workspace/the-owner/dev/bitfield-runtime-kit/references/background-runner-shell/scripts/apply-package-delta-live.mjs --package-set-folder <runtime-package-set-folder> --partition <running-partition> --package bitfield-package-store-offer-exchange
```
