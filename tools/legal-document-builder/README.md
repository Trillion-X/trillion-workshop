# tools/legal-document-builder/

Writes a business's terms of service, privacy policy, refund policy and waiver from a clause library and the business's own facts, and makes a sales contract ready to give out (what the buyer accepts, the terms as rows, the file request, an approval link): the Workshop tools `tool:write-legal-documents` and `tool:make-a-sales-contract`, run in the deployed tool container. Ported from bitfield-packages `packages/legal-document-builder` and `packages/sales-contract-builder`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/assemble-legal-documents.ts` | Pure assembler: clause predicates against the business's facts, `{{slot}}` fill, an injected content identity per document, and `customer_ready` that stays false while a lawyer has not reviewed it, a fact is still to be confirmed, or a slot is missing. |
| `read-data/project-to-prose-page-record.ts` | An assembled document as a prose page record (nav, heading, paragraphs); route, brand and nav are the caller's. Carried from the package. |
| `read-data/project-to-blocks-page-record.ts` | An assembled document as a blocks page record (strong headings, plain paragraphs); carried from the package. |
| `read-data/contract-output.ts` | Pure contract output: acceptance requirements, the terms as rows, the file request, the approval link and its reading back. Carried from `sales-contract-builder`'s `read-data/sales-contract-output-targets.ts`, with its engine plumbing left out. |
| `data/policy-clause-library.json` | The clause library (forty clauses across terms, privacy, refunds and waiver, each with its predicate, required facts and paragraphs), taken from the package's boundary file. |
| `data/contract-output-targets.json` | The file forms a contract can be made in (PDF, CSV, Excel, Markdown, text), each with its extension and the format id the file maker knows it by. |
| `do-work/write-legal-documents.mjs` | The first tool's command: one JSON input in `argv[2]`, one JSON line out (each document's text, BLAKE3 `1f:` identity, clauses, readiness, missing and to-confirm facts, and every fact each document reads). |
| `do-work/make-a-sales-contract.mjs` | The second tool's command: one JSON request on standard input, `{ result: { acceptance_requirements, terms_rows, file_request, output_forms, approval_link? } }` out. |
| `records.json` | The tools' rows (`ai-tool-descriptor`), listed into the Workshop by `tool-rows.json`. |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | Lists `records.json` into the Workshop (`source:business-legal-document-tools`). |
| `test/assemble-legal-documents.test.ts` | The package's assembler tests (predicates, slot fill and gates, a business from DATA alone, identity parity over made-up businesses). |
| `test/project-to-prose-page-record.test.ts` | The package's page-record tests, plus new tests of the blocks projection. |
| `test/contract-output.test.ts` | New: the contract output (the package had no test). |
| `test/commands.test.mjs` | New: both commands, their answers and refusals. |
| `test/fixtures/` | Three made-up businesses and the identities of their documents. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `assembleDocumentsForBusiness` | `(library, instance, gate: { customer_ready }, identityOf: text => string) => AssembledDocument[]` | The one assembly entry point. |
| `predicatePasses` | `(predicate, facts) => boolean` | `{always}`, `{when_field, equals}`, `{when_field, gt}`. |
| `writeLegalDocuments` | `({ documents, facts, titles?, addresses?, reviewed_by_a_lawyer? }) => { documents, facts_it_reads, note }` | The first tool's work, exported for tests. |
| `makeSalesContract` | `({ contract, formats?, actor_id?, base_url?, request_id?, created_at?, locale? }) => { acceptance_requirements, terms_rows, file_request, output_forms, approval_link? }` | The second tool's work. |
| `acceptanceRequirementsForContract` / `contractTermsRows` | `(contract) => string[]`, `(contract, locale) => string[][]` | What the buyer accepts; the contract's facts and one row per rule. |
| `fileRequestFromApproval` | `(request, locale) => structured-file-output.request` | The request `tool:export-documents-to-files` turns into files. |
| `buildApprovalRequest` / `readApprovalRequestFromLocation` | see file | The approval link carries the whole request; reading it back refuses a link whose id differs. |

## Invariants

- A document's identity is the BLAKE3 identity of its assembled text (`1f:<hex>`), so a changed clause or fact is a new identity; consent refers to the identity, never to an address.
- `ready_to_publish` is false until `reviewed_by_a_lawyer` is true, no fact is marked `needs_founder_verification`, and no slot is missing. The text is drafting support, not legal advice.
- A new document type or clause is a row in `data/policy-clause-library.json`; the assembler never names one. A new file form for a contract is a row in `data/contract-output-targets.json`.
- A contract is any JSON with `rules`: a `Commitment` rule asks for the payment acknowledgement, one with a payment schedule asks for the installment authorization. Money is written in the locale the caller names (`en-US` by default), never the machine's.

## Dependencies

**Depends on:** `tools/content-identity` (the BLAKE3 identity, packed at `/opt/parts/content-identity` beside this folder, with `@noble/hashes` at `/opt/node_modules/@noble/hashes`) for `tool:write-legal-documents`, Node 24 in the tool container.

**Depended on by:** Trillion's deploy (it bundles the files a row names); the Workshop's container executor at run time; Trillion's `test/business-tools.test.mjs`.
