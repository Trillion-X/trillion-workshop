// tests/local_workspace/tool_screens.rs
// Purpose: Exercise the proposed tool-screen mount through the existing actual LocalWorkspace route table and selected LocalAccount fixture.
// Invariants: Synthetic state only; release the initial fixture mount before preparing its next pinned cohort; no alternate product executor/reader or locale claim.
// Security: All HTTP checks traverse real sessions, selected source, catalog reader, snapshot finish and final disclosure checks. No production account/provider/state is touched.
// AI Assistant Directive: Preserve these opposing controls and distinguish synthetic collation from original ICU qualification.

use super::*;
use content_crypto::advanced::blake3;
use std::{
    cmp::Ordering,
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
};
use trillion_local::{
    ecma_json::JsString,
    native_boot::tool_screens::{ReadLimits, ToolLabelLocale},
    workspace_tool_screens::Failure,
};

#[derive(Clone, Copy)]
pub(super) enum Change {
    None,
    Catalog,
    Source,
    Cancelled,
}
struct FixtureLabels {
    change: Change,
    once: AtomicBool,
    kv: PathBuf,
    part_key: String,
    descriptor: PathBuf,
}
impl ToolLabelLocale for FixtureLabels {
    fn assert_current(&self) -> Result<(), Failure> {
        Ok(())
    }
    fn compare(&self, left: &JsString, right: &JsString) -> Result<Ordering, Failure> {
        if matches!(self.change, Change::Cancelled) {
            return Err(trillion_local::cause!(Failure::Cancelled));
        }
        // This is explicitly a fixed-label fixture comparator, never a locale
        // fallback or a claim that Rust ordinal ordering equals localeCompare.
        let rank = |value: &JsString| -> Result<usize, Failure> {
            // The installed fixture tool has no label: its id is its label.
            ["Alpha", "Beta", "Saved", "Unforeseen", "tool:kept-records"]
                .iter()
                .position(|label| value == &JsString::from(*label))
                .ok_or(trillion_local::cause!(Failure::Source))
        };
        let order = rank(left)?.cmp(&rank(right)?);
        if !self.once.swap(true, AtomicOrdering::AcqRel) {
            match self.change {
                Change::None => {}
                Change::Catalog => {
                    Connection::open(&self.kv)
                        .unwrap()
                        .execute("DELETE FROM _mf_entries WHERE key=?", [&self.part_key])
                        .unwrap();
                }
                Change::Source => {
                    // Same JSON with changed physical/byte identity withdraws
                    // the selected descriptor after its first catalog read.
                    use std::io::Write;
                    fs::OpenOptions::new()
                        .append(true)
                        .open(&self.descriptor)
                        .unwrap()
                        .write_all(b" ")
                        .unwrap();
                }
                Change::Cancelled => {}
            }
        }
        Ok(order)
    }
}

