//! Every DATA-defined candidate through the real engine: oracles hold under
//! heavy faults, results are byte-identical per seed, and the per-action row
//! counts the comparison relies on are what the designs claim.
//! Run: `cargo test --release` from this folder.

use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};
use storage_sim::candidates;
use workload_simulation::{run, CostModel, FaultProfile, RunConfig, RunResult, Workload};

const HOME: &str = env!("CARGO_MANIFEST_DIR");

fn workload() -> Workload {
    let note = json!({"fields": [
        {"name": "text", "shape": {"words": {"min": 4, "max": 12}}},
        {"name": "status", "shape": {"choice": {"options": ["open", "done"]}}}]});
    let decision = json!({"fields": [
        {"name": "text", "shape": {"words": {"min": 2, "max": 4}}},
        {"name": "answers", "shape": {"list": {"members": 40, "words": {"min": 2, "max": 4}}}}]});
    let w: Workload = serde_json::from_value(json!({
        "format": "workload-simulation-workload/1", "name": "contract",
        "about": "every intent, two stores, erasure on day 2",
        "stores": 2, "owners": 5, "vocabulary": 50,
        "initial": [{"kind": "note", "count": 60, "value": note}, {"kind": "decision", "count": 3, "value": decision}],
        "operations": [
            {"name": "create", "per_day": 40, "intent": {"create": {"kind": "note", "value": note}}},
            {"name": "update", "per_day": 30, "intent": {"update": {"target": {"kind": "note", "pick": "uniform"}, "field": "text", "value": {"words": {"min": 4, "max": 12}}}}},
            {"name": "member", "per_day": 20, "intent": {"write_member": {"target": {"kind": "decision", "pick": "uniform"}, "field": "answers", "value": {"words": {"min": 2, "max": 4}}}}},
            {"name": "delete", "per_day": 8, "intent": {"delete": {"target": {"kind": "note", "pick": "uniform"}}}},
            {"name": "read", "per_day": 40, "intent": {"read": {"target": {"pick": "uniform"}}}},
            {"name": "list", "per_day": 5, "intent": {"list": {"kind": "note", "limit": 10}}},
            {"name": "search", "per_day": 5, "intent": {"search": {"field": "text", "limit": 10}}},
            {"name": "erase", "on_days": [2], "intent": {"erase_owner": {}}}
        ]
    }))
    .unwrap();
    w.validate().unwrap();
    w
}

fn config(dir: &std::path::Path, faults: &str) -> RunConfig {
    RunConfig {
        seed: 11,
        days: 3,
        rate_scale: 1.0,
        faults: FaultProfile::load(&PathBuf::from(format!("{HOME}/faults/{faults}.json"))).unwrap(),
        // Row counts are what these tests check; the local model has literal
        // prices and needs no pricing root.
        cost_models: vec![CostModel::load(
            &PathBuf::from(format!("{HOME}/cost-models/mac-local-sqlite.json")),
            &BTreeMap::new(),
        )
        .unwrap()],
        work_dir: dir.to_path_buf(),
        seed_records: Vec::new(),
        final_sample: 200,
    }
}

fn simulate(id: &str, faults: &str) -> RunResult {
    let dir = tempfile::tempdir().unwrap();
    let c = candidates::load(&PathBuf::from(format!("{HOME}/candidates")), id).unwrap();
    run(c.as_ref(), &workload(), &config(dir.path(), faults))
        .unwrap()
        .0
}

fn per(r: &RunResult, op: &str, meter: &str) -> f64 {
    let s = &r.totals[op];
    s.meters.get(meter) as f64 / (s.acked + s.failed) as f64
}

#[test]
fn every_candidate_holds_its_oracles_under_heavy_faults() {
    for id in [
        "s0-record-log",
        "s0o-record-log",
        "s1-record-log",
        "s2-log-current",
        "s2h-history-on-replace",
        "s2h-exact-order",
        "s2h-in-row-8",
        "s3-cold-delete",
        "s3-cold-epoch",
        "s4-typed-tables",
        "s5-versioned-row",
        "s5-versioned-row-indexed",
        "s2h-exact-order-search-term-row",
        "s2h-exact-order-search-memory",
        "s2h-exact-order-search-segments",
        "s2h-exact-order-search-segments-cached",
        "s2h-exact-order-search-archive",
        "s2h-history-on-replace-search-segments",
        "s5-versioned-row-indexed-search-term-row",
        "s5-versioned-row-indexed-search-memory",
        "s5-versioned-row-indexed-search-segments",
        "s5-versioned-row-indexed-search-segments-cached",
        "s5-versioned-row-indexed-search-archive",
        "s2h-exact-order-search-segments-daily",
        "s5-versioned-row-indexed-search-segments-daily",
    ] {
        let r = simulate(id, "heavy");
        let i = &r.invariants;
        assert!(r.faults.crashes > 0, "{id}: heavy faults must crash stores");
        assert_eq!(i.lost_acknowledged_writes, 0, "{id}");
        assert_eq!(i.reads_wrong, 0, "{id}");
        assert_eq!(i.lists_wrong, 0, "{id}");
        assert_eq!(i.final_wrong, 0, "{id}");
        assert_eq!(i.deleted_still_readable, 0, "{id}");
        if id.starts_with("s0") || id.starts_with("s1") {
            assert!(
                r.unsupported.contains_key("erase") && r.unsupported.contains_key("search"),
                "{id}"
            );
        } else {
            assert!(i.erasures_checked > 0, "{id}");
            assert_eq!(
                i.erased_still_readable + i.erasure_residue_markers,
                0,
                "{id}: erasure left traces: {i:?}"
            );
        }
    }
}

