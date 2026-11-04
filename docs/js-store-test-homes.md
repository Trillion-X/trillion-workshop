# Tests that import the old JS record store copy → their new homes

The copy is `tools/keep-and-wake-ai-sessions-on-this-computer` `src/local-store.mjs`, `src/record-engine.mjs`,
`parts/record-log/do-work/record-log-store.mjs` and `parts/eeaf/do-work/eeaf-sqlite-store.mjs`. 51 files outside that
tool import it (50 tests and one helper). The record store is the engine's (trillion-rust `src/storage/record_store`); a
Workshop tool reaches records through the door (`tools/records-door`) and proves its own logic on
`tools/records-door/test-support/records-fake.mjs`.

Homes: **A** is the tool's own test on records-fake. **B** is a store test, whose behaviour a Rust test holds (or the
engine lacks it, named). **C** is split per case. Rust paths: short names are under `src/storage/record_store/`;
`record_tables_tests.rs` and `generations_tests.rs` are under `src/storage/sqlite/`; `record_write_model.rs` is under `src/`.
"sqlite SQL" means the tool keeps its own SQL tables through `sqliteHost`. That is not the record store, and those
tables need their own home: the tool's records through the door, or the engine's typed tables.

## Measure
- A 40 (the helper included), B 7, C 4. 16 A files already pass on records-fake as it is (after #196).
- These cannot run on main today because modules are missing: `move-the-rows…/agent-records` (`hand-work-to-ais/handoff-projection.mjs`),
  `record-log/record-copies` and `record-log/record-sync-selected-bucket-stability` (`record-log/do-work/record-log-store.mjs`),
  `offer-my-work-as-ag-ui-events/ag-ui` (`see-what-my-ais-did/execution-context.mjs`). Already failing:
  `record-log/record-bucket-directory` test 1 (a fixture hash).

## Files
| file | tests | home | what it proves | blockers / Rust test |
|---|---|---|---|---|
| answer-one-search…/search-relative-floor | 2 | A | the relative score floor keeps strong candidates | sqlite SQL (candidate pages) |
| carry-an-account…/carry-forward | 2 | A | an earlier store is replayed with its times; a bad copy is refused | versions (`valuesAt`), writes at `application_time`, settings, whole-store read |
| find-my-records…/search-word-index | 3 | A | FTS row replace, bounded admission | sqlite SQL (FTS5) |
| find-the-slot-a-job-fills/job-slots | 13 | A | job tool pages, cursors, cold reopen | sqlite SQL |
| find-the-slot-a-job-fills/tool-listing | 4 | A | catalogue walk, restart on change | sqlite SQL |
| formulas/list-value-history | 4 | A | a field's history, who wrote it | none: passes on the fake |
| hand-off-jobs…/live-work-output-limit | 2 | A | an oversized result leaves the job taken | sqlite SQL |
| keep-a-running-owners…/operational-state | 3 | C | rows per changed key, no-op, rollback | 1–2 B: missing in engine, "an unchanged write writes nothing" (port doc row 22); rollback `partial_tests.rs::a_refused_write_leaves_the_remembered_value_as_committed`; `partial_tests.rs::a_member_written_makes_its_record_read_fresh_and_another_store_over_the_same_file_is_seen`. 3 A: sqlite SQL |
| keep-an-accounts…/public-app-record-bridge | 4 | A | visitor submissions are retry-safe | `eeaf.find`; sqlite SQL (space_items) |
| keep-each-task…/original-work-installation-shard | 1 | A | reserve, freeze, install | sqlite SQL |
| keep-each-task…/original-work-resource-affinity | 2 | A | durable affinity, tombstones | sqlite SQL |
| keep-each-task…/original-work-resource-catalogue | 5 | A | catalogue pages, carry | sqlite SQL |
| keep-each-task…/original-work-resource-selection | 13 | A | identity to resource, rollback, bounds | sqlite SQL |
| keep-lists-of-rows/list-keeper | 1 | A | sub-task placement through the list writer | none |
| keep-my-calendar…/task-proposals | 4 | A | proposals, approve once, undo | a list's own declared index (`manual_order`) |
| keep-one-notice-list…/notices-backlog | 3 | A | bounded notice pages, claims | none: passes on the fake |
| keep-the-exact-first-answer…/native-local-command-receipts-rebuild | 6 | A | receipts rebuild a lost answer | none for records; its fixture keeps a SQL table |
| move-a-dated-plan/date-shift | 9 | A | shifting dated plans and tasks | `manual_order` |
| move-the-rows…/agent-records | 37 | C | agent store paging, review, moving old tables | 33 A: `scanSelectedValues`, `scanFirstValues`, `lastPerGroup`, `fields.projectOf/fieldsOf`, sqlite SQL. 4 B: one log row per transaction is missing in engine (row 22), rollback `records_conformance.rs::a_write_refused_anywhere_inside_a_change_leaves_nothing_and_the_retry_applies_once`; `kept_runs.rs::byte_limits_bound_cache_memtable_output_and_read_work`; `generations_tests.rs::indexes_go_first_rows_only_above_the_drop_size_then_the_owner_drops_what_is_left` |
| organize-my-files/file-type | 4 | A | type from name | 3–4 sqlite SQL (namespace) |
| organize-my-files/file-versions | 4 | A | version families, latest | 4 sqlite SQL |
| plan-tasks…/calendar-task-messages | 6 | A | message to todo, once | `manual_order` |
| plan-tasks…/calendar-tasks-amie | 12 | A | task settings, reorder, undo | `manual_order`; `scan` `before`/`reverse` |
| plan-tasks…/calendar-tasks | 35 | A | Calendar tasks over Lists | `manual_order`; `scan` `before`/`reverse` |
| price-and-sell…/commercial-events | 4 | C | retry-safe events by funnel index | 1–3 A (own fake already). 4 B: `record_log_store_ported.rs::l181_…`, `::l205_…`, `mod.rs::an_order_no_longer_declared_leaves_the_store_and_fills_again_from_the_start_when_declared_again` |
| put-a-site…/public-app-domain-probe-current-refusal | 4 | A | HTTPS probe keeps typed refusals | SQL only as a fixture (a Map would do) |
| query-and-change-list-rows/choice-mapping | 5 | A | choices keep meaning when rows move | none |
| query-and-change-list-rows/list-history | 4 | A | removed rows restored; tombstones; stamps | 1, 4: `log({record_id})`, `resolved`, `scan` `reverse`/`to` (restore from history: records:read { id, at } covers the value) |
| query-and-change-list-rows/list-link-index | 4 | A | backlinks, dangling links | `holdersOf`, `model` (store side `holders_tests.rs::holders_are_answered_in_order_and_follow_every_change`) |
| query-and-change-list-rows/list-people | 10 | A | people merged across sources | none |
| query-and-change-list-rows/list-roots-and-machine-fields | 3 | A | domain roots, machine fields | none |
| query-and-change-list-rows/list-row-operations | 11 | A | required fields, merge, totals | none |
| query-and-change-list-rows/list-unique-keys | 5 | A | unique keys, backfill | none |
| query-and-change-list-rows/lists-ordering | 5 | A | manual order: move, fill, page | `manual_order`; `scan` `before`/`after_id`/`reverse` |
| read-one-workspace…/native-workspace-document-history-owner | 8 | A | revisions, restore, cleanup | sqlite SQL |
| read-one-workspace…/native-workspace-write-contract | 2 | A | conditional saves refuse stale writes | 2 sqlite SQL |
| recently-deleted…/namespace-child-folders | 2 | A | child folders by bounded seeks | sqlite SQL |
| recently-deleted…/namespace-folder-conditional | 10 | A | folder moves, conditional edits | sqlite SQL |
| recently-deleted…/namespace-list-cursor | 1 | A | folder page streams rows | sqlite SQL |
| recently-deleted…/namespace-names-promised | 8 | A | a promised name survives unfinished sends | sqlite SQL |
| recently-deleted…/namespace-summary-cost | 3 | A | summary counts stay exact | sqlite SQL |
| recently-deleted…/namespace-view | 4 | A | name search, refresh after delete | sqlite SQL |
| record-log/copy-page-key-metadata | 2 | B | erasure keys through bucket-page owner proofs | missing in engine: erasure keys on bucket pages (`record_sync.rs:46` "Not ported"); `record_erasure_owner.rs::authentic_sealed_marker_keeps_physical_owner_and_full_same_endpoint_path` |
| record-log/copy-page-key-owners | 4 | B | page owner proofs refuse forged pages | the same gap; `record_sync_tests.rs::bucket_pages_are_bounded_by_records_and_bytes` |
| record-log/record-bucket-directory | 13 | B | bucket pages ordered, bounded, resumable | `record_sync_tests.rs::bucket_pages_are_bounded_by_records_and_bytes`, `::settle_a_computer_whose_log_is_gone_is_settled_by_bucket_and_gives_back_what_only_it_holds`; directory layout n/a; missing in engine: `shareFields` and erasable keys in pages |
| record-log/record-copies | 9 | B | prior kept, undo, readAt, layers, settle | `tests/record_log.rs::delta_retains_was_added_and_prior_without_duplicate_record_history`, `history_tests.rs::a_record_reads_as_it_was_saved_at_each_moment`, `::a_moment_the_kept_versions_no_longer_reach_is_answered_incomplete`, `record_sync_tests.rs::digest_roots_match_old_trillion_for_the_same_rows`, `::stamps_merge_like_old_trillion_in_either_order`, `::settle_*`; missing in engine: undo a transaction, record layers |
| record-log/record-sync-selected-bucket-stability | 2 | B | settle keeps a stable group | `record_sync_tests.rs::bucket_a_group_that_keeps_moving_while_read_is_left_for_the_next_settle`, `::bucket_records_that_arrived_changed_are_refused_with_nothing_taken`; untested in Rust: group stability under unrelated writes, single-change retry |
| record-log/record-table-integration | 23 | B | strict model batches; typed SQL tables | `record_write_model.rs::final_batch_model_validates_row_before_its_declaration`, `::noop_entry_does_not_promote_old_losing_declaration`, `::winner_deletion_does_not_resurrect_previous_declaration`, `::live_model_is_open_and_does_not_apply_guard_properties`, `::base_property_definition_wins_over_user_declaration`; `record_tables_tests.rs::customer_kinds_create_typed_columns_…` and 6 more; missing: see below |
| shared-code/test/agent-store-for-tests.mjs (helper) | 0 | A | agent store for tests | used by `offer-my-work-as-ag-ui-events/test/ag-ui.test.mjs`; needs the agent-records methods |
| slot-table/slot-table | 6 | C | slot table; store pages and layouts | 1–2 A (pure). 3 B `record_log_store_ported.rs::l389_…`, `::l926_…`, `partial_tests.rs::the_memory_stays_bounded_…`; 4–6 B `kept_runs.rs::canonical_legacy_layout1_layout2_…`, `::utf16_key_order_prefixes_escapes_and_utf16_value_lengths_are_preserved`, `::merge_is_bounded_resumable_and_preserves_newest_values_through_restart` |
| turn-a-list-column…/naming-fields | 3 | A | name fields become links at idle | `holdersOf`; versions (`valuesAt`) |

## What records-fake (and the door) still lack, by number of files
- the tool's own SQL tables: 23. These need a records home of their own, not the fake;
- a list's own declared index (`manual_order`, declared after the fake is made): 6;
- `scan` `reverse` / `before` / `to` / `after_id`: 4;
- versions read as `valuesAt` or `log` (the value at a moment is `readAt`, since #196): 3;
- `holdersOf` / `model`: 2; agent reads (`scanSelectedValues`, `scanFirstValues`, `lastPerGroup`, `fields.*`): 2; `find`: 1;
  settings and writes at a given time: 1.

## Missing in the engine
1. Erasure keys beside rows on bucket pages and in settle, with page owner proofs (`record_sync.rs:46`).
2. Shared-field collections (`shareFields`) in sync.
3. Undoing a transaction field by field, with conflicts.
4. Record layers: read as if, merge in one write, discard.
5. One log row for several records, and nothing written for an unchanged value (port doc row 22).
6. Typed tables: backfill of rows already kept in bounded pages, reset of a partial move, old schema changes copied
   once, partial declaration changes in write order.
7. In code but untested in Rust: settle group stability and the single-change retry (`read_group`), the WITHOUT
   ROWID remake (`record_tables.rs:419`), `put_many`.
