# storage-sim

Simulates Trillion storage designs N days forward on the same seeded workload stream, with faults, invariant oracles and provider prices, so a design is chosen from its whole-workload consequences instead of one experiment. The engine is `architect/crates/workload-simulation`; this folder holds the Trillion candidates, their meters and the DATA.

## Run it

```bash
cd simulation      # inside trillion-rust: its .cargo/config.toml enables SQLITE_ENABLE_STMT_SCANSTATUS
cargo run --release -- \
  --candidates s0-record-log,s2-log-current,s5-versioned-row \
  --workloads all --days 30 --seed 42 --faults light \
  --root price_sheets=../../ai-command-center/notes/projects/usage-cost-tables-2026-10-28/research/price-sheets \
  --out agent-junk/2026-10-27/storage-sim/runs/<run-id>
```

- `--days 30|90|365`, `--seed N` (same seed = byte-identical `result.json`), `--faults none|light|heavy|<path>`, `--rate-scale 0.1..10` (multiply every rate), `--cost-models a.json,b.json` (first one drives the table), `--root <name>=<dir>` (folder for each named pricing root a cost model reads; the Cloudflare DO, D1 and Turso cost models read `price_sheets`, the folder of dated price sheets whose rows they select by meter name; the Mac model needs no root), `--keep-work` (keep the SQLite files), `--list` (show workload and candidate names).
- Outputs in `--out`: `result.json` (deterministic: every day, operation, meter, cause, $ and modeled latency per placement, invariants, fault events), `runs/<candidate>--<workload>.json` (written as each run finishes), `table.txt` (the comparison, also printed), `wall-clock.json` (measured local time per operation; not deterministic, never compared byte-wise).
- The run refuses to start below 10 GiB free disk. Scratch SQLite files are deleted after each run unless `--keep-work`.

### Real data (optional)

Never the live account, never the pristine tree. Clone selected objects with the existing clone owner (APFS clonefile, no ordinary-copy fallback), then pass the clone folder:

```bash
node --input-type=module -e "import('trillion-cloudflare-stop/scripts/local-restore-clone.mjs').then(m => m.cloneRestoreFile(
  'trillion-cloudflare-stop/.state/real-current-account-closure-35/storage/do/trillion-local-RecordBook/<object>.sqlite',
  'agent-junk/2026-10-27/storage-sim/seed-own-records/state/<object>.sqlite'))"
cargo run --release -- --seed-from agent-junk/2026-10-27/storage-sim/seed-own-records/state --seed-limit 20000 ...
```

