// src/native_entry/computer/hosting.rs
//
// The hosting app's engine (`trillion-local native-serve`, native_entry.rs `run_selected`) as a computer of its own one
// account: the same `Computer` a `trillion-local serve` computer runs, holding the one account the app selected, with the
// computer key the app keeps (parent_kept.rs `ParentKept::computer_key`). So the Mac app and a server can hold the same
// rows: the copies (src/account/computers/copies.rs) start here as at any computer once the account's row names voters,
// its session to the forwarder answers `places:relay` (the messages between computers, `Computer::computer_message`) and
// the account's routes, and a server named in the row joins by itself from it (join_itself.rs).
//
// Ported from old trillion (Trillion-X/trillion 7cbcbce9^), one to one where the rules allow:
// - src/record-copies.mjs:3-24: the hosted PersonStore leads and every device copy of the account follows it; a
//   device's copy settles with it from its own cursor (parts/record-log/do-work/record-sync.mjs `settleWith` :327,
//   `answerSettle` :262, `copyPositions` :230). Here the Mac app's copy is one of the account's copies: it follows the
//   writer's feed from its own stamps (`Copies` pull) and leads when it holds the writer turn.
// - computer/computer-sources.json:4 and macos/App/ComputerReader.swift:13-20: the engine keeps its own key in the
//   Keychain item the app reads; here in the blob the app keeps (`ParentKept::computer_key`).
// Dropped, and why:
// - The hosted PersonStore as the one leader (principle 3, no central shared storage): the writer turn moves between
//   the account's computers instead, by the copies' votes.
// - The settle merge rule (`byContent` :74, a losing version kept apart): with one writer at a time there is nothing to
//   merge.
// - The Mac's tool handoffs (computer/mac-tools.mjs): tool runs are the account's own here, at whichever computer answers.
//
//! The hosting app's engine as a computer of its one account (`Computer::hosting`).
//!
//! What it is: a `Computer` with one account, the one the app's engine already opened, composed from the parts the
//! engine made (`Hosting`): its owner and admission owner, its own rows (its key row, its computers rows, its copy
//! rule's rows) behind the copies' view (`rows_copy::CopiedRows`), its records store, its public origin and the forwarder its outbound session reaches. Its id is the public key of the
//! computer key the app keeps. At its first tell the account's row moves from the app's earlier device ids to this id
//! when nobody else answers (`computers::told`, through `forwarder_connection::told`), so the forwarder routes to it.
//!
//! What it runs (`Computer::keep_hosting`): the computer's own session to the forwarder (it answers `places:relay`,
//! `places:http` under `/a/<address>`, and the account's routes), its timer (the copies' steps while the account is
//! active), its report, the copy rule's sweep, and a hand-over of the writer turn when the engine stops. Not run here:
//! joining another account, installing tools (the app's start does), the command line's SIGUSR1.
//!
//! What it changes for an account whose row names no voters: nothing but the computer id the row names. Copies start
//! only once a row edit names voters (`Computer::start_copies`).
//!
//! Gaps, stated:
//! - The app's earlier outbound session (`native_boot/mcp_outbound.rs`, as its enrolled device) still opens beside this
//!   one. Once the row names this computer, the forwarder routes nothing to it.
//! - A root another writer re-keys is kept sealed to this computer's key in the state folder; the app's vault still
//!   opens with the root the app keeps (`secrets_key::give`), so a re-key while copies run is not followed here.
use super::*;

mod pending;
pub(crate) use pending::layer as pending_layer;

/// The parts of the hosting app's engine a `Computer` of its one account is made from (`Computer::hosting`).
pub(crate) struct Hosting {
    /// The account's owner and its read-only admission owner, as the engine opened them.
    pub owner: std::sync::Arc<std::sync::Mutex<crate::native_boot::SelectedAccount>>,
    pub admission: std::sync::Arc<std::sync::Mutex<crate::native_boot::SelectedAccount>>,
    /// The storage the engine's `SignIn` reads and writes the account's own rows through: the copies' view.
    pub rows_view: std::sync::Arc<crate::account::computers::rows_copy::CopiedRows>,
    /// The account's rights reader (`LocalAccount::access_reader`).
    pub access: crate::account::account_routes::AccessReader,
    pub user_id: String,
    pub owner_id: String,
    pub state_root: PathBuf,
    /// The account's records store file (`LocalAccount::records_file`).
    pub records: Option<PathBuf>,
    /// The account's public origin (its signed app configuration's service origin).
    pub public_origin: String,
    /// The forwarder the engine's sessions reach, `host:port` (the service endpoints' TLS host and port).
    pub forwarder: Option<String>,
    /// The engine's own loopback address, where the tool runs these routes start call back.
    pub loopback: Option<std::net::SocketAddr>,
    /// The computer key the app keeps (`ParentKept::computer_key`).
    pub computer_key: crate::secrets::secrets_key::ComputerKey,
}

