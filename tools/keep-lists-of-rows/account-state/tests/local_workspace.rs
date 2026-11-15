// Purpose: Exercise the native LocalWorkspace through the real workspace route table and canonical adapter.
// Invariants: use only a synthetic selected local account and RECORD_BOOK; no app/adoption claim or writes.
// Key Concepts: current @own-records admission, original selection semantics, exact ECMAScript JSON output.
// Security: fixture credentials and stores are synthetic; unsupported operations never gain a record capability.

#![cfg(unix)]

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use content_crypto::advanced::blake3;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tempfile::TempDir;
use tower::ServiceExt;
use trillion_local::{
    import::FilePin,
    local_account::{LocalAccount, SelectedLocalState},
    local_workspace::LocalWorkspace,
    native_boot::{SelectedAccount, Selection},
    workspace::{
        self, WorkspaceAssets, WorkspaceDom, WorkspaceLimits, WorkspaceOperations,
        WorkspaceSupplies,
    },
    workspace_domain::{
        BrowserScope, CanonicalWorkspace, CanonicalWorkspaceExecutor, DomainAnswer, DomainCommand,
        DomainContext, OwnerRoutes, StartupContract,
    },
    workspace_session::{WorkspaceSessionSettings, WorkspaceSessions},
};

#[path = "support/carried_selection.rs"]
mod carried_selection;
#[path = "support/installed_tools.rs"]
mod installed_tools;

#[path = "local_workspace/heads.rs"]
mod live_heads_controls;

#[path = "local_workspace/tool_screens.rs"]
mod local_tool_screens_controls;

#[path = "local_workspace/public_programs.rs"]
mod public_program_controls;

#[cfg(feature = "exact-native-locale")]
#[path = "support/workshop_data.rs"]
mod workshop_data;

#[cfg(feature = "exact-native-locale")]
#[path = "local_workspace/show_rules.rs"]
mod show_rules_controls;

#[path = "local_workspace/copied_one_record.rs"]
mod copied_one_record_controls;
#[path = "local_workspace/owner_contention.rs"]
mod owner_contention_controls;

#[path = "local_workspace/finite_read_replay.rs"]
mod finite_read_replay_controls;

#[path = "local_workspace/domain_transfer.rs"]
mod domain_transfer_controls;

#[path = "local_workspace/records_write.rs"]
mod records_write_controls;

#[path = "local_workspace/lists_rules_and_runs.rs"]
mod lists_rules_and_runs;

#[path = "local_workspace/tool_run.rs"]
mod tool_run_controls;

#[path = "local_workspace/tool_http_response.rs"]
mod tool_http_response_controls;

#[path = "local_workspace/files_page.rs"]
mod files_page_controls;

#[path = "drafts/record_delivery.rs"]
mod record_delivery_controls;