`--seed-from` opens each `*.sqlite` read-only/immutable, selects current records (`i\0<id>` keys) through the real `kept_runs` winner rules, and loads the first `--seed-limit` of them into every candidate before day 1 (both projection layouts are decoded). Every current record of every file enters the profile in `run.seed_source.detail.kinds`: per kind, the record count and value bytes (mean, p50, p90, p99, max). `--seed-limit 0` profiles without seeding. The range cursors use kept_runs' largest workspace (128 MiB) because a busy store's clone holds dozens of runs; the default 2 MiB refused the founder RecordBook partway through. Only counts, kinds and value sizes enter `result.json`. Profiles taken October 27, 2026: founder RecordBook own-records (o03) 2,398,695 records, 178 kinds, 101 s (`runs/seed-profile-founder`); second account (o26) 24,263 records (`runs/seed-profile-second`), under `agent-junk/2026-10-27/storage-sim/`.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Standalone package (`[workspace]`), depends on `trillion-local` (`..`) and `workload-simulation` |
| `src/main.rs` | CLI: resolves DATA, disk guard, runs every candidate x workload, writes outputs |
| `src/lib.rs` | Library root (used by the CLI and the integration test) |
| `src/meter.rs` | `MeteredDb`: owns the observed connection; `sqlite_work` counters, index-entry meter (pre-update hook), cause scopes (`Spans`), interruption faults, gauges, unmetered inspector connection |
| `src/real_seed.rs` | Seed records and the per-kind size profile from a cloned restored object |
| `src/files.rs` | DATA file names (`resolve`), the 10 GiB disk guard and atomic JSON output, shared by every binary |
| `src/candidates/mod.rs` | Loads `candidates/<id>.json` and builds its adapter |
| `src/candidates/s0_record_log.rs` | S0: `record_log::RecordLog` + `kept_runs` as they exist, with the free-running hourly alarm; also the shared record-log store, its merge meters and `kept_runs` gauge |
| `src/candidates/s1_record_log.rs` | S1: the same store with no alarm (params have no `alarm` field); flush when full, merge steps inside writes; params override `fan_in`, `merge_backlog_runs`, `merge_pace`, `memtable_bytes` |
| `src/candidates/kit.rs` | The measured-attempt shell every SQLite candidate shares (`Work` trait: run + reopen; arm/disarm faults, charge writes, erasure rewrite) |
| `src/candidates/log.rs` | S2's log module (S2, S3, S4, record store): owner sealing keys, `log_g<n>` generation tables whose row shape is DATA (`LogShape`), seal-inside-the-write |
| `src/candidates/layout.rs` | Current-row layout parts (S2, S3, record store): declared index table `idx`, member rows `mem`, body/list split |
| `src/candidates/s2_log_current.rs` | S2: log row + current row, generic `idx`, member rows, owner-key-sealed history generations; with a tier it is S3 |
| `src/candidates/record_store_history_on_replace.rs` | record store: one current row + a reverse-diff history row only when a version is replaced; order `exact` or `coarse` (skew window, high-water row); in-row recent history N |
| `src/candidates/s3_tiered.rs` | S3: S2 + cold tier (sealed cold pages, hot index/word rows, `delete` scan eviction or `epoch` tables dropped whole) |
| `src/candidates/s4_typed_tables.rs` | S4: one typed table per kind compiled at the kind's first save, native indexes, child tables for lists, S2's log module |
| `src/candidates/s5_versioned_row.rs` | S5: one versioned row per save (current = history), optional declared index / word rows |
| `src/candidates/search.rs` | The one search port every candidate uses; `search.layout` is DATA: `scan`, `word_rows` (a row per word), `term_row` (one packed row per record), `inverted` (in-memory tail of unpersisted changes; with `persist`, packed segments as rows or archive objects, flushed and merged inside writes, no alarm; without it, memory only and rebuilt on cold start). Results are exact: tail entries are current, and a segment posting is accepted only when the record's current stamp equals its stamp |
| `src/candidates/receipts.rs` | Request receipts every candidate shares: a ring (`window_ms`, `max_entries`) inside the row the request changed; a delete leaves a tombstone row keeping it; a retry reads only that row; a retry whose receipt left the ring or the window is refused, never applied twice |
| `src/bin/usage_table.rs` | `usage-table`: the engine's usage table (`workload_simulation::usage`) over these candidates and DATA. Runs every planned run as a child process, at most `--jobs` at once and a new one only under `--max-load`, cheapest first; saves `runs/<run id>--<identity>.json` (identity = BLAKE3 of the compiled source trees and the run's workload, candidate and fault files), so a table resumes and `--price-only` re-prices saved runs for new providers without simulating |
| `usage/profiles.json` | Kinds of seat (light, typical, heavy, agents-1/10/100) as workload mixes with evidence per scale |
| `usage/seat-month-table.json` | The table question: candidate, seats 1..1,000, seeds, fault profiles, providers, horizon, team rule (u13/u14 share one team space) |
| `usage/measured-activity-2026-10-23-copy.json`, `usage/measure-activity.sql` | Measured per-day activity of the founder and second accounts from APFS clones of the restored copy, and the queries that reproduce it |
| `src/bin/search_receipt_report.rs` | `search-receipt-report <run-root> [<out.md>]`: candidate x search-variant table, receipt reads per retry on the first and last retry day, recovery reads, failures |
| `candidates/*.json` | Candidate DATA: adapter + params (variants are params, not code) |
| `workloads/*.json` | Workload DATA (U-ids from plan 03) |
| `faults/*.json` | Fault profiles none / light / heavy |
| `cost-models/*.json` | Cloudflare DO SQLite, Cloudflare D1, Turso Scaler and Mac local, in USD. The SQLite-billed stores bill rows, so the candidate's row meters are priced with no store shape; every DO, D1 and Turso price is read by meter name from the dated price sheets (root `price_sheets`: `cloudflare-durable-objects-sqlite-paid.json`, `cloudflare-d1-paid.json`, `turso-scaler.json`, `cloudflare-r2-standard.json`). Mac prices are literal 0 (`local-mac-only.json` lists every meter at 0), so the candidate tests load it with no root |
| `tests/candidates.rs` | Every candidate under heavy faults, determinism, per-action row counts |

## Meters and causes