impl Computer {
    /// The hosting app's engine as a computer of its one account (module doc): its account is composed from `parts` as a
    /// computer composes one it opened (`compose_account_with`: the copies' view of its rows, the account's routes under
    /// `/a/<address>` at its public origin), the account's row is told once (moving it to this computer's id when the
    /// app's earlier ids alone answer), and its copies start when the row names voters.
    pub(crate) fn hosting(parts: Hosting) -> Result<std::sync::Arc<Self>, ComputerError> {
        use std::sync::Arc;
        macro_rules! refused { ($detail:expr) => { ComputerError::new(Stage::Composition, $detail) }; }
        let signer = Arc::new(crate::account::computers::ComputerSigner::of(&parts.computer_key)
            .map_err(|error| ComputerError::new(Stage::ComputerKey, "the computer's signing key could not be made").with_cause(error.cause()))?);
        let vault = crate::secrets::open_home(&parts.state_root, &parts.owner_id).map_err(|error| refused!("the account's vault did not open").with_cause(error.cause()))?;
        let key = crate::account::computers::kept_account_key(&*vault).map_err(|error| refused!(error.code).with_cause(error.cause()))?;
        drop(vault);
        let address = key.address();
        let base = format!("/a/{address}");
        // The account's routes as the forwarder carries them (`places:http`), under its base at its public origin: the
        // same composition a computer makes (`compose_account_with`), over the same rows as the app's own routes.
        let storage: crate::account::rows::Shared = parts.rows_view.clone();
        let sign_in = Arc::new(crate::account::account_routes::SignIn::new(
            storage, &parts.user_id, &parts.owner_id, Some(&parts.public_origin),
        ).with_base(&base));
        sign_in.set_access(parts.access);
        sign_in.serve_as(&signer.computer_id());
        sign_in.set_account_key(key).map_err(|error| refused!("the account's key row names another key").with_cause(error.cause()))?;
        // The account's API keys are asked about as this computer, with its proof and the account's row.
        sign_in.prove_keys_as(signer.clone());
        let host = url::Url::parse(&parts.public_origin).ok()
            .and_then(|origin| Some(match origin.port() {
                Some(port) => format!("{}:{port}", origin.host_str()?),
                None => origin.host_str()?.to_owned(),
            }))
            .ok_or_else(|| refused!("the public origin names no host"))?;
        let app = crate::native_entry::door(parts.owner.clone(), parts.admission, sign_in.clone(), host, parts.loopback,
            Some(&parts.public_origin)).map_err(|error| refused!(error.code).with_cause(error.cause()))?;
        let account = Arc::new(ComputerAccount {
            owner: parts.owner,
            owner_id: parts.owner_id,
            user_id: parts.user_id.clone(),
            address: sign_in.address().to_owned(),
            state_root: parts.state_root.clone(),
            app,
            sign_in,
            rows_view: parts.rows_view,
            _registration: None,
            records: parts.records,
            copies: OnceLock::new(),
            last_used: std::sync::atomic::AtomicI64::new(i64::MIN),
            home: OnceLock::new(),
            _loopback: None,
        });
        let executor = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|_| refused!("the computer's dispatch threads could not start"))?;
        let config = ComputerConfig {
            // Not listened on: the app's engine serves its own listener.
            listen: std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
            accounts: parts.state_root.parent().map(Path::to_owned).unwrap_or_default(),
            // Not read: the key is the app's (`computer_key` here).
            computer_key_file: PathBuf::new(),
            public_origin: parts.public_origin,
            // The app's own report (its launcher's `hosting_app_report`), posted to the forwarder like any computer's,
            // never offering the Mac for a new account.
            report: crate::account::computers::ComputerReport { takes_new_accounts: false, ..crate::account::computers::this_computer().clone() },
            forwarder: parts.forwarder,
            sign_in: crate::account::rows::computer().clone(),
            new_accounts: None,
            access: serde_json::Value::Null,
            default_computers: None,
            product_settings: None,
            unit: None,
            tools_at_start: false,
            unknown_keys: Default::default(),
        };
        let computer = Arc::new(Self {
            clock: Arc::new(crate::storage::time_source::RealClock),
            config,
            signer,
            computer_key: Arc::new(parts.computer_key),
            _key_lock: None,
            accounts: std::sync::Mutex::new(vec![account.clone()]),
            executor,
            forwarder_stop: std::sync::OnceLock::new(),
            sessions: std::sync::Mutex::new(Vec::new()),
            joining: std::sync::Mutex::new(Vec::new()),
            joining_now: std::sync::Mutex::new(std::collections::HashSet::new()),
            told_rows: std::sync::Mutex::new(std::collections::HashMap::new()),
            told_origins: std::sync::Mutex::new(std::collections::HashMap::new()),
            active: std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new())),
            active_changed: Default::default(),
            timer: OnceLock::new(),
            copy_rule_sweep: OnceLock::new(),
            reporting: OnceLock::new(),
            running_sessions: std::sync::atomic::AtomicUsize::new(0),
            account_timers: std::sync::atomic::AtomicUsize::new(0),
            computer_timers: std::sync::atomic::AtomicUsize::new(0),
            timer_steps: std::sync::atomic::AtomicU64::new(0),
            release_logged: Arc::new(releases::Logged::default()),
            tools_stop: OnceLock::new(),
            release_follower: OnceLock::new(),
            skipped: std::sync::Mutex::new(Vec::new()),
            hosting: true,
        });
        // The row is told once now, as at a computer's start: it moves to this computer's id when only the app's
        // earlier ids name it, so the copies start with the row that names this computer.
        let told = computer.told(&account.address);
        crate::quiet_eprintln!("computer-start event=hosting account={} computer={} row_revision={}", account.address, computer.computer_id(),
            told.first().map_or(0, |told| told.row.revision));
        // The copies hold the root the app gave (`secrets_key::given`, `start_copies`) and send it sealed to each computer
        // the row lets answer.
        computer.start_copies(&account);
        Ok(computer)
    }

    /// Give the account the engine's browser workspace as its Home (`ComputerAccount::set_home`): a visit to the account's own
    /// address with a session opens it. `home` is the engine's workspace routes, already behind the readiness gate.
    pub(crate) fn set_home(&self, home: axum::Router) {
        for account in self.accounts.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter() {
            account.set_home(home.clone());
        }
    }

    /// Run the hosting app's computer until `stop` is set (module doc): its timer, report, copy rule sweep and its own
    /// session to the forwarder, and a hand-over of every writer turn once `stop` is set. A computer with no forwarder
    /// runs its timer only (its copies' messages then go nowhere).
    pub(crate) fn keep_hosting(self: &std::sync::Arc<Self>, stop: &'static AtomicBool) {
        let _ = self.forwarder_stop.set(stop);
        self.keep_timer(stop);
        self.keep_copy_rule_sweep(stop);
        self.keep_reporting(stop);
        self.keep_computer_session(stop);
        // Rows written into the account's rows before its copies ran (outside them, by the command line) travel now.
        for account in self.accounts() {
            self.copy_outside_changes(&account);
        }
        // Recovery is independent of the window's first reads, as in old
        // quiet-writes.ts:830. The durable count wakes the existing timer.
        for account in self.accounts() {
            if account.copies().is_some_and(|copies| copies.has_pending()) { self.wake(&account); }
        }
        self.hand_over_on_stop(stop);
    }

    /// A request reached the hosting app's own routes (its window, its local MCP): the account is active, as a request
    /// through the forwarder makes it (`wake`). Cheap when the account's row names no voters.
    pub(crate) fn hosting_request(&self) {
        if let Some(account) = self.accounts().first() {
            self.wake(account);
        }
    }

    /// After the hosting app's own routes answered: at the writer, a change of the account stores goes out as records now
    /// (`after_door`).
    pub(crate) fn hosting_answered(self: &std::sync::Arc<Self>) {
        if let Some(address) = self.accounts().first().map(|account| account.address.clone()) {
            (self.after_door(Some(&address)))(&address);
        }
    }

    /// The hosting app's account at this computer (its only one).
    pub fn hosted_account(&self) -> Option<std::sync::Arc<ComputerAccount>> {
        self.accounts().first().cloned()
    }
}