pub(super) struct ToolFixture {
    _temp: TempDir,
    pub(super) app: Router,
    pub(super) owner: Arc<Mutex<SelectedAccount>>,
    pub(super) session: String,
    pub(super) user: String,
    pub(super) records: PathBuf,
    pub(super) session_blob: PathBuf,
    pub(super) app_kv: PathBuf,
    pub(super) part_key: String,
    pub(super) receipt_path: PathBuf,
    adapter: Arc<ExecutorAdapter>,
    catalog_identity: String,
    labels: Arc<FixtureLabels>,
    pub(super) tool_screens_path: String,
    /// The app's carried file map as this fixture wrote it (path -> pin): what a build of the app holds.
    pub(super) carried: Value,
}
impl ToolFixture {
    pub(super) fn new(operator: bool, publisher: bool, change: Change) -> Self {
        Self::with_rows(operator, publisher, change, &[])
    }
    /// The same fixture with `extra` added to the account's shared Workshop catalog rows, and nothing else changed.
    pub(super) fn with_rows(operator: bool, publisher: bool, change: Change, extra: &[Value]) -> Self {
        Self::build(Some((operator, publisher, extra)), change)
    }
    /// An account as `account create` makes it: no restored WORKSHOP_IDENTITY, no shipped catalog in its KV, no PERSON
    /// row, no saved tools. Its tools are the Workshop copy installed in its state folder, here the fixture tools plus
    /// one tool with a screen (`tool:alpha`).
    pub(super) fn fresh(change: Change) -> Self {
        Self::build(None, change)
    }
    fn build(carried: Option<(bool, bool, &[Value])>, change: Change) -> Self {
        // Reuse the existing target's complete cold schema, session and route table asset
        // setup, then release ALL its Arcs before preparing the next cohort.
        let Fixture {
            _temp,
            records,
            session_blob,
            app_kv,
            session_id,
            user,
            app,
            adapter,
            owner,
        } = Fixture::new(&[]);
        drop(app);
        drop(adapter);
        drop(owner);
        let root = fs::canonicalize(_temp.path()).unwrap();
        let state = root.join("state");
        assert!(!state.join("local-runtime.lock").exists());
        let receipt_path = state.join("restore-receipt.json");
        let (identity, part_key) = match carried {
            Some((operator, publisher, extra)) => {
                Self::carried_catalog(&state, &records, &app_kv, &receipt_path, &user, (operator, publisher), extra)
            }
            None => {
                // The account's own record store, as its first start leaves it, and one installed tool with a screen
                // beside the fixture's installed tools.
                super::record_book(&records);
                let folder = state.join("workshop/tools/fixture-screens");
                fs::create_dir_all(&folder).unwrap();
                let rows = json!({"records":[{"payload":{"kind":"ai-tool-descriptor","id":"tool:alpha","label":"Alpha","screen":{"kind":"parts"}}}]});
                fs::write(folder.join("tool-rows.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
                (String::new(), String::new())
            }
        };
        let receipt_bytes = fs::read(&receipt_path).unwrap();
        let descriptor = root.join("adoption.json");
        let mut selection_data =
            crate::carried_selection::read_selection(&descriptor, &root.join("frontend-selection.json"));
        selection_data["receipt_identity"] = json!(blake3::hash(&receipt_bytes).to_hex().as_str());
        selection_data["native"]["receipt_bytes"] = json!(receipt_bytes.len());
        let first_value = json!({"kept":{"store_prefix":"trillion-kept-"},"tool_screens_per_read":1,"paths":{"tool_screens":"/work/api/workshop/screens"},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"startup_preferences":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}});
        let tool_screens_path = first_value["paths"]["tool_screens"]
            .as_str()
            .unwrap()
            .to_owned();
        let first = serde_json::to_vec(&first_value).unwrap();
        let routes=serde_json::to_vec(&json!({"families":[{"family":"screen-host","methods":["GET"],"browser":true,"exact":["/screens"],"prefix":[]}]})).unwrap();
        selection_data["native"]["frontend"]["first_answers"] =
            pin(&root.join("first-answers.json"), &first);
        let surfaces = br#"{"surfaces":[]}"#;
        let looks=br#"{"screen_icon":"Fixture","tool_surface_defaults":{"package_entry":{"package_name":"fixture-package","entry_name":"fixture-host"},"placement_labels":["fixture-place"],"material_target":"component:fixture-host"}}"#;
        selection_data["native"]["frontend"]["tool_screens"] = json!({"surfaces":pin(&root.join("tool-surfaces.json"),surfaces),"looks":pin(&root.join("tool-looks.json"),looks),"host":"fixture-host"});
        let carried = crate::carried_selection::write_selection(&descriptor, &selection_data);
        let carried_files = serde_json::from_slice::<Value>(&fs::read(&carried).unwrap()).unwrap()["files"].clone();
        let selected =
            Selection::from_descriptor(&descriptor, &carried, &state, "127.0.0.1:7189".parse().unwrap())
                .unwrap();
        let selected_state = SelectedLocalState {
            root: selected.selected.root.clone(),
            receipt: selected.selected.receipt.clone(),
            app_kv_sqlite: selected.selected.app_kv_sqlite.clone(),
            app_kv_store: selected.selected.app_kv_store.clone(),
            prior_processes: selected.selected.prior_processes.clone(),
        };
        let account = LocalAccount::open_selected_after_handoff(selected_state).unwrap();
        let owner = Arc::new(Mutex::new(SelectedAccount::new(account, selected).unwrap()));
        let settings =
            WorkspaceSessionSettings::from_source(&first, blake3::hash(&first).to_hex().as_str())
                .unwrap();
        let sessions = WorkspaceSessions::new(owner.clone(), ORIGIN, settings).unwrap();
        let locale = Arc::new(FixtureLabels {
            change,
            once: AtomicBool::new(false),
            kv: app_kv.clone(),
            part_key: part_key.clone(),
            descriptor,
        });
        let executor = Arc::new(
            LocalWorkspace::new(owner.clone(), sessions.clone())
                .unwrap()
                .with_tool_screens(locale.clone(), ReadLimits::default()),
        );
        let adapter = Arc::new(ExecutorAdapter {
            inner: executor,
            input_override: Mutex::new(None),
            operation_override: Mutex::new(None),
            head_context: Mutex::new(None),
        });
        let routes =
            OwnerRoutes::from_source(&routes, blake3::hash(&routes).to_hex().as_str()).unwrap();
        let startup = StartupContract::from_sources(
            &first,
            blake3::hash(&first).to_hex().as_str(),
            b"{}",
            blake3::hash(b"{}").to_hex().as_str(),
        )
        .unwrap();
        let canonical = Arc::new(CanonicalWorkspace::new(
            routes,
            startup,
            adapter.clone(),
            None,
        ));
        let assets = root.join("assets");
        let manifest = fs::read(assets.join("workspace/files.json")).unwrap();
        let assets = Arc::new(
            WorkspaceAssets::open(
                &assets,
                blake3::hash(&manifest).to_hex().as_str(),
                &tree_pin(&assets),
            )
            .unwrap(),
        );
        let dom = WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap();
        let app = workspace::route_table(
            assets,
            WorkspaceSupplies {
                sessions: Some(Arc::new(sessions)),
                operations: Some(canonical),
                live: None,
                dom,
            },
            WorkspaceLimits::default(),
        )
        .unwrap();
        Self {
            _temp,
            app,
            owner,
            session: session_id,
            user,
            records,
            session_blob,
            app_kv,
            part_key,
            receipt_path,
            adapter,
            catalog_identity: identity,
            labels: locale,
            tool_screens_path,
            carried: carried_files,
        }
    }
    /// The restored shape: saved tools in the record store, a PERSON row, the shipped catalog in the account's KV under
    /// the receipt's WORKSHOP_IDENTITY, and the publisher settings. Answers the catalog identity and its part key.
    fn carried_catalog(
        state: &Path,
        records: &Path,
        app_kv: &Path,
        receipt_path: &Path,
        user: &str,
        (operator, publisher): (bool, bool),
        extra: &[Value],
    ) -> (String, String) {
        let db = Connection::open(&records).unwrap();
        db.execute_batch("CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL); CREATE INDEX workshop_facts_current ON workshop_facts(entity,seq); CREATE TABLE workshop_current(entity TEXT PRIMARY KEY,seq INTEGER NOT NULL,kind TEXT,scope TEXT,due INTEGER,expires INTEGER) WITHOUT ROWID; CREATE TABLE workshop_current_filled(id INTEGER PRIMARY KEY CHECK(id=1),after TEXT NOT NULL,done INTEGER NOT NULL); INSERT INTO workshop_current_filled VALUES(1,'',1);").unwrap();
        for id in ["tool:saved-a", "tool:saved-b"] {
            let row = json!({"kind":"ai-tool-descriptor","id":id,"label":"Saved","screen":{"kind":"parts"}});
            db.execute(
                "INSERT INTO workshop_facts(at,entity,value) VALUES('fixture',?,?)",
                rusqlite::params![id, row.to_string()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO workshop_current(entity,seq) VALUES(?,?)",
                rusqlite::params![id, db.last_insert_rowid()],
            )
            .unwrap();
        }
        db.close().unwrap();
        // The account's own record store, as its first start leaves it.
        super::record_book(&records);
        let index_path = state.join("objects.jsonl");
        let mut index = fs::read(&index_path).unwrap();
        index.extend(serde_json::to_vec(&json!({"binding":"PERSON","className":"PersonStore","originalId":OWNER_ID,"localId":"abababababababababababababababababababababababababababababababab","names":[user]})).unwrap());
        index.push(b'\n');
        fs::write(&index_path, &index).unwrap();
        let mut rows = json!([
            {"kind":"tool-placement","id":"fixture-place","label":"Fixture placement","executor":"fixture-executor","reachable_from":["hosted","fixture-host"]},
            {"kind":"ai-tool-descriptor","id":"tool:alpha","label":"Alpha","screen":{"kind":"parts"}},
            {"kind":"ai-tool-descriptor","id":"tool:beta","label":"Beta","placements":["fixture-place"],"invoke":{"kind":"fixture-read"},"screen":{"kind":"parts"}}
        ]);
        rows.as_array_mut().unwrap().extend(extra.iter().cloned());
        let raw = serde_json::to_vec(&rows).unwrap();
        let identity = blake3::hash(&raw).to_hex().to_string();
        let part_key = format!("workshop:rows:{identity}:0");
        let blobs = state.join("storage/kv/trillion-local-app/blobs");
        fs::write(blobs.join("bb"), b"1").unwrap();
        fs::write(blobs.join("cc"), &raw).unwrap();
        let kv = Connection::open(&app_kv).unwrap();
        for (key, blob) in [
            (format!("workshop:rows:{identity}:parts"), "bb"),
            (part_key.clone(), "cc"),
        ] {
            kv.execute(
                "INSERT INTO _mf_entries(key,blob_id,expiration) VALUES(?,?,NULL)",
                rusqlite::params![key, blob],
            )
            .unwrap();
        }
        let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        receipt["objects"]["count"] = json!(4);
        receipt["objects"]["bytes"] = json!(index.len());
        receipt["objects"]["fileIdentity"] = json!(blake3::hash(&index).to_hex().as_str());
        receipt["environment"] = json!({"WORKSHOP_IDENTITY":identity});
        if operator {
            receipt["environment"]["OPERATOR_ACCOUNT_ID"] = json!(user);
        }
        if publisher {
            receipt["environment"]["MARKETPLACE_PUBLISHER_ACCOUNT_ID"] = json!(user);
        } else {
            receipt["bindingCredentials"] =
                json!({"MARKETPLACE_PUBLISHER_ACCOUNT_ID":"fixture-publisher-ref"});
        }
        fs::write(receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        (identity, part_key)
    }
    pub(super) async fn page(&self, path: &str) -> (StatusCode, Value) {
        self.call("GET", path, None).await
    }
    pub(super) async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(request(method, path, body))
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).expect("actual route JSON envelope"),
        )
    }
    pub(super) fn cancel_last_request(&self) {
        self.adapter
            .head_context
            .lock()
            .unwrap()
            .take()
            .expect("actual canonical request context")
            .permit
            .cancel();
    }
}