| Meter | Source | Note |
|-------|--------|------|
| `sql_statements`, `scan_visits`, `fullscan_steps`, `vm_steps`, `rows_returned`, `row_changes` | `trillion_local::sqlite_work::WorkMeter` on the store's own connection | `scan_visits` is priced as DO `rowsRead` (proxy until CAL-5); `row_changes` excludes index entries |
| `table_rows_written` | SQLite pre-update hook, one per written row of a real table | includes deletes and REPLACE deletes |
| `index_entries_written` | per written row, each secondary index whose key changed (WITHOUT ROWID primary keys are the table) | the provider rule "an index adds a written row when the write includes the indexed column"; CAL-1 must confirm |
| `alarms_set`, `alarm_wakes`, `requests` | engine | `setAlarm` = 1 row written |
| `merge_pages`, `merge_steps`, `maintenance_refused` | `record_log::Work.maintenance` (S0, S1) | merge output pages written inside the operation's write; a refused step is rolled back to its savepoint and the save still commits |
| `kept_runs` | gauge (S0, S1) | kept runs held, summed over stores |
| `archive_puts`, `archive_bytes` | generation seal (log module), S3 cold page writes | R2 Class A |
| `archive_gets` | S3 cold point reads and cold-page locator rebuilds on reopen | R2 Class B |
| `erasure_pages_rewritten` | `meter::rewrite_erased` after an owner erasure | local file rewrite (VACUUM); unpriced on DO, where physical erasure is the provider's |
| `search_tail_entries`, `search_index_lag_ms` | `inverted` search, per search | changes not yet in a persisted segment, and the age of the oldest one (persisted-index lag; results stay exact because the tail is searched in memory) |
| `bytes_stored`, `schema_objects` | gauges (page_count x page_size; sqlite_master rows) | priced at $0.20/GB-month on DO |

Every written row carries a cause from its table (`record`, `history`, `index`, `search`, `bookkeeping`, `page_flush`, `maintenance`, `alarm`); reads carry the candidate's scope or `sqlite_work`'s fixed families for S0. The table shows per operation: statements, rows read, record rows read, rows written, record rows written, and flags every action above 1 row read or 1 row written with the causes of the extra rows.

## Add a candidate

1. Copy the shape of `src/candidates/s5_versioned_row.rs` (smallest): a `Candidate` with `id/about/meters/capabilities/params/open`, a `Core` that implements `kit::Work` (`run` one attempt in its transaction, `reopen`), and a `Store` whose `apply` is `kit::apply(&mut self.db, &mut self.core, op, fault)`. Keep history in `log.rs` (declare a `LogShape`) and reuse `layout.rs`/`search.rs` instead of new tables for the same purpose.
2. Open SQLite only through `MeteredDb::open(path, meter, classify)`; wrap each operation in `db.spans()` → work → `spans.cut(ReadCause::Scoped("<cause>"))` per purpose → `db.finish(spans)`. Give every table a cause in `classify`.
3. `crash()` drops volatile state (`kit::crash`); `recover()` reopens and returns the recovery meters. Volatile state changed inside a transaction is restored when it rolls back (record store stamps, S3 staging, S4 compiled models). After any DDL on the measured connection call `meter::schema_changed` (see Findings). `inspect()` reads through `db.inspector()` (never the measured connection). Anything the design cannot do returns `Outcome::Unsupported { reason }`.
4. Add the adapter to `Adapter` in `src/candidates/mod.rs`, add `candidates/<id>.json` with `plan_id` and params, and add it to `tests/candidates.rs`.

Planned next adapters (plan 03): **S1** is built without the maintained canonical head and checksum steps (both still to add). The overhead families S0+O must pay for are workload steps (see "Add a workload"), so every candidate stores them with its own design.

