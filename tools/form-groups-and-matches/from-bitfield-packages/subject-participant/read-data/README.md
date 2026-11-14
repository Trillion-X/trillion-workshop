# subject-participant/read-data/

Readers in this package decode package-declared input records only.

They do not parse raw source-system rows, call providers, import owner slots, import sibling package source, or decide runtime ownership. If a descriptor-projected feed exists, readers consume that feed instead of reassembling owner internals.

## Files

| File | Purpose |
|---|---|
| `subject-participant-surface.js` | Declares the generic package boundary surface descriptor consumed by show code and tests |