#[tokio::test]
async fn actual_selected_tool_page_mount_uses_pinned_data_and_raw_physical_cursor() {
    let f = ToolFixture::new(true, true, Change::None);
    let (status, body) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["next"], "tool:saved-a");
    let rows = body["surfaces"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .map(|v| v["source"]["tool_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tool:alpha", "tool:beta", "tool:saved-a"]
    );
    assert_eq!(
        rows[0]["package_entry"],
        json!({"package_name":"fixture-package","entry_name":"fixture-host"})
    );
    let (status, body) = f.page("/work/api/screens?after=tool%3Asaved-a").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["surfaces"].as_array().unwrap().len(), 1);
    assert_eq!(body["surfaces"][0]["source"]["tool_id"], "tool:saved-b");
    assert!(body["next"].is_null());
}

#[tokio::test]
async fn actual_d_first_answer_reaches_the_same_selected_catalog_reader() {
    let f = ToolFixture::new(true, true, Change::None);
    let path = f.tool_screens_path.as_str();
    let (status, body) = f.page(path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["next"], "tool:saved-a");
    assert_eq!(body["surfaces"].as_array().unwrap().len(), 3);
    let (status, body) = f
        .page(&format!(
            "{path}?ignored=value&after=tool%3Asaved-a&after=tool%3Asaved-b"
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["surfaces"].as_array().unwrap().len(), 1);
    assert_eq!(body["surfaces"][0]["source"]["tool_id"], "tool:saved-b");
}

#[tokio::test]
async fn d_tool_screens_adapter_refuses_wrong_method_path_and_query() {
    let f = ToolFixture::new(true, true, Change::None);
    for (method, path, body) in [
        ("POST", f.tool_screens_path.as_str(), Some("{}")),
        ("GET", "/work/api/workshop/not-screens", None),
        ("GET", "/work/api/workshop/screens?after=%GG", None),
    ] {
        let (status, answer) = f.call(method, path, body).await;
        if method == "POST" {
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "the fixture's read-only parent refuses writes"
            );
        } else {
            assert!(
                matches!(
                    status,
                    StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND
                ),
                "unexpected status {status} for {method} {path}: {answer}"
            );
        }
        assert!(answer.get("surfaces").is_none());
    }
}