impl ComputerAccount {
    /// The account's copies at this computer, when its row names voters.
    pub fn running_copies(&self) -> Option<&std::sync::Arc<crate::account::computers::copies::Copies>> {
        self.copies()
    }
}

/// The hosting app's own routes (`router`: its window, its local MCP) with every request making the account active at
/// `computer` first (`hosting_request`: as a request through the forwarder does, `Computer::wake`) and, once answered, a
/// change of the account stores going out from the writer (`hosting_answered`). Off the request's own thread: a wake may
/// catch up first.
pub(crate) fn layer(router: axum::Router, computer: std::sync::Arc<Computer>) -> axum::Router {
    router.layer(axum::middleware::from_fn(move |request: axum::extract::Request, next: axum::middleware::Next| {
        let computer = computer.clone();
        async move {
            {
                let computer = computer.clone();
                let _ = tokio::task::spawn_blocking(move || computer.hosting_request()).await;
            }
            let response = next.run(request).await;
            let _ = tokio::task::spawn_blocking(move || computer.hosting_answered()).await;
            response
        }
    }))
}

/// The account's own rows and signing key (`SignIn`) as the hosting app's engine composes them (native_entry.rs
/// `run_selected`, and `Computer::hosting_at`): its rows opened once and read and written through the copies' view
/// (`rows_copy::CopiedRows`, which passes every row through until the account's copies run), its rights reader, handed to
/// `owner`, and its signing key from its vault when the vault opens (none leaves the account's routes without a key:
/// nothing is signed or told, and the forwarder answers this account 503). Who a request is, is the Better Auth JWT
/// (`account::signed_in`).
pub(crate) fn hosting_sign_in(
    owner: &mut crate::native_boot::SelectedAccount, account: &crate::account::AccountIdentity,
    access: crate::account::account_routes::AccessReader, origin: Option<&str>, serving: Option<&str>,
) -> Result<(std::sync::Arc<crate::account::computers::rows_copy::CopiedRows>, std::sync::Arc<crate::account::account_routes::SignIn>), crate::refusal_cause::CodedError<&'static str>> {
    let storage = crate::account::rows::open(owner.state_root())
        .map_err(|error| crate::refusal_cause::CodedError::with_cause("account rows refused", error.cause()))?;
    let view = crate::account::computers::rows_copy::CopiedRows::new(storage);
    let shared: crate::account::rows::Shared = view.clone();
    let sign_in = std::sync::Arc::new(crate::account::account_routes::SignIn::new(shared, &account.user_id, &account.owner_id, origin));
    if let Some(computer) = serving {
        sign_in.serve_as(computer);
    }
    sign_in.set_access(access);
    owner.set_sign_in(sign_in.clone());
    if let Ok(key) = crate::secrets::open_home(owner.state_root(), &account.owner_id)
        .map_err(|error| crate::refusal_cause::CodedError::with_cause("vault", error.cause()))
        .and_then(|vault| crate::account::computers::kept_account_key(&*vault))
    {
        sign_in.set_account_key(key).map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's key row names another key", error.cause()))?;
    }
    Ok((view, sign_in))
}

