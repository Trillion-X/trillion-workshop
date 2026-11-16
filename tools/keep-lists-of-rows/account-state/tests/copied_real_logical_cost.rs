//! Bounded, ignored measurement of one real copied record through the current
//! logical reader. The input and all state stay private; only fixed counters
//! and SQL-template families are printed. No cloud service is contacted.
#![cfg(target_os = "macos")]

use std::{ffi::CString, fs, os::unix::ffi::OsStrExt, path::{Path, PathBuf}, sync::{atomic::AtomicBool, Arc}};
use serde::Deserialize;
use trillion_local::{
    import::FilePin,
    local_account::{LocalAccount, ProcessIdentity, SelectedLocalState},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prior { pid: u32, started_seconds: u64, started_fraction: u64 }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    state: PathBuf,
    receipt: FilePin,
    app_kv_sqlite: PathBuf,
    app_kv_store: String,
    prior_processes: Vec<Prior>,
    record_id: String,
    logical: bool,
    repeat_logical_reads: bool,
}

fn clone_tree(source: &Path, target: &Path, files: &mut usize) {
    fs::create_dir(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let source = entry.path();
        if source.file_name().is_some_and(|name| name == "local-runtime.lock") { continue; }
        let target = target.join(entry.file_name());
        let kind = entry.file_type().unwrap();
        if kind.is_dir() { clone_tree(&source, &target, files); }
        else if kind.is_file() {
            let from = CString::new(source.as_os_str().as_bytes()).unwrap();
            let to = CString::new(target.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::clonefile(from.as_ptr(), to.as_ptr(), 0) }, 0,
                "copied measurement requires APFS clonefile");
            *files += 1;
        } else { panic!("copied state contains an unsupported file kind"); }
    }
}

#[test]
#[ignore = "requires TRILLION_COPIED_LOGICAL_INPUT and APFS clone support"]
fn copied_real_exact_logical_read_cold_and_repeat() {
    let input_path = std::env::var_os("TRILLION_COPIED_LOGICAL_INPUT").expect("private input path required");
    let input: Input = serde_json::from_slice(&fs::read(input_path).unwrap()).unwrap();
    assert!(input.logical && input.repeat_logical_reads && !input.record_id.is_empty());
    let selected = tempfile::tempdir().unwrap();
    let state = selected.path().join("state");
    let mut files = 0;
    clone_tree(&input.state, &state, &mut files);
    assert!(files > 0);
    let mut owner = LocalAccount::open_selected_after_handoff(SelectedLocalState {
        root: state,
        receipt: input.receipt,
        app_kv_sqlite: input.app_kv_sqlite,
        app_kv_store: input.app_kv_store,
        prior_processes: input.prior_processes.into_iter().map(|p| ProcessIdentity {
            pid: p.pid, started_seconds: p.started_seconds, started_fraction: p.started_fraction,
        }).collect(),
    }).unwrap();
    let session = owner.session_identity();
    #[cfg(feature = "sql-statement-attribution")]
    let trace = unsafe { owner.enable_fixture_sql_attribution(512).unwrap() };
    for phase in ["first", "repeat"] {
        let before = owner.sql_work().unwrap();
        #[cfg(feature = "sql-statement-attribution")]
        let before_sql = trace.fixture_statement_snapshot().unwrap();
        let answer = owner.current_logical_record(&session, &input.record_id,
            Default::default(), Arc::new(AtomicBool::new(false)));
        if let Err(failure) = &answer {
            eprintln!("copied-real-logical-refusal phase={phase} stage={} kind={:?} final_snapshot_refused={}",
                failure.stage, failure.kind, failure.final_snapshot_refused);
        }
        let after = owner.sql_work().unwrap();
        let a = &after.work; let b = &before.work;
        eprintln!("copied-real-logical phase={phase} outcome={} sql={} visits={} writes={} returned={} fullscan={} vm={}",
            if answer.is_ok() { "ok" } else { "refused" },
            a.sql_statements-b.sql_statements, a.sqlite_scan_visits-b.sqlite_scan_visits,
            a.rows_written-b.rows_written, a.rows_returned-b.rows_returned,
            a.fullscan_steps-b.fullscan_steps, a.vm_steps-b.vm_steps);
        for (old, current) in before.families.iter().zip(after.families.iter()) {
            let visits = current.work.sqlite_scan_visits-old.work.sqlite_scan_visits;
            let writes = current.work.rows_written-old.work.rows_written;
            if visits != 0 || writes != 0 {
                eprintln!("copied-real-logical-family phase={phase} family={} visits={visits} writes={writes}", current.family.label());
            }
        }
        #[cfg(feature = "sql-statement-attribution")]
        {
            let after_sql = trace.fixture_statement_snapshot().unwrap();
            assert!(after_sql.complete, "fixture SQL attribution incomplete");
            let mut visits = Vec::new();
            for current in &after_sql.statements {
                let old = before_sql.statements.iter().find(|old| old.sql_template == current.sql_template);
                let old_visits = old.map_or(0, |old| old.work.sqlite_scan_visits);
                let delta = current.work.sqlite_scan_visits-old_visits;
                if delta == 0 { continue; }
                let sql = current.sql_template.to_ascii_lowercase();
                let family = if sql.contains("record_keys_run_") { "checkpoint-page" }
                    else if sql.contains("record_keys_runs") { "checkpoint-runs" }
                    else if sql.contains("record_keys_big") { "checkpoint-big-value" }
                    else if sql.contains("record_log") { "journal" }
                    else if sql.contains("sqlite_schema") || sql.contains("sqlite_master") || sql.contains("pragma_table_list") { "catalogue" }
                    else if sql.contains("policy_directory") { "policy" }
                    else if sql.contains("_mf_entries") { "session-kv" }
                    else if sql.contains("versions") { "record-store-version" }
                    else { "other" };
                visits.push((family, delta));
            }
            visits.sort_by(|a, b| b.1.cmp(&a.1));
            for (family, count) in visits.into_iter().take(12) {
                eprintln!("copied-real-logical-query phase={phase} family={family} visits={count}");
            }
        }
        assert!(answer.is_ok(), "copied real exact-ID logical read refused");
    }
}
