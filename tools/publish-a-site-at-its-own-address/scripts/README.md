# scripts

## Purpose

Executable gates for the CS-310 backend boundary.

## Files

| Path | Job |
| --- | --- |
| `check-generic-backend-boundary.mjs` | Rejects duplicate owner families, direct owner imports, and superseded package-specific backend classes. |
| `check-compiled-vocabulary.mjs` | Checks built/projection bytes when present, then verifies generic source has no backend/provider vocabulary leak. |

## Boundary

These scripts are proof gates only. They do not write live runtime state.
