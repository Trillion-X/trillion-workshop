# tools/legal-document-builder/

Writes a business's terms of service, privacy policy, refund policy and waiver from a clause library and the business's own facts: the Workshop tool `tool:write-legal-documents`, run in the deployed tool container. Ported from bitfield-packages `packages/legal-document-builder`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/assemble-legal-documents.ts` | Pure assembler: clause predicates against the business's facts, `{{slot}}` fill, an injected content identity per document, and `customer_ready` that stays false while a lawyer has not reviewed it, a fact is still to be confirmed, or a slot is missing. |
| `data/policy-clause-library.json` | The clause library (forty clauses across terms, privacy, refunds and waiver, each with its predicate, required facts and paragraphs), taken from the package's boundary file. |
| `do-work/write-legal-documents.mjs` | The tool's command: one JSON input in `argv[2]`, one JSON line out (each document's text, BLAKE3 `1f:` identity, clauses, readiness, missing and to-confirm facts, and every fact each document reads). |
| `records.json` | The tool's row (`ai-tool-descriptor`), listed into the Workshop by `tool-rows.json`. |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | Lists `records.json` into the Workshop (`source:business-legal-document-tools`). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `assembleDocumentsForBusiness` | `(library, instance, gate: { customer_ready }, identityOf: text => string) => AssembledDocument[]` | The one assembly entry point. |
| `predicatePasses` | `(predicate, facts) => boolean` | `{always}`, `{when_field, equals}`, `{when_field, gt}`. |
| `writeLegalDocuments` | `({ documents, facts, titles?, addresses?, reviewed_by_a_lawyer? }) => { documents, facts_it_reads, note }` | The tool's work, exported for tests. |

## Invariants

- A document's identity is the BLAKE3 identity of its assembled text (`1f:<hex>`), so a changed clause or fact is a new identity; consent refers to the identity, never to an address.
- `ready_to_publish` is false until `reviewed_by_a_lawyer` is true, no fact is marked `needs_founder_verification`, and no slot is missing. The text is drafting support, not legal advice.
- A new document type or clause is a row in `data/policy-clause-library.json`; the assembler never names one.

## Dependencies

**Depends on:** `tools/content-identity` (the BLAKE3 identity, packed at `/opt/parts/content-identity` beside this folder, with `@noble/hashes` at `/opt/node_modules/@noble/hashes`), Node 24 in the tool container.

**Depended on by:** Trillion's deploy (it bundles the files a row names); the Workshop's container executor at run time; Trillion's `test/business-tools.test.mjs`.
