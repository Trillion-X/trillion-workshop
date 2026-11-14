# src

## Purpose

This folder contains pure package-local backend helpers for the generic
record/action/effect/projection loop configured by `things-to-store-and-run.json`.

## Files

| Path | Job |
| --- | --- |
| `configured-record-action-projection.mjs` | Validates package configuration, creates generic events/effect receipts, folds subjects, and emits projection rows. |
| `owner-action-bindings.mjs` | Builds opaque owner-action invocation requests from configured action descriptors. |
| `projection-reader-contract.mjs` | Decodes projection rows for React/Desktop/Browser and iOS JSCore consumers. |
| `*.test.mjs` | Focused unit, contract, adversarial, owner-boundary, and platform-parity proof. |

## Boundary

Code in this folder never imports adjacent owner package internals and never
introduces public-site-specific backend classes. Product labels stay in package
data and flow through open role refs.