// Synthetic retained token: the production reader admits exactly 64 lowercase hex bytes.
const TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USER: &str = "fixture-user";
const OWNER_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// The account's RECORD_BOOK with every record store family (created where missing).
fn record_book(path: &Path) {
    {
        drop(
            trillion_local::storage::sqlite::open_owned(
                path,
                "record_store",
                trillion_local::storage::sqlite::Bounds {
                    value_bytes: 64 * 1024 * 1024,
                    work: u64::MAX / 2,
                    deadline: std::time::Duration::MAX,
                    spend: trillion_local::storage::sqlite::Spend::EachOperation,
                    cancel: None,
                    busy: std::time::Duration::from_secs(5),
                },
            )
            .unwrap(),
        );
    }
}
/// Write (with `None` remove) one record of the account's workspace store,
/// the record store resource every workspace reader serves. `value` is JSON text.
fn workspace_put(path: &Path, label: &str, value: Option<&str>) {
    record_book(path);
    let db = Connection::open(path).unwrap();
    let mut workspace = trillion_local::workspace_store::Workspace::lend(
        &db,
        OWNER_ID,
        trillion_local::storage::sqlite::Access::Write,
    )
    .unwrap();
    let (version, _) = workspace.get(label).unwrap();
    let value = value
        .map(|text| trillion_local::ecma_json::parse(text.as_bytes(), Default::default()).unwrap());
    workspace
        .change(
            label,
            version,
            value.as_ref(),
            &format!("fixture:{label}:{version}"),
        )
        .unwrap();
}
/// The live-heads records head: the own-records record store scope stamp, as text.
fn own_records_stamp(path: &Path) -> String {
    let db = Connection::open(path).unwrap();
    trillion_local::workspace_store::lend_store(&db, trillion_local::storage::sqlite::Access::Read)
        .unwrap()
        .stamp(OWNER_ID, "own-records")
        .unwrap()
        .to_string()
}
/// The stored JSON text of one workspace record.
fn workspace_text(path: &Path, label: &str) -> Option<String> {
    let db = Connection::open(path).unwrap();
    let workspace = trillion_local::workspace_store::Workspace::lend(
        &db,
        OWNER_ID,
        trillion_local::storage::sqlite::Access::Read,
    )
    .unwrap();
    workspace.get(label).unwrap().1.map(|(text, _)| text)
}
const ORIGIN: &str = "http://127.0.0.1:7189";
const AUTHORITY: &str = "127.0.0.1:7189";
const CREATED: &str = "2026-10-25T20:00:00.000Z";
const OWNER_ROUTES: &[u8] = br#"{"families":[{"family":"fixture","exact":["/unused"],"prefix":[]},{"family":"workspace","exact":["/unsupported"],"prefix":[]},{"family":"@workshop-tools","methods":["GET","POST"],"exact":[],"prefix":["/door/tools:"]},{"family":"@namespace","methods":["GET","POST"],"exact":[],"prefix":["/files/"]},{"family":"@own-records","methods":["GET"],"exact":[],"prefix":["/door/"]}]}"#;
const SETTINGS: &[u8] = br#"{"kept":{"store_prefix":"trillion-kept-"}}"#;
const DOM: &[u8] =
    br#"{"element_id":"page-answers","item_reads":{"element_id":"page-item-answers"}}"#;
const VIEWER_PROGRAMS: &[u8] = br#"{"programs":[{"id":"fixture","host":{"account":{"setting":"OPERATOR_ACCOUNT_ID"},"audience":"audience:fixture"}}]}"#;

fn pin(path: &Path, bytes: &[u8]) -> Value {
    fs::write(path, bytes).unwrap();
    json!({
        "path": path,
        "pin": {"bytes": bytes.len(), "blake3": blake3::hash(bytes).to_hex().as_str()}
    })
}

fn tree_pin(root: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    fn walk(root: &Path, rel: &str, hash: &mut blake3::Hasher) {
        let mut entries = fs::read_dir(root.join(rel))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().into_string().unwrap();
            let relative = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let metadata = entry.metadata().unwrap();
            let mode = metadata.permissions().mode() & 0o777;
            let row = if metadata.is_dir() {
                json!([relative, "directory", mode])
            } else {
                json!([
                    relative,
                    "file",
                    mode,
                    metadata.len(),
                    blake3::hash(&fs::read(entry.path()).unwrap())
                        .to_hex()
                        .as_str()
                ])
            };
            hash.update(&serde_json::to_vec(&row).unwrap());
            hash.update(b"\n");
            if metadata.is_dir() {
                walk(root, &relative, hash);
            }
        }
    }
    let mut hash = blake3::Hasher::new();
    walk(root, "", &mut hash);
    hash.finalize().to_hex().to_string()
}

#[cfg(feature = "sql-statement-attribution")]
thread_local! {
 static CATCH_READ_TRACE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
 static CATCH_READ_METER: std::cell::RefCell<Option<trillion_local::sqlite_work::WorkMeter>> = const {std::cell::RefCell::new(None)};
}