How the newer adapters model the plan (each is DATA-parameterized; variants are `candidates/*.json`):
- **record store** (`record-store-history-on-replace` = plan A16a, `record-store-exact-order`, `record-store-in-row-8` = A16d). The commit stamp `at` is a hybrid logical clock (`ms << 16 | counter`) minted by the single writer inside the write; a cold start takes the max of the open log's keys, the newest key's `cur.at`, the high-water row and (exact order) each kind's newest index entry, adding no window. Engine record keys stand for ids minted outside the commit in mint order (the engine mints a create's key at its first attempt, `op.at`): a create joins the id-ordered range when its key sorts above every committed key and `ms(at) - op.at <= skew_window_ms`; it upserts the high-water row only when `ms(at) != op.at`; otherwise it is a late create (one `late-create` log row). Retries are answered by the receipt ring in `cur` (0 receipt rows; `receipts.rs`). The engine's model moves a record to newest on every acknowledged update, even when the value is unchanged, so record store always writes a replacement (the plan's "a save that changes nothing writes no row" is not exercised).
- **S3** (`s3-cold-delete`, `s3-cold-epoch`, `cold_after_days` 7 so 30-day runs evict). A point read of a cold record needs its location without a per-record locator row, so each cold page starts with its record ids and the locator (id -> newest page) is rebuilt in memory on every reopen (one GET per page); deleting a record that has a cold copy writes one `gone` row. Lists, search and owner erasure reach cold records through the hot `idx` and the declared search, so S3 refuses scan modes. Cold rows keep no receipts, so the receipt window must be shorter than `cold_after_days`.
- **S4** (`s4-typed-tables`). A kind's model is compiled from the first value of that kind (top-level fields -> `text`/`json` columns, 16+ member lists -> child tables, overflow JSON column) and stored as DATA in `models`; the DDL is charged to that save (`schema` read cause, `schema_objects` gauge). A read carries no kind, so it probes each kind table in model order.

## Usage tables (what a team pays per month)

```bash
# inside trillion-rust, through the contained Cargo owner (the binary runs from its own target folder)
python3 <ai-command-center>/.claude/hooks/run-contained-cargo.py build --release --manifest-path simulation/Cargo.toml --bin usage-table \
  --then '{cargo_target_dir}/release/usage-table' --table simulation/usage/seat-month-table.json --profiles simulation/usage/profiles.json \
  --out <run folder> --jobs 6 --max-load 90 --root price_sheets=<price-sheets folder>
```

Outputs in `--out`: `usage-table.json` (format `workload-simulation-usage-table-result/1`: one cell per profile x seats x provider with low / median / high, per seat, by category, by evidence, drivers, capacity choice, unknowns) and `usage-table.md`. A provider whose store bills its own units (DynamoDB, Postgres compute, S3 requests) is a `shapes/<name>.json` store shape plus a cost model; the SQLite placements price the candidate's own meters.

## Command bookkeeping (`bookkeeping/`)

A separate package, `command-bookkeeping`, with its own `[workspace]` and only `serde` and `serde_json`. It simulates the durable writes around one command (quota reserve, admission, begin, commit, finish, reads, policy updates, receipt prune) on three objects (the book, the gate, the quota owner) and checks three oracles: money (every committed command charged exactly once, every lost read charged nothing, every failed paid run refunded), authority (no command commits after a policy update it was admitted before; refusals at the same stage) and acknowledged answers (a retry gets the answer that was acknowledged; no effect happens twice).

```bash
# inside trillion-rust, through the contained Cargo owner
python3 <ai-command-center>/.claude/hooks/run-contained-cargo.py build --release --offline --manifest-path simulation/bookkeeping/Cargo.toml \
  --then '{cargo_target_dir}/release/command-bookkeeping' --days 30 --seeds 42,7,1001 --out <run folder>
```

Flags: `--variants` (files in `bookkeeping/variants/`; default `main-050254ab91,floor`), `--workloads` (`u18,u22,u32` by default; `u18-probe` is the code probe's own shape for calibration, run it with `--evict off --faults none --days 1`), `--faults` (`none,light,heavy`: the per-transaction chances in `faults/<name>.json` plus `bookkeeping/faults.json`'s restarts, policy updates, idle eviction and client stalls), `--days`, `--seeds`, `--evict on,off`, `--out`. It prints one line per run and writes `command-bookkeeping.json` (rows per command by object and table, the oracles, refusals by reason, crashes by cause, and the probe window when the workload has one).

Variants: `main-050254ab91` is the lease-block protocol of the product's main branch at that commit. `floor` is the design in ai-command-center `notes/projects/trillion-storage-convergence-2026-10-27/command-bookkeeping-at-the-floor.md`. `floor-exact-reads` writes each read's measurement when it ends (idle_flush_ms 0), so an ended read's charge survives a crash, at about 4 more rows per U18 command. The four `floor-control-*` variants each remove one rule of the floor, to prove the oracles catch the loss.

## Add a workload

