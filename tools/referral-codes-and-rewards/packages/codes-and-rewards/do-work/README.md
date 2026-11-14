# Do Work

This folder builds request records for existing owners. It does not execute
workflow steps, HTTP calls, payment effects, account changes, or process
sessions.

`build-owner-action-request.ts` reads action descriptors and returns either an
`owner-action-request`, a local presentation acknowledgement for copy-only
controls, or a machine-readable error.