/// The hosting app's account opened from its state folder with no app window: its computer (`Computer::hosting`) and its
/// own local routes (MCP and the device routes at its public origin, at `local_host`), the same composition
/// `run_selected` makes after the app's launch message (`hosting_sign_in`, `door`, `Computer::hosting`). What it leaves
/// out is the app's: its launch channel, its window's page and live socket, its outbound connection as an enrolled device.
pub struct HostedHere {
    /// The engine's computer of its account.
    pub computer: std::sync::Arc<Computer>,
    /// The app's own routes (what its window and its local MCP reach), with every request waking the computer (`layer`).
    pub local: RouteTable,
    _registration: crate::account::account_routes::Registration,
}

impl Computer {
    /// Open the account in `folder` as the hosting app's engine does (`HostedHere`): `root` is the vault root the app
    /// keeps and gives at launch (`secrets_key::give`; this process then opens secrets keys no other way), `computer_key`
    /// the computer key it keeps (`ParentKept::computer_key`), `forwarder` the `host:port` its sessions reach. The
    /// account's own rows are read; nothing is written into them here.
    pub fn hosting_at(
        folder: &Path, public_origin: &str, local_host: &str, forwarder: Option<String>,
        computer_key: crate::secrets::secrets_key::ComputerKey, root: crate::secrets::SecretsKey,
    ) -> Result<HostedHere, ComputerError> {
        use crate::account::NativeAccountOwner as _;
        use crate::secrets::secrets_key::{self, SecretsKeySource};
        macro_rules! refused { ($detail:expr) => { ComputerError::new(Stage::Composition, $detail) }; }
        let _ = secrets_key::give(root);
        if secrets_key::source() != SecretsKeySource::HostingApp {
            return Err(ComputerError::new(Stage::ComputerKey, "this process already opens secrets keys another way"));
        }
        let local = open_account(folder)?;
        let account = local.account();
        let access = local.access_reader();
        let records = local.records_file();
        let chosen = crate::native_boot::Chosen::computer(selected_state(folder)?, public_origin.to_owned());
        let mut owner = crate::native_boot::SelectedAccount::chosen(local, chosen)
            .map_err(|error| refused!("the account's state is not the one its receipt names").with_cause(error.cause()))?;
        let serving = crate::account::computers::ComputerSigner::of(&computer_key).ok().map(|signer| signer.computer_id());
        let (rows_view, sign_in) = hosting_sign_in(&mut owner, &account, access.clone(), Some(public_origin), serving.as_deref()).map_err(|error| refused!(error.code).with_cause(error.cause()))?;
        let registration = crate::account::account_routes::register(&sign_in);
        // The note of its address and public origin, which the command line reads (as
        // `run_selected` writes it).
        crate::account::rows::write_door_note(folder, &account.user_id, sign_in.address(), public_origin)
            .map_err(|_| refused!("the door note could not be written"))?;
        let admission = std::sync::Arc::new(std::sync::Mutex::new(
            owner.admission_owner().map_err(|error| refused!("the account's admission owner did not open").with_cause(error.cause()))?,
        ));
        let owner = std::sync::Arc::new(std::sync::Mutex::new(owner));
        let routes = crate::native_entry::door(owner.clone(), admission.clone(), sign_in, local_host.to_owned(), None, Some(public_origin))
            .map_err(|error| refused!(error.code).with_cause(error.cause()))?;
        let computer = Self::hosting(Hosting {
            owner, admission, rows_view, access,
            user_id: account.user_id, owner_id: account.owner_id, state_root: folder.to_owned(), records,
            public_origin: public_origin.to_owned(), forwarder, loopback: None, computer_key,
        })?;
        let local = layer(pending_layer(routes, computer.clone(), local_host.to_owned()), computer.clone());
        Ok(HostedHere { computer, local, _registration: registration })
    }