thread_local! {
 /// The next fixture admits its sessions on a read-only owner of the account (`SelectedAccount::admission_owner`),
 /// as the native host does, instead of on the account owner itself.
 static TRANSFER_ROUTES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
 static ADMIT_APART: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
 /// The next fixture mounts the account's live socket (/work/live, `native_entry::live::LiveOwner`), as the native
 /// host does.
 static LIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

struct Fixture {
    _temp: TempDir,
    records: PathBuf,
    session_blob: PathBuf,
    app_kv: PathBuf,
    session_id: String,
    user: String,
    app: Router,
    adapter: Arc<ExecutorAdapter>,
    owner: Arc<Mutex<SelectedAccount>>,
}

impl Fixture {
    /// The account's first start: fill its own records (record store) from the original records, as the native startup task
    /// does before the app is served. A GET's write count is measured after it.
    fn first_start(&self) {
        let status = trillion_local::native_boot::own_records_start::run(
            &self.owner,
            &self.session_id,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        assert!(
            matches!(
                status,
                trillion_local::native_boot::own_records_start::Status::Ready { .. }
            ),
            "first start must fill the account's own records: {status:?}"
        );
    }

    fn new(rows: &[(&str, &str)]) -> Self {
        Self::new_with_viewer(rows, None)
    }

    fn new_with_viewer(rows: &[(&str, &str)], programs: Option<&[u8]>) -> Self {
        Self::new_with_profile(rows, programs)
    }

    fn new_with_profile(rows: &[(&str, &str)], programs: Option<&[u8]>) -> Self {
        Self::new_with_profile_owner(rows, programs, OWNER_ID)
    }

    fn new_with_profile_owner(rows: &[(&str, &str)], programs: Option<&[u8]>, owner_id: &str) -> Self {
        let transfer_routes = TRANSFER_ROUTES.with(|flag| flag.replace(false));
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let state = root.join("state");
        fs::create_dir(&state).unwrap();
        // The account's installed tools declare the record kinds these tests read and write.
        installed_tools::install(&state);
        // A name of its own: the open sign-ins of this process are found by account name.
        let user = format!(
            "{USER}-{}",
            temp.path().file_name().unwrap().to_string_lossy()
        );
        let records = state.join("records.sqlite");
        // An account with no workspace records has a RECORD_BOOK whose record store
        // families its own first start creates.
        if rows.is_empty() {
            Connection::open(&records).unwrap().close().unwrap();
        }
        for (label, value) in rows {
            assert_eq!(owner_id, OWNER_ID, "populated legacy fixtures keep their original owner");
            workspace_put(&records, label, Some(value));
        }

        let token_path = state.join("browser-session.key");
        fs::write(&token_path, TOKEN).unwrap();
        fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600)).unwrap();
        let session_id = blake3::hash(TOKEN.as_bytes()).to_hex().to_string();
        let account_policy = Connection::open(state.join("policy.sqlite")).unwrap();
        account_policy.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);").unwrap();
        for (name, value) in [
            ("revision", json!(7)),
            (
                "policy-source",
                json!({"from":"synthetic-fixture","missing":[]}),
            ),
            (
                "policy-source:account",
                json!({"lifecycle":{"browser_session_generation":3},"access":{},"plan_marks":{},"account_controls":{"client_programs":[]}}),
            ),
        ] {
            account_policy
                .execute(
                    "INSERT INTO policy_directory VALUES(?,?)",
                    rusqlite::params![name, value.to_string()],
                )
                .unwrap();
        }
        account_policy.close().unwrap();

        let gate_name = format!(
            "gate:{}",
            serde_json::to_string(&[owner_id, &format!("session:{session_id}"), "@own-records"])
                .unwrap()
        );
        let gate_path = state.join("browser-gate.sqlite");
        let gate = Connection::open(&gate_path).unwrap();
        gate.execute_batch(
            "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);",
        )
        .unwrap();
        gate.execute("INSERT INTO policy_directory VALUES('identity',?)", [json!({"owner":owner_id,"sign_in":format!("session:{session_id}"),"resource":"@own-records"}).to_string()]).unwrap();
        gate.execute("INSERT INTO policy_directory VALUES('fence','null')", [])
            .unwrap();
        gate.close().unwrap();

        let app_kv_path = state.join("current-kv.sqlite");
        let kv = Connection::open(&app_kv_path).unwrap();
        kv.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER);").unwrap();
        let blobs = state.join("storage/kv/trillion-local-app/blobs");
        fs::create_dir_all(&blobs).unwrap();
        let session_blob = blobs.join("aa");
        fs::write(
            &session_blob,
            json!({
                "userId": user,
                "created_at": CREATED,
                "browser_generation": 3,
                "method": "unknown"
            })
            .to_string(),
        )
        .unwrap();
        kv.execute(
            "INSERT INTO _mf_entries(key,blob_id,expiration) VALUES(?,?,NULL)",
            [&format!("session:{session_id}"), "aa"],
        )
        .unwrap();
        kv.close().unwrap();

        // A complete, empty selected OAuth store proves that the Home
        // browser app-marks wrapper has no registered clients. Missing OAuth
        // supply must remain an error, not an invented empty map.
        let oauth = Connection::open(state.join("oauth.sqlite")).unwrap();
        oauth.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER);").unwrap();
        oauth.close().unwrap();
        fs::create_dir_all(state.join("storage/kv/synthetic-oauth/blobs")).unwrap();

        let own_records = format!(
            "own-record-resource:{}",
            serde_json::to_string(&[owner_id, "@own-records"]).unwrap()
        );
        let index_rows = [
            json!({"binding":"ACCOUNT_CONTROL","originalId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","names":[format!("policy:{owner_id}")],"sqlite":"policy.sqlite"}),
            json!({"binding":"ACCOUNT_CONTROL","originalId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","names":[gate_name],"sqlite":"browser-gate.sqlite"}),
            json!({"binding":"RECORD_BOOK","originalId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","names":[own_records],"sqlite":"records.sqlite"}),
        ];
        let mut index = Vec::new();
        for row in &index_rows {
            index.extend(serde_json::to_vec(row).unwrap());
            index.push(b'\n');
        }
        fs::write(state.join("objects.jsonl"), &index).unwrap();
        let mut receipt = json!({
            "complete":true,
            "account":{"userId":user,"ownerId":owner_id},
            "objects":{"path":"objects.jsonl","bytes":index.len(),"fileIdentity":blake3::hash(&index).to_hex().as_str(),"count":3}
        });
        if programs.is_some() {
            // Test-only original public restore-receipt setting; the viewer
            // must read this selected source, never request fields or env vars.
            receipt["environment"] = json!({"OPERATOR_ACCOUNT_ID":user});
        }
        let receipt = serde_json::to_vec(&receipt).unwrap();
        fs::write(state.join("restore-receipt.json"), &receipt).unwrap();
        let receipt_pin = FilePin {
            bytes: receipt.len() as u64,
            blake3: blake3::hash(&receipt).to_hex().to_string(),
        };

        let reveal_path = root.join("reveal.json");
        let dom_path = root.join("dom.json");
        let settings_path = root.join("first-answers.json");
        let reveal = pin(
            &reveal_path,
            br#"{"reveal_window_minutes":10,"legacy_scrub_days":7}"#,
        );
        let dom = pin(&dom_path, DOM);
        let first_answers = pin(&settings_path, SETTINGS);
        let client_program = programs.map(|bytes| pin(&root.join("client-program.json"), bytes));
        let descriptor_path = root.join("adoption.json");
        let descriptor = json!({
            "version":"trillion.local-runtime-adoption/v1",
            "state":state,
            "receipt_identity":receipt_pin.blake3,
            "port":7189,
            "native":{
                "version":"trillion.native-selection/v1",
                "receipt_bytes":receipt_pin.bytes,
                "app_kv":{"sqlite":"current-kv.sqlite","namespace":"trillion-local-app"},

                "prior_processes":[],
                "reveal_policy":reveal,
                "root_source":null,
                "frontend":{"root":root,"manifest_identity":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","tree_identity":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","module_manifest_identity":"1111111111111111111111111111111111111111111111111111111111111111","inputs":dom,"first_answers":first_answers,"client_program":client_program}
            }
        });
        let carried = carried_selection::write_selection(&descriptor_path, &descriptor);
        let selection = Selection::from_descriptor(
            &descriptor_path,
            &carried,
            &root.join("state"),
            "127.0.0.1:7189".parse().unwrap(),
        )
        .unwrap();
        let selected_local = SelectedLocalState {
            root: selection.selected.root.clone(),
            receipt: selection.selected.receipt.clone(),
            app_kv_sqlite: selection.selected.app_kv_sqlite.clone(),
            app_kv_store: selection.selected.app_kv_store.clone(),
            prior_processes: selection.selected.prior_processes.clone(),
        };
        let account = LocalAccount::open_selected_after_handoff(selected_local).unwrap();
        #[cfg(feature = "sql-statement-attribution")]
        if CATCH_READ_TRACE.with(|flag| flag.replace(false)) {
            CATCH_READ_METER.with(|slot| {
                *slot.borrow_mut() =
                    Some(unsafe { account.enable_fixture_sql_attribution(512).unwrap() })
            });
        }
        let selected = SelectedAccount::new(account, selection).unwrap();
        let owner = Arc::new(Mutex::new(selected));
        let settings = WorkspaceSessionSettings::from_source(
            SETTINGS,
            blake3::hash(SETTINGS).to_hex().as_str(),
        )
        .unwrap();
        let sessions = WorkspaceSessions::new(owner.clone(), ORIGIN, settings).unwrap();
        let sessions = if ADMIT_APART.with(|flag| flag.replace(false)) {
            let admission = owner.lock().unwrap().admission_owner().unwrap();
            sessions.with_admission(Arc::new(Mutex::new(admission)))
        } else {
            sessions
        };
        let live = LIVE.with(|flag| flag.replace(false)).then(|| {
            let live = trillion_local::native_entry::live::LiveOwner::start(
                owner.clone(),
                sessions.clone(),
                owner_id,
            )
            .unwrap();
            Arc::new(live) as Arc<dyn workspace::WorkspaceLive>
        });
        let local = Arc::new(LocalWorkspace::new(owner.clone(), sessions.clone()).unwrap());
        let adapter = Arc::new(ExecutorAdapter {
            inner: local,
            input_override: Mutex::new(None),
            operation_override: Mutex::new(None),
            head_context: Mutex::new(None),
        });

        let routes_bytes: &[u8] = if transfer_routes { include_bytes!("../src/server/owner-routes.json") } else { OWNER_ROUTES };
        let routes =
            OwnerRoutes::from_source(routes_bytes, blake3::hash(routes_bytes).to_hex().as_str())
                .unwrap();
        let first = br#"{"paths":{},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"startup_preferences":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}}"#;
        let inputs = b"{}";
        let startup = StartupContract::from_sources(
            first,
            blake3::hash(first).to_hex().as_str(),
            inputs,
            blake3::hash(inputs).to_hex().as_str(),
        )
        .unwrap();
        let canonical = Arc::new(CanonicalWorkspace::new(
            routes,
            startup,
            adapter.clone(),
            None,
        ));

        let asset_root = root.join("assets");
        fs::create_dir_all(asset_root.join("workspace")).unwrap();
        fs::write(
            asset_root.join("workspace/entry.dat"),
            b"synthetic workspace asset",
        )
        .unwrap();
        let manifest = serde_json::to_vec(&json!({"script":"/workspace/entry.dat","stylesheet":"/workspace/entry.dat","preload":[],"screens":{},"import_map":{"imports":{}}})).unwrap();
        fs::write(asset_root.join("workspace/files.json"), &manifest).unwrap();
        let assets = Arc::new(
            WorkspaceAssets::open(
                &asset_root,
                blake3::hash(&manifest).to_hex().as_str(),
                &tree_pin(&asset_root),
            )
            .unwrap(),
        );
        let dom = WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap();
        let app = workspace::route_table(
            assets,
            WorkspaceSupplies {
                sessions: Some(Arc::new(sessions)),
                operations: Some(canonical as Arc<dyn WorkspaceOperations>),
                live,
                dom,
            },
            WorkspaceLimits::default(),
        )
        .unwrap();
        Self {
            _temp: temp,
            records,
            session_blob,
            app_kv: app_kv_path,
            session_id,
            user,
            app,
            adapter,
            owner,
        }
    }

    fn set_input(&self, input: Value) {
        *self.adapter.input_override.lock().unwrap() = Some(input);
    }
    fn clear_overrides(&self) {
        *self.adapter.input_override.lock().unwrap() = None;
        *self.adapter.operation_override.lock().unwrap() = None;
    }
    async fn get(&self, query: &str) -> (StatusCode, Vec<u8>) {
        let path = if query.is_empty() {
            "/work/api/records".to_owned()
        } else {
            format!("/work/api/records?{query}")
        };
        let response = self
            .app
            .clone()
            .oneshot(request("GET", &path, None))
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, body)
    }
}