#[test]
fn same_seed_gives_identical_result_bytes() {
    let a = serde_json::to_vec(&simulate("s2-log-current", "light")).unwrap();
    let b = serde_json::to_vec(&simulate("s2-log-current", "light")).unwrap();
    assert_eq!(a, b);
}

#[test]
fn versioned_row_saves_one_row_and_reads_one_row() {
    let r = simulate("s5-versioned-row", "none");
    assert_eq!(per(&r, "create", "table_rows_written"), 1.0);
    assert_eq!(per(&r, "create", "index_entries_written"), 0.0);
    assert_eq!(per(&r, "update", "table_rows_written"), 1.0);
    assert_eq!(per(&r, "read", "scan_visits"), 1.0);
    // The indexed variant pays its declared index and word rows separately.
    let x = simulate("s5-versioned-row-indexed", "none");
    assert_eq!(
        x.totals["create"].meters.causes["table_rows_written"]["record"],
        x.totals["create"].acked
    );
    assert!(x.totals["create"].meters.causes["table_rows_written"]["search"] > 0);
    assert_eq!(per(&x, "create", "index_entries_written"), 1.0);
}

#[test]
fn log_and_current_row_writes_two_rows_plus_declared_entries() {
    let r = simulate("s2-log-current", "none");
    let c = &r.totals["create"].meters.causes["table_rows_written"];
    let n = r.totals["create"].acked;
    assert_eq!(c["record"], n, "one current row per create");
    assert!(c["history"] >= n, "one sealed log row per create");
    assert_eq!(c["index"], 2 * n, "kind_newest + owner entries");
}

#[test]
fn history_on_replace_and_tiered_and_typed_ack_every_operation() {
    for id in [
        "s2h-history-on-replace",
        "s2h-exact-order",
        "s2h-in-row-8",
        "s3-cold-delete",
        "s3-cold-epoch",
        "s4-typed-tables",
    ] {
        let r = simulate(id, "none");
        for (op, s) in &r.totals {
            assert_eq!(
                (s.failed, s.unsupported),
                (0, 0),
                "{id} {op}: {:?}",
                s.errors
            );
        }
    }
}

#[test]
fn history_on_replace_and_tiered_and_typed_are_deterministic() {
    for id in [
        "s2h-history-on-replace",
        "s2h-in-row-8",
        "s3-cold-epoch",
        "s4-typed-tables",
    ] {
        let a = serde_json::to_vec(&simulate(id, "light")).unwrap();
        let b = serde_json::to_vec(&simulate(id, "light")).unwrap();
        assert_eq!(a, b, "{id}");
    }
}

#[test]
fn history_on_replace_creates_one_row_plus_declared_entries() {
    let causes = |r: &RunResult, op: &str| r.totals[op].meters.causes["table_rows_written"].clone();
    // Coarse order: a create is 1 current row + 1 owner entry, no history row.
    let r = simulate("s2h-history-on-replace", "none");
    let (c, n) = (causes(&r, "create"), r.totals["create"].acked);
    assert_eq!(c["record"], n, "one current row per create");
    assert_eq!(c["index"], n, "the declared owner entry only");
    assert!(!c.contains_key("history"), "no log row on create: {c:?}");
    // A replacement writes its current row and one reverse-diff log row.
    let (u, m) = (causes(&r, "update"), r.totals["update"].acked);
    assert_eq!(u["record"], m);
    assert_eq!(u["history"], m);
    // Exact order adds the kind_newest entry on create and moves it on replace.
    let x = simulate("s2h-exact-order", "none");
    assert_eq!(causes(&x, "create")["index"], 2 * x.totals["create"].acked);
    assert_eq!(causes(&x, "update")["index"], 2 * x.totals["update"].acked);
    // In-row history: a log row needs 8 replacements of one record.
    let y = simulate("s2h-in-row-8", "none");
    let h = causes(&y, "update").get("history").copied().unwrap_or(0);
    assert!(h * 8 <= y.totals["update"].acked, "in-row batches: {h}");
}

#[test]
fn tiered_store_moves_cold_records_and_reads_them_back() {
    for id in ["s3-cold-delete", "s3-cold-epoch"] {
        let dir = tempfile::tempdir().unwrap();
        let c = candidates::load(&PathBuf::from(format!("{HOME}/candidates")), id).unwrap();
        let mut cfg = config(dir.path(), "none");
        cfg.days = 16;
        let r = run(c.as_ref(), &workload(), &cfg).unwrap().0;
        let gets: u64 = r
            .totals
            .values()
            .map(|s| s.meters.get("archive_gets"))
            .sum();
        let puts: u64 = r
            .totals
            .values()
            .map(|s| s.meters.get("archive_puts"))
            .sum();
        assert!(
            puts > 0 && gets > 0,
            "{id}: cold pages written {puts}, read {gets}"
        );
        assert_eq!(
            r.invariants.reads_wrong + r.invariants.lists_wrong + r.invariants.final_wrong,
            0,
            "{id}"
        );
    }
}
