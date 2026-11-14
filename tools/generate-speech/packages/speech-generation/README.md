# Speech Generation

Package-owned speech request, voice profile, result, and error records.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Publishes the speech-generation package entry, package input descriptors, workflow actions, contracts, and command-output parser bytes. |
| `show/` | Browser panel for composing speech generation requests from declared package inputs. |
| `do-work/` | Workflow request builders and process-output record conversion scripts. |

## Rules

- Every `useBitfieldData(...)` read in the package entry must have a matching package input descriptor in `things-to-store-and-run.json`.
- Package entry bytes are built by the source-owned entry-byte builder and written to live state; durable package-root output files are not source truth.
- This package owns speech-generation records only. It does not choose global placeable-surface discovery or runtime package-entry storage policy.
- compute.process inline-source encoding is owned by `@bitfield/runtime-kit/protocol`.
- The `published-records` input reads the generic two-column record table (`address`, `payload`). Source package metadata is optional/inferable and must not be required as a third column.