fn request(method: &str, path: &str, body: Option<&str>) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, AUTHORITY)
        .header(header::COOKIE, format!("unrelated=1; nm_session={TOKEN}"))
        .body(body.map_or_else(Body::empty, |value| Body::from(value.to_owned())))
        .unwrap()
}

struct ExecutorAdapter {
    inner: Arc<LocalWorkspace>,
    input_override: Mutex<Option<Value>>,
    operation_override: Mutex<Option<String>>,
    head_context: Mutex<Option<DomainContext>>,
}
impl CanonicalWorkspaceExecutor for ExecutorAdapter {
    fn authorize(&self, context: DomainContext) -> workspace::SupplyFuture<BrowserScope> {
        *self.head_context.lock().unwrap() = Some(context.clone());
        self.inner.authorize(context)
    }
    fn request_key(
        &self,
        context: DomainContext,
        operation: String,
        input: Value,
    ) -> workspace::SupplyFuture<String> {
        self.inner.request_key(context, operation, input)
    }
    fn select_resource(
        &self,
        context: DomainContext,
        command: DomainCommand,
    ) -> workspace::SupplyFuture<String> {
        self.inner.select_resource(context, command)
    }
    fn execute(
        &self,
        context: DomainContext,
        mut resource: String,
        mut command: DomainCommand,
    ) -> workspace::SupplyFuture<DomainAnswer> {
        if let Some(input) = self.input_override.lock().unwrap().clone() {
            command.input = input;
        }
        if let Some(operation) = self.operation_override.lock().unwrap().clone() {
            command.operation = operation;
        }
        self.inner
            .execute(context, std::mem::take(&mut resource), command)
    }
    fn heads(&self, context: DomainContext) -> workspace::SupplyFuture<DomainAnswer> {
        self.inner.heads(context)
    }
}