#[tokio::test]
async fn d_tool_screens_adapter_withholds_rows_after_source_withdrawal_or_cancellation() {
    for (change, expected) in [
        (Change::Source, StatusCode::SERVICE_UNAVAILABLE),
        (Change::Cancelled, StatusCode::CONFLICT),
    ] {
        let f = ToolFixture::new(true, true, change);
        let (status, answer) = f.page(f.tool_screens_path.as_str()).await;
        assert_eq!(status, expected);
        assert!(answer.get("surfaces").is_none());
        assert!(!answer.to_string().contains("Alpha"));
    }
}
#[tokio::test]
async fn genuine_optional_operator_absence_keeps_the_actual_selected_publisher_catalog() {
    let f = ToolFixture::new(false, true, Change::None);
    let (status, body) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["surfaces"].as_array().unwrap().len(), 3);
    let catalog = f
        .owner
        .lock()
        .unwrap()
        .current_tools_catalog(&f.session, &Default::default(), &AtomicBool::new(false))
        .unwrap();
    assert_eq!(catalog.shipped_identity, f.catalog_identity);
}
/// The catalog is assembled once and kept while what it was read from is unchanged; a change to the account's KV
/// after a read is seen by the next read, never answered from the kept catalog.
#[tokio::test]
async fn a_kept_catalog_is_answered_again_only_while_its_kv_is_unchanged() {
    let f = ToolFixture::new(false, true, Change::None);
    let (status, first) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK);
    let (status, again) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first, again, "an unchanged account answers the same page from its kept catalog");
    Connection::open(&f.app_kv)
        .unwrap()
        .execute("DELETE FROM _mf_entries WHERE key=?", [&f.part_key])
        .unwrap();
    let (status, after) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "a removed catalog part is read again, not kept");
    assert!(after.get("surfaces").is_none());
}
#[tokio::test]
async fn unresolved_credential_publisher_cannot_become_an_empty_success_page() {
    let f = ToolFixture::new(true, false, Change::None);
    let (status, body) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.get("surfaces").is_none());
    assert!(!body.to_string().contains("fixture-publisher-ref"));
    assert!(!f.labels.once.load(AtomicOrdering::Acquire));
}
#[tokio::test]
async fn catalog_withdrawal_during_real_page_projection_withholds_all_surfaces() {
    let f = ToolFixture::new(true, true, Change::Catalog);
    let (status, body) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.get("surfaces").is_none());
    assert!(!body.to_string().contains("Alpha"));
    assert!(
        f.labels.once.load(AtomicOrdering::Acquire),
        "withdrawal must actually reach the projection comparator"
    );
}
#[tokio::test]
async fn selected_source_withdrawal_during_real_page_projection_withholds_all_surfaces() {
    let f = ToolFixture::new(true, true, Change::Source);
    let (status, body) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.get("surfaces").is_none());
    assert!(!body.to_string().contains("Alpha"));
    assert!(
        f.labels.once.load(AtomicOrdering::Acquire),
        "withdrawal must actually reach the projection comparator"
    );
}

