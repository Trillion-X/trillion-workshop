# tools/carry-an-account-into-its-own-records/

Carrying a person's records from the old storage shapes into their own records, and the one place a filling store turns away work that only adds.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/older-repository-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. The imported-history receipt port now also has an executable `what-this-tool-does-and-how-to-run-it.json` row.

## Files

The carry of earlier stored records into the store (src/carry-forward.mjs and its test) is removed: an old store is not migrated (the old way is not a requirement). It is at the old tag only.

## Imported history receipt

`read-data/imported-history-receipt.mjs` keeps the old receipt body, stable archive ordering, inherited head and substitutions, manifest binding and byte readback. `createImportedHistoryReceipts()` uses the current pure content-identity owner; it imports no record-history engine. Its canonical identity retains the old spelling for missing fields.

`do-work/imported-history-receipt.mjs` creates a receipt, lists its archive references, or verifies them against the archive bytes its caller hands in. It writes nothing. An archive that is not handed in is reported as an error, never verified. A receipt is not a claim that an account migration has finished.

The old growth-admission decision already has its Rust owner in `trillion-rust/src/storage/record_store/store_size.rs` (`Level::refuses_growth`, `StoreSize::is_growth`). The current account volume sends growth to a further book in `src/storage/record_store_resources/books.rs`, refusing at the book limit. The old Worker-specific `store-full` route is not reinstated here.

`ports/imported-history-receipt.json` records the source-first contract; `test/imported-history-receipt.test.mjs` preserves the old readback tests.

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.
