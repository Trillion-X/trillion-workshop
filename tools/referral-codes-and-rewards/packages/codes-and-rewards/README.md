# Codes And Rewards

`codes-and-rewards` is the CS-048 owner for account-visible code, share, claim,
and activity surfaces. The backend implementation is a generic record
interaction contract: package labels are data in
`record-interaction-contract.json`, while logic reads field/view/action
descriptors and builds owner-action request records.

## Ownership

This package owns:

- record interaction contract data for its account-readable surface;
- descriptor-driven projection of current records into human-readable rows;
- descriptor-driven owner-action request materialization.

This package does not own reward math, fraud policy, payment effects, account
identity, relationship graph truth, workflow execution, HTTP calls, credentials,
process-session execution, slot lifecycle, or EEAF internals.

## Proof Commands

Run from `/workspace/the-owner/dev/bitfield-packages`:

```bash
npx vitest run --config ./vitest.config.ts packages/codes-and-rewards/read-data/read-record-interaction-surface.test.ts packages/codes-and-rewards/do-work/build-owner-action-request.test.ts packages/codes-and-rewards/tests/contract-boundary.test.ts
node -e "for (const f of ['things-to-store-and-run.json','record-interaction-contract.json','entry-to-package-data-map.json']) JSON.parse(require('fs').readFileSync('/workspace/the-owner/dev/bitfield-packages/packages/codes-and-rewards/'+f,'utf8'))"
```

The boundary test keeps the old active family dead:
`CodeReward*`, four fixed money buckets, `effectId`, local reward calculators,
network calls, provider calls, and old target sender names stay out of active
logic files.

## 2026-06-21 Backend Import Proof

Imported to the running `bitfield-studio` log with:

```bash
# Historical proof used a retired aggregate writer. Current activation:
BITFIELD_SHELL_URL=<carrier-url> node /workspace/the-owner/dev/bitfield-runtime-kit/references/background-runner-shell/scripts/apply-package-delta-live.mjs --package-set-folder <runtime-package-set-folder> --partition <running-partition> --package codes-and-rewards
```

Result: `recordWrites: 16`, cursor `156316732 -> 156321250`,
`entry-bytes::read-record-interaction-surface` wrote `12366` bytes with hash
`1f:5e23ce006fc5d704330f2900146f8a6a36237fa51da5def0243846c96dc02240`,
and `entry-bytes::build-owner-action-request` wrote `9800` bytes with hash
`1f:bed87317e3b0df020199635c6881278bb9730d0bbe28eb099ab18aea4c2cde76`.

Direct live readback found the contract record, both entry records, and both
entry-byte records in `bitfield-studio`.