/// A screen from a publisher and of a kind that no engine, app or installer code names is offered from the account's
/// rows alone: the catalog row is the only change, and the app's carried file map is byte for byte the same, so adding
/// it needed no engine, app or installer build. Nothing in the engine reads the publisher's name or the screen's kind.
#[tokio::test]
async fn an_unforeseen_publisher_screen_kind_is_offered_from_rows_only() {
    let unforeseen = json!({
        "kind":"ai-tool-descriptor","id":"tool:unforeseen","label":"Unforeseen",
        "publisher":"publisher-no-code-names","made_by":"publisher-no-code-names",
        "screen":{"kind":"a-screen-kind-no-code-names","layout":{"made":"up"}}
    });
    let before = ToolFixture::new(true, true, Change::None);
    let after = ToolFixture::with_rows(true, true, Change::None, &[unforeseen]);
    assert_eq!(before.carried, after.carried, "the app's carried files are the same: no build added anything");
    let ids = |body: &Value| -> Vec<String> {
        body["surfaces"].as_array().unwrap().iter().map(|v| v["source"]["tool_id"].as_str().unwrap().to_owned()).collect()
    };
    let (status, body) = before.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK);
    assert!(!ids(&body).contains(&"tool:unforeseen".to_owned()));
    let (status, body) = after.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK);
    assert!(ids(&body).contains(&"tool:unforeseen".to_owned()), "the row's screen is offered: {body}");
    let row = body["surfaces"].as_array().unwrap().iter().find(|v| v["source"]["tool_id"] == "tool:unforeseen").unwrap();
    assert_eq!(row["route_paths"], json!(["/use/unforeseen"]));
}