#[tokio::test]
async fn route_table_reads_original_projection_and_preserves_ecmascript_json_bytes() {
    let f = Fixture::new(&[
        (
            "first",
            r#"{"second":1.00,"first":"original","lone":"\ud800","large":9007199254740993}"#,
        ),
        ("other", "false"),
    ]);
    let before = fs::read(&f.records).unwrap();
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, br#"{"records":{"first":{"second":1,"first":"original","lone":"\ud800","large":9007199254740992},"other":false}}"#);
    assert_eq!(fs::read(&f.records).unwrap(), before);
}

#[tokio::test]
async fn canonical_records_query_forwards_requested_labels_to_original_read() {
    let f = Fixture::new(&[("first", "1"), ("other", "2")]);
    let (status, body) = f.get("label=other&label=first").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"records":{"first":1,"other":2}})
    );
}

#[tokio::test]
async fn selection_distinguishes_missing_from_present_empty_and_null() {
    let f = Fixture::new(&[("a", "1"), ("b", "2")]);
    for selection in [Value::Null, json!([]), json!({})] {
        f.set_input(json!({"selection":selection}));
        let (status, body) = f.get("").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, br#"{"records":{}}"#);
    }
    f.clear_overrides();
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, br#"{"records":{"a":1,"b":2}}"#);
}

