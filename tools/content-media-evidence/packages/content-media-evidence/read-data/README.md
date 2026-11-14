# Content Media Evidence Reader

This folder decodes the maintained content/media evidence projection for package surfaces.

Reader output is package-local presentation data: rows by role plus plain blocker text. It does not invoke workflow, stage files, or expose internal feed names as user copy.

## Exact result inventory

`exact-result-inventory.ts` turns a complete, package-bound page chain of canonical
materialized relations into exact result facts. It keeps the declared observable and
original-byte demands separate, refuses relation-identity conflicts and truncated
cursor chains, and performs no I/O or semantic classification.

## The relation-address grammar

`content-media-evidence.ts` also owns the relation-address grammar, and is the ONLY
place it is spelled.

| Export | Shape | Role |
|---|---|---|
| `RELATION_ADDRESS_PREFIX` | `string` | `package::content-media-evidence::relation::` |
| `relationAddress(scopeRef, idempotencyRef)` | `(string, string) => string` | Compose `PREFIX + enc(scope) :: enc(idempotency)`. The scope is always owner-derived from an admission; only the idempotency leaf may come from a caller |
| `isRelationAddress(value)` | `(string) => boolean` | Prefix test, so no caller re-spells the prefix to check one |

It lives in this folder rather than beside either target because an address has a
WRITER and a READER that must agree on its grammar, and neither of them may own it.
`materialize-artifact-target.ts` composes to write and `read-guarded-artifact-target.ts`
recomposes to verify a stored row sits at an address matching its own fields. They held
byte-identical copies until 2026-09-05: editing one alone would have made the reader
reject rows the writer legitimately produced, reported as a stored-row integrity error
rather than as the code split it was.

Two OTHER address kinds exist in this package and are not part of this grammar:
`relation-row::` and `receipt::` are composed in `do-work/record-relations-target.ts`
and exported there as `contentMediaEvidenceOwnerAddresses`. They share the package
prefix and are separately owned; do not fold them in here.

The declared rule `the-relation-address-grammar-is-spelled-in-exactly-one-place`
reports any file that re-spells the grammar, and exempts this one by path.
