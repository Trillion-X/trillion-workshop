//! Complete selected-browser HTTP read of one original workspace row.
//! The input is a private descriptor; only an APFS clone is opened by the
//! request. Neither labels nor values are printed.
use super::*;
use content_crypto::advanced::blake3;

#[cfg(target_os = "macos")]
pub(super) fn reopened_app(path: &Path) -> (Router, Arc<Mutex<SelectedAccount>>) {
    let root = fs::canonicalize(path).unwrap();
    let selection = Selection::from_descriptor(
        &root.join("adoption.json"), &root.join("frontend-selection.json"), &root.join("state"), AUTHORITY.parse().unwrap()).unwrap();
    let selected_local = SelectedLocalState {
        root: selection.selected.root.clone(),
        receipt: selection.selected.receipt.clone(),
        app_kv_sqlite: selection.selected.app_kv_sqlite.clone(),
        app_kv_store: selection.selected.app_kv_store.clone(),
        prior_processes: selection.selected.prior_processes.clone(),
    };
    let account = LocalAccount::open_selected_after_handoff(selected_local).unwrap();
    let owner = Arc::new(Mutex::new(SelectedAccount::new(account, selection).unwrap()));
    let settings = WorkspaceSessionSettings::from_source(SETTINGS, blake3::hash(SETTINGS).to_hex().as_str()).unwrap();
    let sessions = WorkspaceSessions::new(owner.clone(), ORIGIN, settings).unwrap();
    let local = Arc::new(LocalWorkspace::new(owner.clone(), sessions.clone()).unwrap());
    let routes = OwnerRoutes::from_source(OWNER_ROUTES, blake3::hash(OWNER_ROUTES).to_hex().as_str()).unwrap();
    let first = br#"{"paths":{},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"startup_preferences":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}}"#;
    let startup = StartupContract::from_sources(first, blake3::hash(first).to_hex().as_str(), b"{}", blake3::hash(b"{}").to_hex().as_str()).unwrap();
    let canonical = Arc::new(CanonicalWorkspace::new(routes, startup, local, None));
    let assets_root = root.join("assets");
    let manifest = fs::read(assets_root.join("workspace/files.json")).unwrap();
    let assets = Arc::new(WorkspaceAssets::open(&assets_root, blake3::hash(&manifest).to_hex().as_str(), &tree_pin(&assets_root)).unwrap());
    let app = workspace::route_table(assets, WorkspaceSupplies {
        sessions: Some(Arc::new(sessions)), operations: Some(canonical), live: None,
        dom: WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap(),
    }, WorkspaceLimits::default()).unwrap();
    (app, owner)
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires the private copied-account descriptor"]
async fn copied_real_one_workspace_row_cold_and_repeat_http() {
    use std::{ffi::CString, os::unix::{ffi::OsStrExt, fs::PermissionsExt}};
    fn clone_file(source: &Path, target: &Path) {
        let source = CString::new(source.as_os_str().as_bytes()).unwrap();
        let target = CString::new(target.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::clonefile(source.as_ptr(), target.as_ptr(), 0) }, 0,
            "a copied-account test requires an APFS clone");
    }
    let descriptor = PathBuf::from(std::env::var_os("TRILLION_HEAD_LIFECYCLE_INPUT").unwrap());
    assert_eq!(fs::metadata(&descriptor).unwrap().permissions().mode() & 0o777, 0o600);
    let config: Value = serde_json::from_slice(&fs::read(descriptor).unwrap()).unwrap();
    let original = fs::canonicalize(config["database"].as_str().unwrap()).unwrap();
    let original_db = Connection::open_with_flags(&original, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    // Select a real, bounded value without revealing its label or bytes.
    let (label, value): (String, String) = original_db.query_row(
        "SELECT label,value FROM workspace_records WHERE length(value)<2048 ORDER BY length(value),label LIMIT 1",
        [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let expected: Value = serde_json::from_str(&value).unwrap();
    #[cfg(feature = "sql-statement-attribution")]
    CATCH_READ_TRACE.with(|flag| flag.set(true));
    let f = Fixture::new(&[]);
    #[cfg(feature = "sql-statement-attribution")]
    let trace = CATCH_READ_METER.with(|slot| slot.borrow_mut().take().unwrap());
    fs::remove_file(&f.records).unwrap();
    clone_file(&original, &f.records);
    fs::set_permissions(&f.records, fs::Permissions::from_mode(0o600)).unwrap();
    let wal_source = PathBuf::from(format!("{}-wal", original.display()));
    if wal_source.exists() {
        let wal_target = PathBuf::from(format!("{}-wal", f.records.display()));
        clone_file(&wal_source, &wal_target);
        fs::set_permissions(wal_target, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("label", &label).finish();
    let path = format!("/work/api/records?{query}");
    for phase in ["cold", "repeat"] {
        #[cfg(feature = "sql-statement-attribution")]
        let trace_before = trace.fixture_statement_snapshot().unwrap();
        let before_observation = f.owner.lock().unwrap().sql_work().unwrap();
        let before = before_observation.work;
        let response = f.app.clone().oneshot(request("GET", &path, None)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{phase}");
        let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 8 * 1024 * 1024).await.unwrap()).unwrap();
        assert_eq!(body["records"][label.as_str()], expected, "{phase}: exact source value");
        assert_eq!(body["records"].as_object().unwrap().len(), 1, "{phase}: one selected row");
        let after_observation = f.owner.lock().unwrap().sql_work().unwrap();
        let after = after_observation.work;
        eprintln!("copied-one-workspace-http phase={phase} statements={} visits={} returned={} writes={}",
            after.sql_statements-before.sql_statements,
            after.sqlite_scan_visits-before.sqlite_scan_visits,
            after.rows_returned-before.rows_returned,
            after.rows_written-before.rows_written);
        eprintln!("copied-one-workspace-http phase={phase} unattributed_rows={}",
            after_observation.unattributed_row_events-before_observation.unattributed_row_events);
        for (old, new) in before_observation.families.iter().zip(after_observation.families.iter()) {
            let rows = new.work.rows_returned-old.work.rows_returned;
            let visits = new.work.sqlite_scan_visits-old.work.sqlite_scan_visits;
            if rows != 0 || visits != 0 {
                eprintln!("copied-one-workspace-family phase={phase} family={} rows={rows} visits={visits}",new.family.label());
            }
        }
        #[cfg(feature = "sql-statement-attribution")]
        {
            let trace_after = trace.fixture_statement_snapshot().unwrap();
            for row in &trace_after.statements {
                let old = trace_before.statements.iter().find(|old| old.sql_template == row.sql_template);
                let old_rows = old.map_or(0, |old| old.work.rows_returned);
                let rows = row.work.rows_returned - old_rows;
                if rows == 0 { continue }
                let template = row.sql_template.to_ascii_lowercase();
                let family = if template.contains("workspace_records") { "workspace_records" }
                    else if template.contains("sqlite_schema") || template.contains("sqlite_master") { "catalogue" }
                    else if template.contains("table_info") { "columns" }
                    else if template.contains("_mf_entries") { "session_kv" }
                    else if template.contains("policy_directory") { "policy" }
                    else { "other" };
                eprintln!("copied-one-workspace-template phase={phase} family={family} pin={} rows={rows}",
                    blake3::hash(row.sql_template.as_bytes()).to_hex());
            }
            assert!(trace_after.complete, "complete SQL template attribution");
        }
        assert_eq!(after.rows_written-before.rows_written, 0, "GET must not write");
    }
    // Release the first state lock while retaining its exact copied
    // state. A second local owner cannot legitimately claim a live first one.
    let Fixture { _temp: held_temp, app, adapter, owner, .. } = f;
    drop((app, adapter, owner));
    let (reopened, owner) = reopened_app(held_temp.path());
    let before_observation = owner.lock().unwrap().sql_work().unwrap();
    let before = before_observation.work;
    let response = reopened.oneshot(request("GET", &path, None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK, "restart");
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 8 * 1024 * 1024).await.unwrap()).unwrap();
    assert_eq!(body["records"][label.as_str()], expected, "restart: exact source value");
    assert_eq!(body["records"].as_object().unwrap().len(), 1);
    let after_observation = owner.lock().unwrap().sql_work().unwrap();
    let after = after_observation.work;
    eprintln!("copied-one-workspace-http phase=restart statements={} visits={} returned={} writes={}",
        after.sql_statements-before.sql_statements,
        after.sqlite_scan_visits-before.sqlite_scan_visits,
        after.rows_returned-before.rows_returned,
        after.rows_written-before.rows_written);
    eprintln!("copied-one-workspace-http phase=restart unattributed_rows={}",
        after_observation.unattributed_row_events-before_observation.unattributed_row_events);
    for (old, new) in before_observation.families.iter().zip(after_observation.families.iter()) {
        let rows = new.work.rows_returned-old.work.rows_returned;
        let visits = new.work.sqlite_scan_visits-old.work.sqlite_scan_visits;
        if rows != 0 || visits != 0 {
            eprintln!("copied-one-workspace-family phase=restart family={} rows={rows} visits={visits}",new.family.label());
        }
    }
    assert_eq!(after.rows_written-before.rows_written, 0, "GET must not write");
}