#[tokio::test]
async fn labels_prefixes_deduplicate_and_percent_is_literal() {
    let f = Fixture::new(&[
        ("plain", "true"),
        ("pane:%", "2"),
        ("pane:a", "3"),
        ("pane:_", "4"),
    ]);
    f.set_input(json!({"selection":{"labels":["plain","pane:a"],"prefixes":["pane:","pane:%"]}}));
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"records":{"plain":true,"pane:%":2,"pane:a":3,"pane:_":4}})
    );
    f.set_input(json!({"selection":{"prefixes":["pane:%"]}}));
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, br#"{"records":{"pane:%":2}}"#);
}

#[tokio::test]
async fn combined_selection_bound_applies_before_deduplication() {
    let f = Fixture::new(&[("same", "1")]);
    let labels = vec![json!("same"); 33];
    let prefixes = vec![json!("same"); 32];
    f.set_input(json!({"selection":{"labels":labels,"prefixes":prefixes}}));
    let (status, _) = f.get("").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unsupported_operations_writes_and_heads_refuse() {
    // Before the account's first start fills its own records, a write (even one
    // carried on a read request) waits for the start: 503, nothing changes. It is
    // not a refusal of the window's rights.
    let f = Fixture::new(&[("safe", "1")]);
    let before = fs::read(&f.records).unwrap();
    *f.adapter.operation_override.lock().unwrap() = Some("workspace:write".into());
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "own_records_not_migrated"
    );
    f.clear_overrides();

    let write = f
        .app
        .clone()
        .oneshot(request(
            "POST",
            "/work/api/records",
            Some(r#"{"records":[]}"#),
        ))
        .await
        .unwrap();
    // Missing Origin is refused by the canonical transport guard before any
    // operation is selected.
    assert_eq!(write.status(), StatusCode::FORBIDDEN);
    let admitted_write = || {
        let mut write = request("POST", "/work/api/records", Some(r#"{"records":[]}"#));
        write
            .headers_mut()
            .insert(header::ORIGIN, ORIGIN.parse().unwrap());
        write
    };
    let write = f.app.clone().oneshot(admitted_write()).await.unwrap();
    assert_eq!(write.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = to_bytes(write.into_body(), 65_536).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "own_records_not_migrated"
    );
    let heads = f
        .app
        .clone()
        .oneshot(request("HEAD", "/work/api/screen-revision", None))
        .await
        .unwrap();
    assert_eq!(heads.status(), StatusCode::SERVICE_UNAVAILABLE);
    let unsupported = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/unsupported", None))
        .await
        .unwrap();
    assert_eq!(unsupported.status(), StatusCode::NOT_FOUND);
    assert_eq!(before, fs::read(&f.records).unwrap());

    // Once started, the owner's live window reaches the writer itself. A write
    // carried on a read request has no write input and is refused; the empty
    // write is refused by the write's own schema (at least one record). Nothing
    // changes.
    let f = records_write_controls::started_fixture();
    let before = fs::read(&f.records).unwrap();
    *f.adapter.operation_override.lock().unwrap() = Some("workspace:write".into());
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "original_input_refused"
    );
    f.clear_overrides();
    let write = f.app.clone().oneshot(admitted_write()).await.unwrap();
    assert_eq!(write.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(write.into_body(), 65_536).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "original_input_refused"
    );
    assert_eq!(before, fs::read(&f.records).unwrap());
}

#[tokio::test]
async fn missing_browser_cookie_refuses_at_route_table_admission() {
    let f = Fixture::new(&[("private", "1")]);
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/work/api/records")
                .header(header::HOST, AUTHORITY)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn viewer_reads_same_selected_policy_and_receipt_config_without_request_grants() {
    let f = Fixture::new_with_viewer(
        &[("private", r#"{"secret":"private-record"}"#)],
        Some(VIEWER_PROGRAMS),
    );
    let before = fs::read(&f.records).unwrap();
    let response = f
        .app
        .clone()
        .oneshot(request(
            "GET",
            "/work/api/viewer?user_id=foreign&operator=true&access_refs=audience:forged&limit=not-a-number&ignored=%GG",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({
            "user_id":f.user,
            "access_refs":["audience:operator","audience:fixture"],
            "throwaway":false,
        })
    );
    assert_eq!(before, fs::read(&f.records).unwrap());
}

#[tokio::test]
async fn viewer_without_selected_program_refuses_but_records_still_read() {
    let f = Fixture::new(&[("private", "1")]);
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, br#"{"records":{"private":1}}"#);
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/viewer", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn viewer_nonempty_internal_input_refuses() {
    let f = Fixture::new_with_viewer(&[], Some(VIEWER_PROGRAMS));
    f.set_input(json!({"user_id":"foreign","access_refs":["audience:forged"]}));
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/viewer", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[path = "local_workspace/native_commands.rs"]
mod native_command_controls;

#[tokio::test]
async fn read_key_and_fixed_resource_add_no_policy_sql_and_do_not_authorize_execution() {
    let f = Fixture::new(&[("private-key-control", "true")]);
    let prepared = f
        .app
        .clone()
        .oneshot(request(
            "GET",
            "/work/api/records?label=private-key-control",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(prepared.status(), StatusCode::OK);
    let context = f.adapter.head_context.lock().unwrap().take().unwrap();
    let before = f.owner.lock().unwrap().sql_work().unwrap();
    let key = f
        .adapter
        .inner
        .request_key(context.clone(), "workspace:read".into(), json!({}))
        .await
        .unwrap();
    let command = DomainCommand {
        operation: "workspace:read".into(),
        input: json!({}),
        request_key: key,
        key_carried: false,
    };
    let resource = f
        .adapter
        .inner
        .select_resource(context.clone(), command.clone())
        .await
        .unwrap();
    assert_eq!(resource, "@own-records");
    let after = f.owner.lock().unwrap().sql_work().unwrap();
    assert_eq!(
        json!({"work":before.work,"families":before.families,"live":before.live_connections,"active":before.active_statements}),
        json!({"work":after.work,"families":after.families,"live":after.live_connections,"active":after.active_statements}),
        "random bytes and a constant address require no account SQL"
    );
    drop(prepared);
}

#[path = "local_workspace/list_storage_measurements.rs"]
mod list_storage_measurements;