Write `workloads/<name>.json` (`workload-simulation-workload/1`): `stores`, `owners`, `vocabulary`, `initial` records, and `operations`. Each operation has `per_day` (per store), optional `growth_per_day`, `on_days`, `burst` (simultaneous writers) and `window_seconds`, and either:

- one `intent`: `create`, `read`, `update`, `write_member`, `delete`, `list`, `search`, `erase_owner`, `read_members` (a page of a list field), `read_as_of` (`back` changes ago), `declare` (add a field or an index to a kind), `evict` (deploy restart: `crash` + `recover`), or `new_store` (open, load, verify and delete a new account's store); or
- `steps`: one command together with its bookkeeping. Each step has a `family` (`record` for the useful work; `permit`, `policy`, `quota`, `budget`, `hold`, `meter`, `receipt`, `journal`, `inbox`, `catalogue`, `alarm`, `auth`, `screen`, ...), plus optional `repeat`, `chance` and `attempt`. A step can target an earlier step's key with `"pick": {"step": {"step": n}}`, or resend an earlier request with `{"resend": {"step": n}}`. The table prints one row per family under the operation, so the overhead share can be read straight off it.

Picks: `uniform`, `newest`, `newest_of`, `oldest`, `cycle` (walk every record once), `step`. `evict_after_idle_seconds` charges a cold start to the first request after an idle gap. The engine README (`architect/crates/workload-simulation/README.md`, "Workload operations") has the exact semantics. Put payload fields that are not user text under a name other than `text`: candidates that declare word search on `text` would otherwise index bookkeeping as words.

Shape every rate and size from measured data and cite the source in `about`. The October 27 workloads use these sources:

- [A] the every-table audit (`notes/projects/trillion-storage-convergence-2026-10-27/04-every-table-challenged.md`);
- [P] and [L] read-only immutable queries on APFS clones of the restored copy (`profile-workloads/`, `profile-lead/` under the agent-junk storage-sim folder);
- [S] the `--seed-from` profiles above.

Per-day volume is the plan's typical seat (A-TYP), matching U01–U34 (03 §3c). Each `about` also gives the measured founder rate, and K = 0.018, the second-account/founder ratio of budget permits per day (o27 11.7K/day vs o08 639K/day). The measured second-account command rate (~1,950 AI tool calls/day, about 40 bookkeeping requests each) is `--rate-scale 6.5` on U18; a one-day U18 run at that rate took more than 10 minutes on s2 alone.

| Workload | Plan | What it measures | Main measured inputs |
|---|---|---|---|
| `u03-open-large-record` | U03 | first 50 members (`read_members`) vs whole record | checklist 27 KB mean, 83–184 members of 300 B [S] |
| `u09-cold-start-deploy-storm` | U09, F7 | idle eviction at 70 s, all 35 objects restart within 60 s | 35 objects; 24,263 second-account records and kind mix [S]; 86% reads [P] |
| `u10-live-screen-updates` | U10 | change + one screen re-read (newest 1) | 0.98 screen reads per record write; 2,416 subscribes/day [L] |
| `u13-share-hidden-revoke` | U13 | grant, 50 shared reads, revoke, 5 refused reads | `sharing` 388 B [S]; 725 shared reads/day [L] |
| `u14-teammate-reads-shared` | U14 | grant read + record read | as U13 |
| `u18-metering-around-ai-command` | U18 | one tool call + permit, policy, quota, budget, hold, meter, receipt families | 6 budget permits per gate permit, 4 policy reads, 1.3%/2.1% never settled, sizes [P] |
| `u19-two-devices-settle` | U19 | 20 + 20 conflicting edits, settle read, copy position | 38 device copies [A] |
| `u20-file-upload` | U20 | name, file, 4.57 spans + chunks, folder change, journal, outbox | depth 4.27, spans per file, 7,795 folders [L]; journal sizes [A, P] |
| `u21-history-generation-volume` | U21 | per-type record-write mix that fills generations | founder record_log rows per type/day [L] x K |
| `u22-marketplace-paid-run` | U22 | hold, charge, same-key resend, result, 1-in-5 refund | commercial-event 279 B [S] |
| `u23-ai-handoff` | U23 | 6 contenders, 1 taker, 6 deliveries, 28% pulled | claims operations per hand-off [L]; 72% deliveries never pulled [A] |
| `u24-lost-response-retry` | U24 | resend after commit / attempt 2 before commit, warm and cold | 9.1% identities reused [P] |
| `u25-revoke-signin-midcommit` | U25 | 3 commits checking a session that is deleted mid-way | 1,243 sessions founder [A] |
| `u26-undo-as-of` | U26 | `read_as_of` 3 and 300 back + undo write | agent-card 45 versions in 3 days, max 4,220 [L] |
| `u27-migrate-read-back` | U27 | import + read every record back once (`cycle`) | second-account kind mix [S]; use `--seed-from` for real records |
| `u29-add-field-index-1m` | U29 | `declare` field and index on 1,038,409 records | founder execution kind count [S] |
| `u30-mac-sleep-due-items` | U30 | due items during 8 h sleep, drained oldest-first at wake | trigger outcomes 234/day founder [L] |
| `u31-resource-growth` | U31, F6 | large-value mix toward 128 MB and the cap | founder record_log bytes per type [L] x K |
| `u32-command-lifecycle` | U32 | task, permit, context, 1.9 steps, return, finish, catalogue ref; replay; catalogue list | steps per task, step/return sizes [P] |
| `u33-new-account` | U33, C11 | one new account's store, then 1,000 at once | ~770 default rows [P] |

Name a workload after its plan id (U01...U34).

## Findings this harness produced (October 27, 2026)

- **FTS5 is not measurable today**: any FTS5 insert or query leaves `sqlite_work` observation `Incomplete`. Declared search therefore uses the measurable layouts in `src/candidates/search.rs` until the `sqlite_work` owner observes FTS5.
- **`RecordLog` has no list, search or erase-by-owner API** (its `KeptRuns` is private; `record_indexes` is not wired in). S0 reports those intents `unsupported`.
- **`RecordLog` refused writes once its run count grew** (fixed October 27, 2026): `Kept(Bounds("kept range cursor workspace exhausted; maintenance or narrower range required"))`. `RecordLog` never called `KeptRuns::start_merge`/`merge_step`, so every checkpoint added a run and the range cursors outgrew `cache_bytes`. With hourly checkpoints (30 days, seed 42, light faults), ordinary saves (U01) began failing on day 6, nearly all on day 7 and every one from day 8 (9,558 of 12,000 refused); the 100-writer workload (U28) began on day 1 and refused every save from day 3 (286,907 of 300,000). Now every write takes one bounded merge step (`KeptRuns::maintain`, the original size-tier/backlog rules, paced by the bytes the write added), and a tombstone is written only while an older run may hold its key. Fixing that exposed the next wall: from day 12 every U28 save was refused with `record journal work bound exceeded: Bounds`, because each save's request-window range started at the window's low end and walked the tombstones of every request that had left it (more than the 4,096-entry budget, so expired keys stopped being removed and the 10,000-key count filled). The window now keeps its removed head (`Q\0head`) and starts after it. Regression test: `tests/record_log_maintenance.rs` in the parent crate.
- **DDL on the measured connection latched every later attempt `Incomplete`.** A statement cached before a CREATE/DROP re-prepares on its next step, and `sqlite_work` refuses a re-prepared statement's counters (they restart mid-execution), so its observation latches incomplete and every later operation on that meter fails. It hit S3's epoch roll at once (44% of operations failed in a 16-day run) and was latent in S2's generation seal (100K log rows). `meter::schema_changed` flushes the statement cache after every DDL (log seal, epoch roll, S4 kind compile).
- **`secure_delete` alone does not erase**: B-tree rebalancing leaves older copies of live cells in unallocated page space, and deleting the record does not zero them. The residue oracle found an erased record's search word this way under heavy faults. Owner erasure therefore rewrites the file (`meter::rewrite_erased`, VACUUM on a plain connection, checked WAL truncate) and reports `erasure_pages_rewritten`; VACUUM itself cannot run on the metered connection (it leaves `sqlite_work` incomplete).

## Dependencies

- `trillion-local` (path `..`, imported as `local_engine`; the one line naming it carries the package-set identity exemption because it is the crate under measurement): `sqlite_work`, `scan::ReadWork`, `record_log`, `kept_runs`, `record_stamps`.
- `workload-simulation` (path `../../architect/crates/workload-simulation`).
- `rusqlite =0.32.1` with `preupdate_hook` (index-entry meter), `blake3 =1.8.5` (archive digests, S3 cold-page subkeys), `chacha20poly1305 =0.10.1` (history and cold-page sealing), `libc` (disk guard).

## Testing

```bash
cd simulation
cargo test --release
cargo clippy --release --all-targets -- -D warnings
```