    /// Run the computer of `HostedHere` until `stop` is set (`keep_hosting`), then hand its writer turns over.
    pub fn run_hosting(self: &std::sync::Arc<Self>, stop: &'static AtomicBool) {
        self.keep_hosting(stop);
    }
}

#[cfg(test)]
#[path = "../../../tests/support/installed_tools.rs"]
mod startup_installed_tools;

#[cfg(test)]
mod startup_refused_tests {
    use super::*;
    use crate::account::{self, NativeAccountOwner as _, rows::{self, store::{Family, Row, Store}}};
    use crate::secrets::secrets_key::{self, ComputerKey};
    use std::sync::{Arc, Mutex};

    /// A queued put reaches the account's vault only through the writer's own settle handler (`install_pending_writer`):
    /// the sealed put is accepted on the copies' outbox, and the writer settles it in-process when it holds the writer turn.
    #[test]
    fn a_queued_put_is_settled_by_the_writer_through_its_real_handler() {
        if !crate::native_entry::computer::own_process("native_entry::computer::hosting::startup_refused_tests::a_queued_put_is_settled_by_the_writer_through_its_real_handler") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("account");
        let computer_key = ComputerKey::from_bytes(vec![83; 32]).unwrap();
        let local = account::computers::ComputerSigner::of(&computer_key).unwrap().computer_id();
        let created = account::create::create_account(&folder, &computer_key, &rows::StartingRows::for_tests()).unwrap();
        startup_installed_tools::install(&folder);
        let root = secrets_key::open_sealed_with(&folder, &computer_key).unwrap();
        std::fs::remove_file(secrets_key::sealed_file(&folder).unwrap()).unwrap();
        secrets_key::give(root).unwrap();
        let vault = crate::secrets::open_home(&folder, &created.owner_id).unwrap();
        let account_key = account::computers::kept_account_key(&*vault).unwrap();
        drop(vault);
        // This computer is the account's only computer: the one voter, so its own timer takes the writer turn.
        let row = account::computers::ComputersRow::sign_with_voters(&created.address, 9,
            std::slice::from_ref(&local), std::slice::from_ref(&local), std::slice::from_ref(&local), &account_key).unwrap();
        let raw = rows::open(&folder).unwrap();
        let subject = account::computers::Subject::Account(created.address.clone());
        Store::new(&*raw).put(Family::Computers, &Row { id: subject.row_id(), account: created.user_id.clone(), expires_at: 0, value: row }).unwrap();
        drop(raw);
        let local_account = open_account(&folder).unwrap();
        let identity = local_account.account();
        let records = local_account.records_file();
        let access = local_account.access_reader();
        let chosen = crate::native_boot::Chosen::computer(selected_state(&folder).unwrap(), "https://computer.test".into());
        let mut selected = crate::native_boot::SelectedAccount::chosen(local_account, chosen).unwrap();
        let (rows_view, _local_sign_in) = hosting_sign_in(&mut selected, &identity, access.clone(), Some("https://computer.test"), None).unwrap();
        let admission = Arc::new(Mutex::new(selected.admission_owner().unwrap()));
        let owner = Arc::new(Mutex::new(selected));
        let computer = Computer::hosting(Hosting { owner: owner.clone(), admission: admission.clone(), rows_view, access,
            user_id: identity.user_id, owner_id: identity.owner_id.clone(), state_root: folder.clone(), records,
            public_origin: "https://computer.test".into(), forwarder: None, loopback: None, computer_key }).unwrap();
        let hosted = computer.hosted_account().unwrap();
        let copies = hosted.running_copies().unwrap();
        // A person's call to the queued put is refused at this account's own router. The person key holds every scope; the
        // sign-in still refuses it, and the settle-only guard (`settled_in_process_only`, the router's own answer) is the
        // second line for any caller that gets past the sign-in.
        let person = crate::account::signed_in::test_token(&created.owner_id);
        let person_sign_in = account::account_routes::in_memory("synthetic-queued-put", &created.owner_id);
        let router = crate::native_boot::mcp_local::route_table_with_admission(owner.clone(), admission, person_sign_in,
            "127.0.0.1:7199".to_owned()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for operation in [crate::secrets::HELD_VALUES_PUT_SEALED, crate::secrets::HELD_VALUES_REMOVE_SEALED] {
            let person_queued = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
                "name":"run_resource_operation","arguments":{"resource":"@held-values","operation":operation,
                    "request_key":"synthetic-person-queued","input":{"sealed":"AAAA"}}}});
            let request = axum::http::Request::builder().method("POST").uri("/mcp")
                .header(axum::http::header::HOST, "127.0.0.1:7199")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::ACCEPT, "application/json, text/event-stream")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {person}"))
                .body(axum::body::Body::from(serde_json::to_vec(&person_queued).unwrap())).unwrap();
            let refused = runtime.block_on(async {
                use tower::ServiceExt as _;
                let reply = router.clone().oneshot(request).await.unwrap();
                let bytes = axum::body::to_bytes(reply.into_body(), crate::mcp::request_bytes()).await.unwrap();
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
            });
            assert_eq!(refused["result"]["isError"], serde_json::json!(true),
                "a person's call to {operation} must be refused at the router: {refused}");
            assert_eq!(refused["result"]["structuredContent"]["code"], serde_json::json!("current_workspace_rights_refused"),
                "the router refuses {operation} to a person: {refused}");
        }
        // The person's own key keeps a held value by name through the same router (`held-values:put`). This copy is not the
        // writer yet, and the writer row names this computer with its term ended: the value is sealed to this computer and
        // rides the sealed queue, for its own timer to take the writer turn and settle it.
        copies.set_writer_row_for_test(&local, 0, 0);
        let kept = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
            "name":"run_resource_operation","arguments":{"resource":"@held-values","operation":"held-values:put",
                "request_key":"synthetic-held-put-by-name","input":{"name":"kept-by-name","value":"kept-value-by-name"}}}});
        let kept_request = axum::http::Request::builder().method("POST").uri("/mcp")
            .header(axum::http::header::HOST, "127.0.0.1:7199")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .header(axum::http::header::ACCEPT, "application/json, text/event-stream")
            .header(axum::http::header::AUTHORIZATION, format!("Bearer {person}"))
            .body(axum::body::Body::from(serde_json::to_vec(&kept).unwrap())).unwrap();
        let kept_answer = runtime.block_on(async {
            use tower::ServiceExt as _;
            let reply = router.clone().oneshot(kept_request).await.unwrap();
            let bytes = axum::body::to_bytes(reply.into_body(), crate::mcp::request_bytes()).await.unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        });
        assert_eq!(kept_answer["result"]["structuredContent"], serde_json::json!({"accepted": true}),
            "the person's held-values:put is accepted at a copy that is not the writer: {kept_answer}");
        assert!(!kept_answer.to_string().contains("kept-value-by-name"), "the answer never carries the value");
        assert!(copies.holding().is_none(), "a copy that has not claimed holds no writer turn yet");
        // A write asks the timer for the writer turn (`claim_for_write`); the timer takes it as the only voter.
        assert!(copies.prepare_write_turn().is_err(), "the first write is refused until the timer claims");
        copies.tick();
        assert!(copies.is_writer(), "the only voter holds the writer turn after its timer step");
        assert_eq!(copies.settle_pending(), 1, "the writer settles the person's queued put by name");
        assert_eq!(*crate::secrets::open_home(&folder, &created.owner_id).unwrap().plain("kept-by-name").unwrap(), "kept-value-by-name",
            "the value a person kept by name is in the account's vault after the writer settles it");
        // The writer's person removes a held value by name through the same router (`held-values:remove`): the answer names the
        // name and what happened, a second removal finds none, and a connection's name is refused like a put's.
        let remove_by_name = |request_key: &str, name: &str| {
            let call = serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
                "name":"run_resource_operation","arguments":{"resource":"@held-values","operation":"held-values:remove",
                    "request_key":request_key,"input":{"name":name}}}});
            let request = axum::http::Request::builder().method("POST").uri("/mcp")
                .header(axum::http::header::HOST, "127.0.0.1:7199")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::ACCEPT, "application/json, text/event-stream")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {person}"))
                .body(axum::body::Body::from(serde_json::to_vec(&call).unwrap())).unwrap();
            runtime.block_on(async {
                use tower::ServiceExt as _;
                let reply = router.clone().oneshot(request).await.unwrap();
                let bytes = axum::body::to_bytes(reply.into_body(), crate::mcp::request_bytes()).await.unwrap();
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
            })
        };
        let removed_by_name = remove_by_name("synthetic-held-remove-by-name", "kept-by-name");
        assert_eq!(removed_by_name["result"]["structuredContent"], serde_json::json!({"name": "kept-by-name", "removed": true}),
            "the writer removes the value a person kept by name: {removed_by_name}");
        assert!(!crate::secrets::open_home(&folder, &created.owner_id).unwrap().holds("kept-by-name").unwrap(),
            "the removed name is no longer held in the account's vault");
        let removed_again = remove_by_name("synthetic-held-remove-by-name-again", "kept-by-name");
        assert_eq!(removed_again["result"]["structuredContent"], serde_json::json!({"name": "kept-by-name", "removed": false}),
            "a name that is no longer held answers removed false: {removed_again}");
        let connection = remove_by_name("synthetic-held-remove-connection", "service-connection-6162");
        assert_eq!(connection["result"]["isError"], serde_json::json!(true), "a connection's name is refused: {connection}");
        assert_eq!(connection["result"]["structuredContent"]["code"], serde_json::json!("original_input_refused"),
            "a connection's name is refused as a put's is: {connection}");
        let name = "queued-held-value";
        let sealed = crate::secrets::seal_put_to_writer(name, zeroize::Zeroizing::new("held-from-a-copy".to_owned()),
            crate::secrets::HeldAs::Plain, &local).unwrap();
        let submission = copies.queue_sealed(crate::secrets::HELD_VALUES_PUT_SEALED, sealed).unwrap();
        assert_eq!(copies.settle_pending(), 1, "the writer settles the queued put once");
        let terminal = copies.pending_result(&submission.id).unwrap().expect("the settled put has a terminal answer");
        assert_eq!(terminal.body, serde_json::json!({"held": true}), "the writer's handler answers the put as held");
        let vault = crate::secrets::open_home(&folder, &created.owner_id).unwrap();
        assert_eq!(*vault.plain(name).unwrap(), "held-from-a-copy", "the settled put is in the account's vault");
        // A queued removal settles at the writer the same way, and the name is no longer held.
        let sealed_remove = crate::secrets::seal_remove_to_writer(name, &local).unwrap();
        let removal = copies.queue_sealed(crate::secrets::HELD_VALUES_REMOVE_SEALED, sealed_remove).unwrap();
        assert_eq!(copies.settle_pending(), 1, "the writer settles the queued removal once");
        let removed = copies.pending_result(&removal.id).unwrap().expect("the settled removal has a terminal answer");
        assert_eq!(removed.body, serde_json::json!({"removed": true}), "the writer's handler answers the removal as removed");
        let vault = crate::secrets::open_home(&folder, &created.owner_id).unwrap();
        assert!(!vault.holds(name).unwrap(), "the settled removal leaves the name unheld in the account's vault");
    }

    /// A queued command whose request names another operation than the command's own (the handler cannot answer it as sent) is
    /// refused under its own key, and the sealed put queued behind it still settles: one such head does not block the account.
    #[test]
    fn a_mismatched_head_is_refused_and_does_not_block_the_queued_put_behind_it() {
        if !crate::native_entry::computer::own_process("native_entry::computer::hosting::startup_refused_tests::a_mismatched_head_is_refused_and_does_not_block_the_queued_put_behind_it") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("account");
        let computer_key = ComputerKey::from_bytes(vec![83; 32]).unwrap();
        let local = account::computers::ComputerSigner::of(&computer_key).unwrap().computer_id();
        let created = account::create::create_account(&folder, &computer_key, &rows::StartingRows::for_tests()).unwrap();
        startup_installed_tools::install(&folder);
        let root = secrets_key::open_sealed_with(&folder, &computer_key).unwrap();
        std::fs::remove_file(secrets_key::sealed_file(&folder).unwrap()).unwrap();
        secrets_key::give(root).unwrap();
        let vault = crate::secrets::open_home(&folder, &created.owner_id).unwrap();
        let account_key = account::computers::kept_account_key(&*vault).unwrap();
        drop(vault);
        // This computer is the account's only computer: the one voter, so its own timer takes the writer turn.
        let row = account::computers::ComputersRow::sign_with_voters(&created.address, 9,
            std::slice::from_ref(&local), std::slice::from_ref(&local), std::slice::from_ref(&local), &account_key).unwrap();
        let raw = rows::open(&folder).unwrap();
        let subject = account::computers::Subject::Account(created.address.clone());
        Store::new(&*raw).put(Family::Computers, &Row { id: subject.row_id(), account: created.user_id.clone(), expires_at: 0, value: row }).unwrap();
        drop(raw);
        let local_account = open_account(&folder).unwrap();
        let identity = local_account.account();
        let records = local_account.records_file();
        let access = local_account.access_reader();
        let chosen = crate::native_boot::Chosen::computer(selected_state(&folder).unwrap(), "https://computer.test".into());
        let mut selected = crate::native_boot::SelectedAccount::chosen(local_account, chosen).unwrap();
        let (rows_view, _local_sign_in) = hosting_sign_in(&mut selected, &identity, access.clone(), Some("https://computer.test"), None).unwrap();
        let admission = Arc::new(Mutex::new(selected.admission_owner().unwrap()));
        let owner = Arc::new(Mutex::new(selected));
        let computer = Computer::hosting(Hosting { owner: owner.clone(), admission: admission.clone(), rows_view, access,
            user_id: identity.user_id, owner_id: identity.owner_id.clone(), state_root: folder.clone(), records,
            public_origin: "https://computer.test".into(), forwarder: None, loopback: None, computer_key }).unwrap();
        let hosted = computer.hosted_account().unwrap();
        let copies = hosted.running_copies().unwrap();
        copies.tick();
        assert!(copies.is_writer(), "the only voter holds the writer turn after its timer step");
        let resource = crate::secrets::resource().unwrap();
        let head_key = "synthetic-mismatched-head";
        let head = crate::account::computers::copies::pending::Command {
            owner: created.owner_id.clone(), sign_in: created.user_id.clone(), resource: resource.to_owned(),
            operation: crate::secrets::HELD_VALUES_PUT_SEALED.to_owned(), request_key: head_key.to_owned(),
            input: serde_json::json!({"sealed": "AAAA"}), scope: None, source_generation: copies.stamp(resource),
            request: serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "run_resource_operation",
                "arguments": {"address": resource, "method": "held-values:some-other-operation", "request_key": head_key, "input": {"sealed": "AAAA"}}}}),
            bearer: format!("{}synthetic", crate::account::computers::COMMAND_PROOF_PREFIX), accepted_at_ms: crate::account::rows::now_ms() as i64,
            person_present: None, checked_kinds: vec![], projection: vec![],
        };
        let head_queued = copies.queue_pending(head).unwrap();
        let sealed = crate::secrets::seal_put_to_writer("queued-behind-head", zeroize::Zeroizing::new("held-behind-head".to_owned()),
            crate::secrets::HeldAs::Plain, &local).unwrap();
        let behind = copies.queue_sealed(crate::secrets::HELD_VALUES_PUT_SEALED, sealed).unwrap();
        assert_eq!(copies.settle_pending(), 2, "the mismatched head completes as refused, then the put behind it settles");
        let refused = copies.pending_result(&head_queued.id).unwrap().expect("the head has a terminal answer");
        assert!(refused.refused, "the mismatched head is refused under its own key: {refused:?}");
        let settled = copies.pending_result(&behind.id).unwrap().expect("the put behind the head has a terminal answer");
        assert_eq!(settled.body, serde_json::json!({"held": true}), "the put behind the head settles at the writer");
        let vault = crate::secrets::open_home(&folder, &created.owner_id).unwrap();
        assert_eq!(*vault.plain("queued-behind-head").unwrap(), "held-behind-head", "the settled put is in the account's vault");
    }
}
