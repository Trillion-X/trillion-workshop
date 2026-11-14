# can-see-or-do/

Generic actor/subject/capability answer package.

This package owns the package-local contract for records that answer one plain question:
can this actor see or do this capability for this subject? It does not know what a
product calls the actor, subject, or capability. Caller records provide visible copy,
entry paths, blocked reasons, and result labels.

## Files

| File | Purpose |
|---|---|
| `README.md` | Package boundary and reusable contract notes. |
| `things-to-store-and-run.json` | Runtime Kit package records for the primitive contract and input descriptor. |
| `.bitfield-entry-scope/can-see-or-do-answers/entry.ts` | Hosted entry that exports the generic answer reader to carriers that need to filter surfaces or actions. |
| `read-data/README.md` | Reader boundary notes. |
| `read-data/read-can-see-or-do-records.js` | Dumb JSON reader for answer records. |
| `read-data/read-can-see-or-do-records.d.ts` | Type contract for hosted TypeScript imports of the same reader. |
| `tests/README.md` | Test inventory. |
| `tests/can-see-or-do-records.test.mjs` | Contract tests for open-ended answer records. |

## Boundary

This package reads records and returns answers. It does not decide identity, payment,
approval, invitation, participation, or policy. Those are evidence records owned by
the package set or other packages. Missing answers are not treated as permission.