/// An account made by `account create` has no restored WORKSHOP_IDENTITY and no shipped catalog in its KV: those come
/// only with an account carried from old Trillion. Its tools are the Workshop copy installed in its state folder, the
/// same copy every computer installs from the signed Workshop feed, so its workspace reads its screens from that copy.
/// Nov 13 2026: every workspace data call of a fresh scratch account answered 503 (tools_catalog Failure::Integrity),
/// so no new account could open its workspace.
#[tokio::test]
async fn a_fresh_account_reads_its_tool_screens_from_its_installed_workshop() {
    let f = ToolFixture::fresh(Change::None);
    let (status, body) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ids: Vec<&str> = body["surfaces"].as_array().unwrap().iter().map(|v| v["source"]["tool_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["tool:alpha"], "the installed tool with a screen is offered: {body}");
    let (status, again) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, again, "an unchanged installed copy answers the same page");

    // A tool installed later is read at the next request: the catalog is the installed copy now, never a kept older one.
    let folder = fs::canonicalize(f._temp.path()).unwrap().join("state/workshop/tools/fixture-later");
    fs::create_dir_all(&folder).unwrap();
    let rows = json!({"records":[{"payload":{"kind":"ai-tool-descriptor","id":"tool:beta","label":"Beta","screen":{"kind":"parts"}}}]});
    fs::write(folder.join("tool-rows.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
    let (status, after) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK, "{after}");
    let ids: Vec<&str> = after["surfaces"].as_array().unwrap().iter().map(|v| v["source"]["tool_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["tool:alpha", "tool:beta"]);
}

/// An installed Workshop's rows are bigger than the surfaces' 2 MiB program bound (3,076,761 bytes at Workshop commit
/// 7588b8c8 on Nov 13 2026): the shared catalog is bounded as its reader admitted it, so its tool screens still answer.
#[tokio::test]
async fn an_installed_catalog_past_the_program_bound_still_answers_its_screens() {
    let f = ToolFixture::fresh(Change::None);
    let folder = fs::canonicalize(f._temp.path()).unwrap().join("state/workshop/tools/fixture-large");
    fs::create_dir_all(&folder).unwrap();
    let rows = json!({"records":[{"payload":{"kind":"ai-tool-descriptor","id":"tool:beta","label":"Beta","screen":{"kind":"parts"},
        "record_model":{"_what":"x".repeat(3 * 1024 * 1024)}}}]});
    fs::write(folder.join("tool-rows.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
    let (status, body) = f.page("/work/api/screens").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ids: Vec<&str> = body["surfaces"].as_array().unwrap().iter().map(|v| v["source"]["tool_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["tool:alpha", "tool:beta"]);
}
